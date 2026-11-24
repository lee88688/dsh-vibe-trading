/**
 * dsh-vibe-trading — Client half.
 *
 * Two additions, both read-only over the host projection `vibeTrading`:
 *
 * 1. A compact "Vibe Trading" indicator in the composer tool row, right after
 *    the permission control (off — secondary label; on — success-green glyph).
 *    On phone-width viewports it collapses to the glyph alone, so the composer
 *    row keeps its space; the tooltip/aria-label still name the plugin.
 * 2. A per-turn footer (`conversation.chat.turnTail`) that appears only when the
 *    number gate left figures unverified for that turn. It does not modify the
 *    assistant message, so the recorded text and prefix cache stay untouched;
 *    the original answer remains visible above it for review.
 *
 * Projection values are folded from the durable session log, so both follow
 * Session switching and page reloads.
 *
 * Visual contract copied from the host's composer controls
 * (`PermissionSelect.module.css` trigger): inline-flex, height 28px, 13px/500
 * label, `--dsw-radius-sm` corners, and a 14px currentColor glyph. The styles
 * live in one injected stylesheet (rather than inline styles) because the
 * responsive rule has to win over the base rule.
 */

window.__ModuleLoader__.load({
  id: '@monsterlee/dsh-vibe-trading',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PROJECTION_KEY = 'vibeTrading'
    /** Loader entry id of this plugin's row (also the host settings namespace). */
    const CONFIG_ENTRY_ID = 'dsh-vibe-trading'

    const STATUS_STYLE_ID = 'dsh-vibe-trading/status.css'

    /**
     * Chip styles, kept in one stylesheet so a viewport media query can take the
     * label away without fighting inline styles. `dvt-` classes are plugin-owned.
     * 560px is the width the host's composer row itself treats as narrow.
     */
    const STATUS_CSS = `
      .dvt-status {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 28px;
        padding: 0 8px;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
        white-space: nowrap;
        flex: none;
        cursor: default;
        user-select: none;
      }
      .dvt-status[data-active='true'] {
        color: var(--dsw-alias-label-primary);
      }
      .dvt-status__glyph {
        flex: none;
        display: inline-flex;
        color: currentColor;
        opacity: 0.72;
      }
      .dvt-status[data-active='true'] .dvt-status__glyph {
        color: var(--dsw-alias-state-success-primary);
        opacity: 1;
      }
      /* Phone-width composer rows: only the glyph is shown (green = enabled); the
         tooltip and aria-label keep the full name and state available. */
      @media (max-width: 560px) {
        .dvt-status {
          padding: 0 6px;
        }
        .dvt-status__label {
          display: none;
        }
      }

      /* Answer-gate footer: a real table on wide panels, stacked rows on narrow
         ones. The container query keys off the panel itself, so a narrow chat
         column stacks even when the viewport is wide. */
      .dvt-gate {
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-top: 6px;
        font-size: 12px;
        font-weight: 500;
        line-height: 18px;
        color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary));
      }
      .dvt-gate__head {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dvt-gate__head-icon {
        display: inline-flex;
        flex: none;
      }
      .dvt-gate__group {
        margin-top: 2px;
      }
      .dvt-gate__group > summary {
        cursor: pointer;
      }
      .dvt-gate__body {
        margin: 2px 0 0 18px;
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary, inherit);
      }
      .dvt-gate__scroll {
        max-width: 100%;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
      }
      .dvt-gate__empty {
        opacity: 0.8;
      }
      .dvt-gate__table {
        width: 100%;
        table-layout: fixed;
        border-collapse: collapse;
        font-size: 11.5px;
        line-height: 17px;
      }
      .dvt-gate__table th {
        width: auto;
        padding: 0 8px 3px 0;
        text-align: left;
        font-weight: 500;
        font-size: 11px;
        color: var(--dsw-alias-label-secondary);
        opacity: 0.8;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.22));
      }
      .dvt-gate__table th:first-child {
        width: 6.5em;
      }
      .dvt-gate__table th:last-child {
        width: 7.5em;
      }
      .dvt-gate__table td {
        padding: 3px 8px 3px 0;
        vertical-align: top;
      }
      .dvt-gate__table th:last-child,
      .dvt-gate__table td:last-child {
        padding-right: 0;
      }
      .dvt-gate__value {
        font-weight: 600;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .dvt-gate__context {
        overflow-wrap: anywhere;
      }
      .dvt-gate__reason {
        font-size: 11px;
        opacity: 0.82;
        overflow-wrap: anywhere;
      }
      .dvt-gate__chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 6px;
      }
      .dvt-gate__chip {
        display: inline-block;
        padding: 0 6px;
        border-radius: 4px;
        background: rgba(128, 128, 128, 0.14);
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
      @container (max-width: 520px) {
        .dvt-gate__table {
          width: max-content;
          min-width: 100%;
          table-layout: auto;
        }
        .dvt-gate__table th,
        .dvt-gate__table td {
          width: auto;
          white-space: nowrap;
        }
        .dvt-gate__table th:first-child,
        .dvt-gate__table th:last-child {
          width: auto;
        }
      }
      @media (max-width: 640px) {
        /* Same one-row horizontal-overflow behavior for browsers without container queries. */
        .dvt-gate__table {
          width: max-content;
          min-width: 100%;
          table-layout: auto;
        }
        .dvt-gate__table th,
        .dvt-gate__table td {
          width: auto;
          white-space: nowrap;
        }
        .dvt-gate__table th:first-child,
        .dvt-gate__table th:last-child {
          width: auto;
        }
      }
    `

    /** Append the chip stylesheet once; repeated applies (HMR, remount) update in place. */
    function ensureStatusStyles(doc) {
      if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return
      const selector = `style[data-plugin-css="${STATUS_STYLE_ID}"]`
      const existing = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null
      if (existing !== null && existing !== undefined) {
        existing.textContent = STATUS_CSS
        return
      }
      const style = doc.createElement('style')
      style.dataset.plugin = 'dsh-vibe-trading'
      style.dataset.pluginCss = STATUS_STYLE_ID
      style.textContent = STATUS_CSS
      doc.head.appendChild(style)
    }

    /* --------------------------------------------------------------------- */
    /* Plugin-page settings form                                              */
    /* --------------------------------------------------------------------- */

    /**
     * Stylesheet for the profile settings page.
     *
     * Kept apart from the composer chip sheet: the page renders inside the
     * plugin manager panel, where the host's own form spacing already applies.
     */
    const SETTINGS_STYLE_ID = 'dsh-vibe-trading/settings.css'

    const SETTINGS_CSS = `
      .dvt-config {
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-size: 13px;
        line-height: 20px;
      }
      .dvt-config__intro {
        color: var(--dsw-alias-label-secondary);
      }
      .dvt-config__group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
        border-radius: var(--dsw-radius-md, 8px);
      }
      .dvt-config__title {
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
      }
      .dvt-config__row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 28px;
      }
      .dvt-config__text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .dvt-config__hint {
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        font-size: 12px;
        line-height: 18px;
      }
      .dvt-config__control {
        flex: none;
      }
      .dvt-config__control--number {
        width: 96px;
        padding: 2px 6px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        text-align: right;
      }
      .dvt-config__control--select {
        padding: 2px 6px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
      }
      .dvt-config__status {
        min-height: 20px;
        color: var(--dsw-alias-label-secondary);
      }
      .dvt-config__status[data-tone='ok'] {
        color: var(--dsw-alias-state-success-primary);
      }
      .dvt-config__status[data-tone='error'] {
        color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
      }
    `

    /** Append the settings stylesheet once; repeated applies update it in place. */
    function ensureSettingsStyles(doc) {
      if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return
      const selector = `style[data-plugin-css="${SETTINGS_STYLE_ID}"]`
      const existing = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null
      if (existing !== null && existing !== undefined) {
        existing.textContent = SETTINGS_CSS
        return
      }
      const style = doc.createElement('style')
      style.dataset.plugin = 'dsh-vibe-trading'
      style.dataset.pluginCss = SETTINGS_STYLE_ID
      style.textContent = SETTINGS_CSS
      doc.head.appendChild(style)
    }

    function Bars() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3.5 12.5V8.5' }),
        h('path', { d: 'M8 12.5V4' }),
        h('path', { d: 'M12.5 12.5V6.5' }),
      )
    }

    function WarningTriangle() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M8 2.5 14.5 13.5H1.5L8 2.5Z' }),
        h('path', { d: 'M8 6.5v3' }),
        h('path', { d: 'M8 11.5v.01' }),
      )
    }

    /** Human labels for the gate's machine reason codes; the raw code stays in the cell title. */
    const REASON_LABELS = {
      numeric_claim_unavailable: '无可用证据',
      figure_undeclared: '未声明依据',
      value_mismatch: '数值不符',
      derivation_result_mismatch: '推导结果不符',
      identity_mismatch: '身份/口径不符',
      symbol_mismatch: '标的代码不符',
    }

    function reasonLabel(code) {
      const raw = String(code || 'unverified')
      return REASON_LABELS[raw] || raw
    }

    /**
     * Unverified figures as a real table on wide panels. The stylesheet turns the
     * same rows into stacked blocks through a container query (with a viewport
     * media-query fallback), so narrow chat columns never squeeze the columns.
     */
    function GateTable(props) {
      return h(
        'div',
        {
          className: 'dvt-gate__scroll',
          role: 'region',
          tabIndex: 0,
          'aria-label': '未核实数字明细，可横向滚动',
        },
        h(
          'table',
          { className: 'dvt-gate__table' },
        h(
          'thead',
          null,
          h('tr', null, h('th', null, '数字'), h('th', null, '上下文'), h('th', null, '原因')),
        ),
          h(
            'tbody',
            null,
            props.details.map((detail, index) =>
              h(
                'tr',
                { key: `d${index}` },
                h('td', { className: 'dvt-gate__value' }, String(detail.value)),
                h('td', { className: 'dvt-gate__context' }, detail.context || '（无上下文）'),
                h('td', { className: 'dvt-gate__reason', title: String(detail.reason || 'unverified') }, reasonLabel(detail.reason)),
              ),
            ),
          ),
        ),
      )
    }

    /** Per-turn gate panel: unverified (open), passed and auto-exempted (folded). */
    function GateFooter(props) {
      const useProjection = props === undefined ? undefined : props.useProjection
      const state = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      // turnTail owner prop is a TurnLocation ({turn: number, ...}), not a number.
      const location = props === undefined ? undefined : props.turn
      const turn = typeof location === 'number' ? location : location && typeof location.turn === 'number' ? location.turn : undefined
      const gate = state && state.gate && turn !== undefined ? state.gate[String(turn)] : undefined
      const count = gate && Number(gate.unverified) > 0 ? Number(gate.unverified) : 0
      if (!count) return null
      const details = Array.isArray(gate.details) ? gate.details : []
      const passed = Number(gate.passed || 0)
      const passedValues = Array.isArray(gate.passedValues) ? gate.passedValues : []
      const suppressed = Number(gate.suppressed || 0)
      const rules = Array.isArray(gate.suppressedRules) ? gate.suppressedRules : []
      return h(
        'div',
        {
          className: 'dvt-gate',
          role: 'note',
          title: '数字核实门禁：展开可核对本轮未通过核实、已核实与自动豁免的数字；原文保持原样，未做任何遮蔽。',
        },
        h(
          'div',
          { className: 'dvt-gate__head' },
          h('span', { className: 'dvt-gate__head-icon' }, h(WarningTriangle)),
          h('span', null, `本轮有 ${count} 处数字未通过核实`),
        ),
        h(
          'details',
          { className: 'dvt-gate__group dvt-gate__group--warn', open: true },
          h('summary', null, `未核实 / 未汇报（${count}）`),
          h(
            'div',
            { className: 'dvt-gate__body' },
            details.length
              ? h(GateTable, { details })
              : h('div', { className: 'dvt-gate__empty' }, '（明细未随本次披露保留，请查看本条披露消息）'),
          ),
        ),
        h(
          'details',
          { className: 'dvt-gate__group' },
          h('summary', null, `已汇报且通过（${passed}）`),
          h(
            'div',
            { className: 'dvt-gate__body' },
            passedValues.length
              ? h(
                  'div',
                  { className: 'dvt-gate__chips' },
                  passedValues.map((value, index) =>
                    h('span', { key: `p${index}`, className: 'dvt-gate__chip' }, String(value)),
                  ),
                )
              : h('div', { className: 'dvt-gate__empty' }, '（未保留明细）'),
          ),
        ),
        h(
          'details',
          { className: 'dvt-gate__group' },
          h('summary', null, `自动豁免（${suppressed}，无需 report）`),
          h(
            'div',
            { className: 'dvt-gate__body' },
            rules.length
              ? h(
                  'div',
                  { className: 'dvt-gate__chips' },
                  rules.map((entry, index) =>
                    h(
                      'span',
                      { key: `r${index}`, className: 'dvt-gate__chip' },
                      `${entry.rule} × ${entry.count}`,
                    ),
                  ),
                )
              : h('div', { className: 'dvt-gate__empty' }, '（版本号/URL/日期等非金融数字）'),
          ),
        ),
      )
    }

    function VibeTradingChip(props) {
      const useProjection = props === undefined ? undefined : props.useProjection
      const state = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      const active = state !== undefined && state !== null && state.requested === 'on'
      return h(
        'div',
        {
          className: 'dvt-status',
          'data-active': active ? 'true' : 'false',
          role: 'img',
          'aria-label': active ? 'Vibe Trading 已启用' : 'Vibe Trading 未启用',
          title: active
            ? 'Vibe Trading 已在本会话启用'
            : 'Vibe Trading 未启用：执行 /vibe-trading on 激活当前会话',
        },
        h('span', { className: 'dvt-status__glyph', 'aria-hidden': true }, h(Bars)),
        h('span', { className: 'dvt-status__label' }, 'Vibe Trading'),
      )
    }

    /**
     * Build the plugin-page settings form for this row.
     *
     * `configForms.get(entryId)` is the browser mirror of the Host settings
     * document for the `dsh-vibe-trading` Loader entry: `snapshot.value` is the
     * validated row config, `mutate` writes one atomic operation list, and the
     * Host persists it into the current profile's `cordis.patch.yml`. Every
     * field is volatile, so a saved value reaches running sessions without a
     * remount (and `/vibe-trading config set` writes the same fields through the
     * same service).
     *
     * @param configForms - browser `configForms` service.
     * @returns React component rendered on this bundle's plugin page.
     */
    function createSettingsPage(configForms) {
      const form = configForms.get(CONFIG_ENTRY_ID)
      const readPath = (value, path) =>
        path.reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), value)
      return function VibeTradingSettingsPage() {
        const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
        const [pending, setPending] = React.useState(null)
        const [tone, setTone] = React.useState(null)
        React.useEffect(() => {
          let mounted = true
          const sync = () => {
            if (mounted) setSnapshot(form.getSnapshot())
          }
          sync()
          const dispose = typeof form.subscribe === 'function' ? form.subscribe(sync) : undefined
          return () => {
            mounted = false
            if (typeof dispose === 'function') dispose()
          }
        }, [])
        const value = snapshot && snapshot.value ? snapshot.value : {}
        const ready = snapshot !== undefined && snapshot !== null && snapshot.status === 'ready'
        const writable = ready && snapshot.writable !== false
        const write = (path, nextValue) => {
          const key = path.join('.')
          setPending(key)
          setTone(null)
          Promise.resolve(form.mutate([{ op: 'set', path, value: nextValue }]))
            .then((ok) => {
              setPending(null)
              setTone(ok === false ? 'error' : 'ok')
              if (ok === false) setSnapshot(form.getSnapshot())
            })
            .catch(() => {
              setPending(null)
              setTone('error')
              setSnapshot(form.getSnapshot())
            })
        }
        const row = (key, label, hint, control) =>
          h(
            'label',
            { className: 'dvt-config__row', key },
            h(
              'span',
              { className: 'dvt-config__text' },
              h('span', { className: 'dvt-config__label' }, label),
              hint ? h('span', { className: 'dvt-config__hint' }, hint) : null,
            ),
            control,
          )
        const toggle = (path, label, hint) =>
          row(
            path.join('.'),
            label,
            hint,
            h('input', {
              type: 'checkbox',
              className: 'dvt-config__control',
              checked: readPath(value, path) !== false,
              disabled: !writable,
              onChange: (event) => write(path, event.target.checked),
            }),
          )
        const text = (path, label, hint, attrs) =>
          row(
            path.join('.'),
            label,
            hint,
            h('input', {
              type: 'text',
              className: 'dvt-config__control',
              value: String(readPath(value, path) ?? ''),
              disabled: !writable,
              placeholder: (attrs && attrs.placeholder) || '',
              onChange: (event) => write(path, String(event.target.value ?? '')),
            }),
          )
        const number = (path, label, hint, attrs) =>
          row(
            path.join('.'),
            label,
            hint,
            h('input', {
              type: 'number',
              className: 'dvt-config__control dvt-config__control--number',
              value: String(readPath(value, path) ?? ''),
              disabled: !writable,
              min: attrs && attrs.min,
              max: attrs && attrs.max,
              step: attrs && attrs.step,
              onChange: (event) => {
                const raw = event.target.value
                if (raw === '') return
                const parsed = Number(raw)
                if (!Number.isFinite(parsed)) return
                write(path, attrs && attrs.step === 1 ? Math.round(parsed) : parsed)
              },
            }),
          )
        const select = (path, label, hint, options) =>
          row(
            path.join('.'),
            label,
            hint,
            h(
              'select',
              {
                className: 'dvt-config__control dvt-config__control--select',
                value: String(readPath(value, path) ?? ''),
                disabled: !writable,
                onChange: (event) => write(path, event.target.value),
              },
              options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            ),
          )
        const status = !ready
          ? snapshot && snapshot.status === 'unavailable'
            ? '当前宿主未提供这一行的设置（插件行未激活或宿主版本不支持）。'
            : '正在读取当前 profile 的配置…'
          : pending
            ? `保存中：${pending}`
            : tone === 'error'
              ? '保存失败：宿主拒绝了这次修改，已刷新为当前值。'
              : tone === 'ok'
                ? '已保存并立即生效。'
                : snapshot.writable === false
                  ? '当前 profile 的配置为只读。'
                  : '修改后立即生效：不会重启插件，也不会打断进行中的会话。'
        return h(
          'div',
          { className: 'dvt-config' },
          h(
            'div',
            { className: 'dvt-config__intro' },
            '这些设置属于当前 DSH profile（每个 profile 各自保存一份），写入该 profile 的 cordis.patch.yml。',
          ),
          h(
            'div',
            { className: 'dvt-config__intro' },
            '保存后立即生效：不重挂插件、不 dispose 工具、不打断进行中的会话。' +
              '例外：skills.mode 在下次激活时生效（提示词在激活时组装）；worker 空闲退出在下一次活动时生效；' +
              '轮次中途打开门禁时，本轮已发生的工具结果不在证据账本里。',
          ),
          h(
            'div',
            { className: 'dvt-config__group' },
            h('div', { className: 'dvt-config__title' }, '数字核实门禁'),
            toggle(
              ['verification', 'enabled'],
              '启用数字核实门禁',
              '关闭后不再逐数字核实，也不会再注入 [GROUNDING GATE] 纠正消息',
            ),
            toggle(
              ['verification', 'identityGate'],
              'identity 门禁',
              '行情类工具调用前必须先用 search_symbol 锁定标的',
            ),
            toggle(
              ['verification', 'figuresGate'],
              'figures 核实',
              '回答里的数字必须能在本次会话的工具结果中找到依据',
            ),
            number(['verification', 'maxRevisions'], '修订预算', '0 = 不纠正直接出面板；2 = 最多一次纠正后出面板', {
              min: 0,
              max: 20,
              step: 1,
            }),
            select(['verification', 'onFailure'], '预算耗尽后', 'DSH 无法改写已提交的回答；面板紧贴回答，默认不再多跑一轮', [
              { value: 'panel', label: 'panel（只出轮末面板，默认）' },
              { value: 'disclose', label: 'disclose（再让模型说一句未核实）' },
              { value: 'silent', label: 'silent（不出面板也不注入消息）' },
            ]),
          ),
          h(
            'div',
            { className: 'dvt-config__group' },
            h('div', { className: 'dvt-config__title' }, '技能与 worker'),
            select(['skills', 'mode'], '技能目录', 'short 只列名称；full 带头部说明；none 不写入提示词（下次激活生效）', [
              { value: 'short', label: 'short' },
              { value: 'full', label: 'full' },
              { value: 'none', label: 'none' },
            ]),
            number(['worker', 'idleMinutes'], 'worker 空闲退出（分钟）', '0 = 不自动退出；下一次活动起生效', { min: 0, step: 1 }),
            number(['worker', 'defaultTimeoutMs'], '普通工具超时（毫秒）', '', { min: 1000, step: 1000 }),
            number(['worker', 'longTimeoutMs'], '长时间工具超时（毫秒）', '回测 / 研究类工具', {
              min: 1000,
              step: 1000,
            }),
            text(
              ['worker', 'patchFile'],
              '启动时加载的猴子补丁（.py）',
              '留空 = 不加载。worker 启动时执行一次，可修改数据源 / 工具；结果见 ping 的 startup.user_patch。改完需重启 worker 生效。',
              { placeholder: '~/.vibe-trading/dsh/patches/my_patch.py' },
            ),
          ),
          h(
            'div',
            { className: 'dvt-config__group' },
            h('div', { className: 'dvt-config__title' }, '安装策略（只读）'),
            h(
              'div',
              { className: 'dvt-config__hint' },
              `vibe-trading-ai 最低版本 ${readPath(value, ['minimumVersion']) ?? '?'} · 策略 ` +
                `${readPath(value, ['packageMode']) ?? '?'}；改动请用 /vibe-trading init --pinned|--latest。`,
            ),
          ),
          h(
            'div',
            { className: 'dvt-config__status', 'data-tone': tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : undefined },
            status,
          ),
        )
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStatusStyles(typeof document === 'undefined' ? undefined : document)
        ensureSettingsStyles(typeof document === 'undefined' ? undefined : document)
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'vibe-trading-status', order: 10 },
            VibeTradingChip,
          ),
        )
        // Additive footer after a completed turn; N=0 renders nothing.
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'vibe-trading-gate', order: 20 },
            GateFooter,
          ),
        )
        // Profile settings page on the plugin detail page. Optional by design:
        // deployments without the settings service keep the chip and the panel.
        ctx.inject(['configForms'], (child) => {
          child.effect(
            () =>
              child.configForms.whileServed([CONFIG_ENTRY_ID], () =>
                child.slots.inject('plugins.bundle.config', () =>
                  child.slots.register(
                    { name: 'plugins.bundle.config', key: CONFIG_ENTRY_ID },
                    createSettingsPage(child.configForms),
                  ),
                ),
              ),
            'dsh-vibe-trading: profile settings page',
          )
        })
      },
    }
  },
})
