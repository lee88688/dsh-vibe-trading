/** Small child-process helpers shared by preflight and install. */

import { spawn } from 'node:child_process'

/**
 * Run a command and capture output without ever throwing.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null, timedOut: boolean}>}
 */
export interface ExecResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  error: string | null
  timedOut: boolean
}

export function tryExec(file: any, args: any[] = [], options: any = {}): Promise<ExecResult> {
  const {
    cwd,
    env,
    timeoutMs = 20_000,
    input,
  } = options
  return new Promise<ExecResult>((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error: any) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: String(error?.message ?? error),
        timedOut: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    if (timer.unref) timer.unref()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr, error: String(error?.message ?? error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr, error: null, timedOut })
    })

    if (input !== undefined) {
      try {
        child.stdin?.end(input)
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin?.end()
      } catch {
        /* ignore */
      }
    }
  })
}

/** Run a python interpreter snippet and return trimmed stdout. */
export async function pythonProbe(exe: string, code: string, options: any = {}) {
  const result = await tryExec(exe, ['-c', code], { timeoutMs: options.timeoutMs ?? 15_000, env: options.env, cwd: options.cwd })
  if (!result.ok) return { ok: false, value: null, detail: (result.stderr || result.error || '').trim().slice(0, 400), raw: result }
  return { ok: true, value: result.stdout.trim(), detail: '', raw: result }
}
