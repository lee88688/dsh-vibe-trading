/**
 * Pure parser for `/vibe-trading init` flags.
 *
 * Kept free of I/O so the command surface can be unit-tested without booting the
 * plugin or the Python runtime.
 */

export type InitMode = 'pinned' | 'latest'

export interface InitFlags {
  /** Explicit policy requested by a flag; undefined means "profile default". */
  mode?: InitMode
  /** `--force` runs the installer even when the environment is already usable. */
  force: boolean
  error: string | null
}

const KNOWN = new Set(['--latest', '--pinned', '--force'])

export function parseInitFlags(tokens: any[] = []): InitFlags {
  const flags = (Array.isArray(tokens) ? tokens : []).map((token) => String(token ?? '').toLowerCase())
  const unknown = flags.filter((flag) => !KNOWN.has(flag))
  if (unknown.length) {
    return {
      force: false,
      error: `未知参数：${unknown.join(', ')}。用法：/vibe-trading init [--latest|--pinned|--force]`,
    }
  }
  if (flags.includes('--latest') && flags.includes('--pinned')) {
    return { force: false, error: '--latest 与 --pinned 不能同时使用' }
  }
  const mode: InitMode | undefined = flags.includes('--latest')
    ? 'latest'
    : flags.includes('--pinned')
      ? 'pinned'
      : undefined
  return { mode, force: flags.includes('--force'), error: null }
}
