/** Append-only plugin log, for diagnosing command registration and init runs. */
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { logsDir } from './config.js'

export function pluginLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(logsDir(env), 'plugin.log')
}

/** Best-effort log write; never throws and never slows the caller. */
export async function pluginLog(message: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await mkdir(logsDir(env), { recursive: true })
    await appendFile(pluginLogFile(env), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* logging must never break the plugin */
  }
}

/** Fire-and-forget variant for hot paths. */
export function pluginLogNow(message: string, env: NodeJS.ProcessEnv = process.env): void {
  void pluginLog(message, env)
}
