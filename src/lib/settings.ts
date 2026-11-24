/**
 * Profile-scoped plugin settings.
 *
 * Behavioural preferences (number gate, skills mode, worker lifecycle) belong to
 * the DSH profile, not to the shared `~/.vibe-trading/dsh/config.json`: every
 * profile runs its own host process and its own Python worker, and users expect
 * the desktop and headless profiles to differ. They are declared in this
 * plugin's Loader row config instead, so:
 *
 *   - the web UI edits them on the plugin page (`plugins.bundle.config`);
 *   - `configEditor` persists them into the current profile's `cordis.patch.yml`;
 *   - the Loader commits a volatile-only change into the running refs without
 *     remounting the plugin (remounting would dispose every session's tools);
 *   - `config.json` keeps only install facts (paths, interpreter, package pin).
 *
 * Volatile fields arrive from the Loader as stable references
 * (`cosmokit.volatile.write` + `get()`), so the same settings module serves both
 * the live values and the schema the form renders. When the host's schema
 * library cannot be resolved the plugin still runs: the plain config object is
 * read as-is and every value falls back to its default.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_MINIMUM_VERSION,
  DEFAULT_PACKAGE_MODE,
  DEFAULT_SKILLS,
  DEFAULT_VERIFICATION,
  DEFAULT_WORKER,
  parseConfigValue,
} from './config.js'

/** Loader entry id of this plugin's row (also the host settings namespace). */
export const CONFIG_ENTRY_ID = 'dsh-vibe-trading'

/** Shared reference protocol marker; copies of cosmokit agree on this symbol. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Defaults for every profile-scoped setting (mirrors the Config schema). */
export const SETTING_DEFAULTS = {
  minimumVersion: DEFAULT_MINIMUM_VERSION,
  packageMode: DEFAULT_PACKAGE_MODE,
  verification: { ...DEFAULT_VERIFICATION },
  skills: { ...DEFAULT_SKILLS },
  worker: { ...DEFAULT_WORKER },
}

/** Field paths accepted by `/vibe-trading config set`. */
export const SETTING_KEYS = [
  'verification.enabled',
  'verification.identityGate',
  'verification.figuresGate',
  'verification.maxRevisions',
  'verification.onFailure',
  'verification.ignoreRules',
  'skills.mode',
  'skills.loadLimitChars',
  'worker.idleMinutes',
  'worker.defaultTimeoutMs',
  'worker.longTimeoutMs',
  'worker.patchFile',
]

/** Whether a parsed config value is a volatile reference. */
export function isVolatileRef(value: unknown): boolean {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in (value as object)
}

/** Read a config value, dereferencing a volatile reference when present. */
export function unwrapVolatile(value: any): any {
  if (!isVolatileRef(value)) return value
  const ref = value as { get: () => any }
  return typeof ref.get === 'function' ? ref.get() : undefined
}

function clone(value: any) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function sectionValue(raw: any, section: string, key: string, fallback: any) {
  const node = raw?.[section]?.[key]
  const value = unwrapVolatile(node)
  return value === undefined ? fallback : value
}

/**
 * Normalize `verification.onFailure`.
 *
 * `panel` (default) writes the turn-tail footer record and lets the turn close:
 * the panel sits directly under the answer, and no extra model round is spent
 * on a boilerplate disclosure sentence. `disclose` keeps the old extra round for
 * deployments that need the caveat in the transcript text itself (exports,
 * clients without the plugin's client half). `silent` writes neither.
 */
export function failureMode(value: unknown): 'panel' | 'disclose' | 'silent' {
  return value === 'disclose' || value === 'silent' ? value : 'panel'
}

/**
 * Live view over the plugin row config.
 *
 * Every accessor dereferences the Loader references at call time, so a saved
 * form value reaches the next gate check / tool call without re-activating the
 * session.
 */
export function createSettings(pluginConfig: any) {
  const raw = pluginConfig ?? {}

  function verification() {
    const base = SETTING_DEFAULTS.verification
    const rules = unwrapVolatile(raw?.verification?.ignoreRules)
    return {
      enabled: sectionValue(raw, 'verification', 'enabled', base.enabled) !== false,
      identityGate: sectionValue(raw, 'verification', 'identityGate', base.identityGate) !== false,
      figuresGate: sectionValue(raw, 'verification', 'figuresGate', base.figuresGate) !== false,
      maxRevisions: Number(sectionValue(raw, 'verification', 'maxRevisions', base.maxRevisions)),
      onFailure: failureMode(sectionValue(raw, 'verification', 'onFailure', base.onFailure)),
      ignoreRules: rules && typeof rules === 'object' ? clone(rules) : clone(base.ignoreRules),
    }
  }

  function worker() {
    const base = SETTING_DEFAULTS.worker
    return {
      idleMinutes: Number(sectionValue(raw, 'worker', 'idleMinutes', base.idleMinutes)),
      defaultTimeoutMs: Number(sectionValue(raw, 'worker', 'defaultTimeoutMs', base.defaultTimeoutMs)),
      longTimeoutMs: Number(sectionValue(raw, 'worker', 'longTimeoutMs', base.longTimeoutMs)),
      patchFile: String(sectionValue(raw, 'worker', 'patchFile', base.patchFile)),
    }
  }

  function skills() {
    const base = SETTING_DEFAULTS.skills
    return {
      mode: String(sectionValue(raw, 'skills', 'mode', base.mode)),
      loadLimitChars: Number(sectionValue(raw, 'skills', 'loadLimitChars', base.loadLimitChars)),
    }
  }

  function minimumVersion() {
    return String(unwrapVolatile(raw?.minimumVersion) ?? SETTING_DEFAULTS.minimumVersion)
  }

  function packageMode(): 'pinned' | 'latest' {
    return unwrapVolatile(raw?.packageMode) === 'latest' ? 'latest' : 'pinned'
  }

  function snapshot() {
    return {
      minimumVersion: minimumVersion(),
      packageMode: packageMode(),
      verification: verification(),
      worker: worker(),
      skills: skills(),
    }
  }

  return { raw, verification, worker, skills, minimumVersion, packageMode, snapshot }
}

export type PluginSettings = ReturnType<typeof createSettings>

/**
 * Wrap the install-facts config so `cfg.verification` / `cfg.worker` /
 * `cfg.skills` read the live profile settings.
 *
 * Base values from `config.json` are kept underneath (advanced worker paths are
 * set there by hand), and the profile setting wins on every shared key.
 */
export function liveConfig(installConfig: any, settings: PluginSettings) {
  const base = { ...(installConfig ?? {}) }
  // Snapshot the file sections before the getters shadow them (reading
  // `base.worker` inside the getter would recurse into the getter itself).
  const fileSections: Record<string, any> = {
    verification: base.verification,
    worker: base.worker,
    skills: base.skills,
  }
  const merged = (section: keyof typeof SETTING_DEFAULTS, fromSettings: any) => {
    const fileSection = fileSections[section]
    return fileSection && typeof fileSection === 'object' ? { ...fileSection, ...fromSettings } : fromSettings
  }
  Object.defineProperty(base, 'verification', { enumerable: true, get: () => merged('verification', settings.verification()) })
  Object.defineProperty(base, 'worker', { enumerable: true, get: () => merged('worker', settings.worker()) })
  Object.defineProperty(base, 'skills', { enumerable: true, get: () => merged('skills', settings.skills()) })
  return base
}

/* ------------------------------------------------------------------------- */
/* Loader Config schema                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the host's own schemastery instance.
 *
 * A second copy would be a different module instance; volatile metadata and the
 * `~standard` hook are read by the Loader, so the schema must be built by the
 * very library the host uses. `process.argv[1]` is the host entry, which is how
 * `gate-record.ts` reaches the running `dsh-session` module as well.
 */
function hostRequireAnchor(): string | undefined {
  const argv = process.argv[1]
  if (argv && argv.length > 0) return path.resolve(argv)
  return undefined
}

let schemaModule: Promise<any> | null = null

/**
 * Load the host's schemastery ESM build (resolved from the running host).
 *
 * @param anchor Host entry file to resolve from; defaults to `process.argv[1]`.
 *   Diagnostics pass the installed host's entry explicitly.
 */
export function loadHostSchema(anchor?: string): Promise<any> {
  if (anchor === undefined && schemaModule !== null) return schemaModule
  const resolve = async () => {
    const from = anchor ?? hostRequireAnchor()
    if (!from) throw new Error('host entry (process.argv[1]) is unknown')
    const hostRequire = createRequire(path.resolve(from))
    const pkgPath = hostRequire.resolve('@deepseek-ai/schemastery/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const entry = pkg?.exports?.['.']?.import ?? pkg?.module ?? pkg?.main
    if (typeof entry !== 'string') throw new Error('schemastery package has no entry')
    const url = pathToFileURL(path.resolve(path.dirname(pkgPath), entry)).href
    const mod: any = await import(url)
    const lib = mod?.default ?? mod
    if (typeof lib?.object !== 'function') throw new Error('schemastery module is unusable')
    return lib
  }
  if (anchor !== undefined) return resolve()
  schemaModule = resolve()
  return schemaModule
}

const MODES = ['short', 'full', 'none'] as const

/** Build the Loader config schema: every field is volatile (no remount). */
export function buildConfigSchema(z: any) {
  return z.object({
    minimumVersion: z.string().default(SETTING_DEFAULTS.minimumVersion).volatile()
      .description('vibe-trading-ai 最低版本（安装/升级时生效）'),
    packageMode: z
      .union([z.const('pinned'), z.const('latest')])
      .default(SETTING_DEFAULTS.packageMode)
      .volatile()
      .description('安装策略：pinned 固定已验证版本，latest 跟随最新'),
    verification: z
      .object({
        enabled: z.boolean().default(true).volatile().description('数字核实门禁总开关'),
        identityGate: z.boolean().default(true).volatile().description('行情调用前必须锁定标的'),
        figuresGate: z.boolean().default(true).volatile().description('回答逐数字核实（[GROUNDING GATE] 纠正）'),
        maxRevisions: z.number().step(1).min(0).max(20).default(2).volatile().description('修订预算（0 = 不纠正，直接出面板）'),
        onFailure: z
          .union([z.const('panel'), z.const('disclose'), z.const('silent')])
          .default('panel')
          .volatile()
          .description('预算耗尽后：panel 只出轮末面板，disclose 再让模型说明未核实，silent 不注入消息也不出面板'),
        ignoreRules: z
          .object({
            urls: z.boolean().default(true),
            paths: z.boolean().default(true),
            code: z.boolean().default(true),
            versions: z.boolean().default(true),
            dates: z.boolean().default(true),
            sections: z.boolean().default(true),
            ids: z.boolean().default(true),
            extra: z.array(z.string()).default([]),
          })
          .default({})
          .volatile()
          .collapse()
          .description('自动豁免的非财务数字（URL/路径/代码/版本/日期/章节/ID）'),
      })
      .default({})
      .collapse(),
    skills: z
      .object({
        mode: z.union([z.const(MODES[0]), z.const(MODES[1]), z.const(MODES[2])]).default('short').volatile(),
        loadLimitChars: z.number().step(1).min(1000).default(DEFAULT_SKILLS.loadLimitChars).volatile(),
      })
      .default({})
      .collapse(),
    worker: z
      .object({
        idleMinutes: z.number().step(1).min(0).default(DEFAULT_WORKER.idleMinutes).volatile(),
        defaultTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_WORKER.defaultTimeoutMs).volatile(),
        longTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_WORKER.longTimeoutMs).volatile(),
        patchFile: z.string().default(DEFAULT_WORKER.patchFile).volatile(),
      })
      .default({})
      .collapse(),
  })
}

/* ------------------------------------------------------------------------- */
/* Writes                                                                     */
/* ------------------------------------------------------------------------- */

/** Turn one dotted key + raw string into the nested patch the service accepts. */
export function settingPatch(keyPath: string, rawValue: string) {
  const parts = String(keyPath ?? '')
    .split('.')
    .filter(Boolean)
  if (parts.length < 2) return { ok: false as const, error: '用法：config set <section>.<key> <value>' }
  const key = parts.join('.')
  // `verification.ignoreRules` is one volatile object; either the whole object or
  // one of its rules may be written.
  const supported = SETTING_KEYS.includes(key) || key.startsWith('verification.ignoreRules.')
  if (!supported) {
    return { ok: false as const, error: `不支持这个设置项：${key}（可用：${SETTING_KEYS.join(', ')}）` }
  }
  const value = parseConfigValue(rawValue)
  const patch: any = {}
  let cursor = patch
  for (const part of parts.slice(0, -1)) {
    cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts.at(-1)!] = value
  return { ok: true as const, patch, value, key }
}
