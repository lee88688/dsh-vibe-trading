# 行情数据源（data sources）

> 说明插件的 K 线/行情从哪里来、哪些环节容易失败，以及可选的用户侧配置。对应 `vibe-trading-ai 0.1.19`；
> 具体源的可用性随网络环境变化，本文只描述机制与通用排查方法。
> 可复跑探针：`scripts/dev/probe-market-data.py`、`scripts/dev/verify-data-env.py`、`scripts/dev/smoke-vt-network-tools.py`。

## 1. 数据流

Vibe-Trading **没有随包的历史行情库**：每次 `get_market_data` 都实时抓取，本地缓存是可选且默认关闭的。

```
get_market_data(codes, start, end, source, interval, max_rows)
  └─ worker/vibe_trading_worker.py（JSON-RPC → 已安装的 vibe-trading-ai）
       └─ src/tools/market_data_tool.py      参数校验 / interval 规范化
            └─ src/market_data.py:fetch_market_data_json
                 ├─ _detect_market(code)       按后缀判市场（.US/.SH/.SZ/.HK/.TO/.L/-USDT/^…/=F/=X）
                 ├─ detect_source(code)        auto 模式下每市场首选源
                 ├─ FALLBACK_CHAINS[market]    逐源尝试（最多 max_fallback_attempts=5 次）
                 │    └─ backtest/loaders/*.py 28 个 loader：yfinance/yahoo/tencent/eastmoney/
                 │       sina/baostock/akshare/tushare/okx/binance/ccxt/stooq/futu/mt5/local…
                 ├─ resample_bars(1W/1M)       周/月线由日线客户端聚合（不是源原生）
                 └─ cap_rows(max_rows)         行数上限（默认 250，等步长抽样）
```

`backtest` 引擎复用同一 loader 层（进程内 DataFrame），**不经过**行数上限与 10k 字符上限。

## 2. 市场与回退链

| 市场 | auto 首选源 | 回退链（`registry.FALLBACK_CHAINS`） |
|---|---|---|
| `us_equity` | yahoo（`*.US`） | yahoo → stooq → sina → eastmoney → yfinance → tiingo/fmp/finnhub/alphavantage → longbridge → akshare → local |
| `a_share` | tencent（6 位代码） | tencent → eastmoney → baostock → akshare → tushare → local |
| `hk_equity` | tencent（`*.HK`） | tencent → eastmoney → yahoo → futu → akshare → yfinance → tushare → longbridge → local |
| `crypto` | okx（`*-USDT`） | okx → binance → ccxt → yfinance → local |
| `index` | yahoo（`^…`） | yahoo → yfinance → local |
| `ca/uk/br/ar/in/kr/vn_equity` | yahoo | yahoo → yfinance（+ br 的 b3_cotahist）→ local |
| `forex` | mt5 | mt5 → akshare → yfinance → local |
| `futures` | akshare | akshare → local |

关键事实：

- **key/终端类源默认不可用**：tushare/finnhub/alphavantage/tiingo/fmp/gildata/longbridge 需 key；
  futu/mt5/india_broker/tickerall 需本地终端或账户；baostock/mootdx/pykrx 是可选包；`local` 需
  `~/.vibe-trading/data-bridge/config.yaml`。
- **`source=` 不等于真实数据源**：不可用 loader 会被静默替换成同市场第一个可用 loader，随后再沿链回退；
  真实出数源看 `_provenance.source`，回退发生过则有 `fallback_used=true / requested_source / detected_source`。
- **缓存可选**：`VIBE_TRADING_DATA_CACHE=1` 才开，介质是 parquet，只缓存 `end_date < 今天` 的已结算区间；
  插件 worker 把缓存根重定向到 `<VIBE_TRADING_HOME>/dsh/work/cache`。

## 3. 常见失败原因

按出现频率排序：

1. **网络阻断**：Yahoo/Stooq/Binance/OKX 等海外源在部分网络下 TLS 重置或 DNS 失败；结果是回退链变短或全部失败。
2. **IP 级限流（不是 429）**：免费源（腾讯、东财）按 IP 反爬，表现为 `HTTP 501` + JS 挑战页（腾讯）
   或 `RemoteDisconnected`（东财），接口层只表现为 `no_data`。密集取数（多标的回测准备）可能触发，
   冷却时间从几分钟到几十分钟不等，**重试会延长封禁**。
3. **`search_symbol` 对带后缀代码恒 0 候选**：`600519.SH`、`AAPL.US`、`BTC-USDT` 这类输入不命中；
   用裸代码/中文名先锁定，再取行情。加密对还会被 identity 门禁拦（锁不住标的）。
4. **10k 字符截断**：长区间结果在 JSON 中间被切断并落盘，模型应读 `full_path` 或改用更短区间/月线；
   `truncated` / `policy` 字段说明截断方式。
5. **默认 `max_rows=250` 是等步长抽样**：请求 2000+ 根会返回约 240 根 `policy="every-9th-row"`，
   `shift(1)` 实际是 9 个交易日前；量化场景应显式 `max_rows=0` 或走 `backtest`。
6. **复权口径**：auto 实际落到 `sina`/`tencent` 时美股/港股可能是不复权价；A 股源侧 qfq 是加法平移，
   服务给 agent 的却是客户端转成的乘性；复权还会污染成交量单位（`volume_unit` 不可全信）。
7. **intraday 缺失**：可用源基本只提供日线；1m/5m/15m/30m/1H/4H 多数不可用。
8. **crypto 时间戳错位**：OKX 日线 `trade_date="T16:00:00"`（UTC 日界），不能与股票日线直接 join。
9. **错误语义误导**：源失败/限流常被吞成 `no_data`，报错文案提示"检查符号后缀或换日期"，掩盖真实原因。

## 4. 用户侧可选配置

都写在 `~/.vibe-trading/.env`（插件 worker 每次 spawn 时读取；改完需等新 worker 进程生效）。

| 目的 | 配置 |
|---|---|
| 走本地/公司代理访问海外源 | `HTTPS_PROXY` / `HTTP_PROXY`；国内行情域用 `NO_PROXY` 排除 |
| A 股多一个独立源 | 往运行时 venv 装 `baostock`：`<venv>/Scripts/python -m pip install baostock` |
| 可复现 / 降限流 | `VIBE_TRADING_DATA_CACHE=1` |
| 调整回退顺序 | `MARKET_DATA_ORDER_<MARKET>`（如 `MARKET_DATA_ORDER_A_SHARE`） |
| 放慢请求 | `VIBE_TRADING_EASTMONEY_MIN_INTERVAL` / `..._YAHOO_MIN_INTERVAL` / `..._SINA_MIN_INTERVAL` |
| 自带数据 | `data-bridge` 的 `local` loader（CSV/Parquet/DuckDB），配置见 `backtest/loaders/local_loader.py` 顶部 |

注意：

- 代理只对 **python worker** 生效（DSH 原生 `web_search`/`web_fetch`/`pwsh` 不受影响）。
- 代理解决"取数"，**不解决** identity 锁定问题：`search_symbol` 仍要传裸代码/中文名。
- 共享代理 IP 上 Yahoo 可能偶发 429，重试即可；Yahoo 盘中会返回当天未收盘的 bar，回测要丢弃 `date == 今天`。
- 量化正解是自带数据（`local` loader + `backtest`），可绕开网络、限流、10k 和复权口径问题。

## 5. 排查顺序

```powershell
# 1) 网络可达性 + auto 覆盖（每个源独立请求，失败源要等超时）
& $py scripts/dev/probe-market-data.py --network-only
& $py scripts/dev/probe-market-data.py

# 2) 验证 .env 配置是否真的进了 worker（K 线 + 缓存）
& $py scripts/dev/verify-data-env.py

# 3) 其余联网工具（新闻/财报/研报/订单簿…）是否被代理影响
& $py scripts/dev/smoke-vt-network-tools.py
```

`$py` 用运行时 venv 的解释器（`~/.vibe-trading/dsh/venv/Scripts/python.exe`，POSIX 为 `bin/python`）。
