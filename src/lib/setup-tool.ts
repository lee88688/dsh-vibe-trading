/**
 * Host tool `vibe_trading_setup` — the agent-facing entry point for
 * initializing or repairing the Python environment.
 *
 * Runs in the DSH Host process (not the workspace sandbox), so it can write
 * `<vibeHome>/dsh/**` without per-call approvals. Every action is idempotent
 * and returns a JSON string the model can read.
 */

import {
  DEFAULT_MINIMUM_VERSION,
  PINNED_VERSION,
  configPath,
  readConfig,
  reportPath,
} from './config.js'
import { runInstall, verifyEnvironment } from './install.js'
import { runPreflight, summarizePreflight } from './preflight.js'
import { TEXT_OUTPUT } from './tool-output.js'

export const SETUP_TOOL_NAME = 'vibe_trading_setup'

const ACTIONS = ['check', 'install', 'create-venv', 'verify', 'write-config', 'repair']

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description:
        'check = read-only preflight; install = create/repair the venv and install the pinned package; ' +
        'create-venv = same as install; verify = confirm the installed package; ' +
        'write-config = (re)write config.json from the current environment; repair = force a rebuild.',
    },
    pythonPath: { type: 'string', description: 'Optional interpreter to use instead of auto-detection.' },
    indexUrl: { type: 'string', description: 'Optional PyPI index URL (mirror).' },
    minimumVersion: { type: 'string', description: 'Minimum vibe-trading-ai version (defaults to the plugin pin).' },
    mode: {
      type: 'string',
      enum: ['pinned', 'latest'],
      description:
        'Install policy: pinned (exact tested version, default) or latest (newest release >= minimumVersion, reported as unverified).',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

function json(payload: any) {
  return JSON.stringify(payload, null, 2)
}

async function withOptionalPython(options: any, pythonPath?: string) {
  if (pythonPath) options.extraCandidates = [{ exe: pythonPath, via: 'explicit' }]
  return options
}

/**
 * @param {object} [deps] injectable for tests
 * @returns {{name: string, description: string, parameters: object, output: object, execute: Function}}
 */
export function createSetupTool(deps: any = {}) {
  const preflightFn = deps.runPreflight ?? runPreflight
  const installFn = deps.runInstall ?? runInstall
  const verifyFn = deps.verifyEnvironment ?? verifyEnvironment
  const envFn = deps.env ?? (() => process.env)

  return {
    name: SETUP_TOOL_NAME,
    output: TEXT_OUTPUT,
    description:
      'Initialize or repair the Vibe Trading Python environment (creates a venv under ~/.vibe-trading/dsh and installs ' +
      'vibe-trading-ai). Installs pin exactly the version this plugin was tested against by default; pass mode="latest" ' +
      'to track the newest release instead (reported, not silently treated as verified). Runs in the DSH host process ' +
      'and is safe to call repeatedly. Use check first when diagnosing, install when the environment is missing, ' +
      'repair when it is broken.',
    parameters: INPUT_SCHEMA,
    async execute(args: any = {}) {
      const env = envFn()
      const action = String(args.action || 'check')
      const minimumVersion = args.minimumVersion || DEFAULT_MINIMUM_VERSION
      const mode = args.mode === 'latest' ? 'latest' : args.mode === 'pinned' ? 'pinned' : undefined
      const pinnedVersion = PINNED_VERSION

      if (!ACTIONS.includes(action)) {
        return json({ ok: false, action, error: `unsupported action; use one of ${ACTIONS.join(', ')}` })
      }

      try {
        if (action === 'check') {
          const report = await preflightFn(
            await withOptionalPython({ env, minimumVersion, pinnedVersion }, args.pythonPath),
          )
          return json({
            ok: report.status === 'ready',
            action,
            status: report.status,
            summary: summarizePreflight(report),
            configPath: configPath(env),
            reportPath: reportPath(env),
            minimumVersion,
            pinnedVersion,
            verified: report.venv?.verified ?? null,
            pythons: report.pythons,
            uv: report.uv,
          })
        }

        if (action === 'verify') {
          const verification = await verifyFn(env, minimumVersion, { pinnedVersion })
          const config = await readConfig(env)
          return json({
            ok: Boolean(verification.ok && config.config),
            action,
            verification,
            configPath: configPath(env),
            configOk: Boolean(config.config),
            configError: config.error,
            installedVersion: config.config?.package?.installedVersion ?? verification.version ?? null,
            pinnedVersion: verification.pinnedVersion ?? pinnedVersion,
            verified: verification.verified ?? null,
          })
        }

        // install / create-venv / write-config / repair all converge on the installer.
        const force = action === 'repair'
        const options = await withOptionalPython(
          {
            env,
            minimumVersion,
            pinnedVersion,
            ...(mode ? { mode } : {}),
            indexUrl: args.indexUrl,
            force,
          },
          args.pythonPath,
        )
        const result = await installFn(options)
        return json({
          ok: result.ok,
          action,
          status: result.status,
          mode: result.report?.mode ?? mode ?? 'pinned',
          pinnedVersion: result.report?.pinnedVersion ?? pinnedVersion,
          verified: result.report?.verified ?? result.config?.package?.verified ?? null,
          configPath: configPath(env),
          reportPath: reportPath(env),
          installedVersion: result.config?.package?.installedVersion ?? null,
          steps: (result.steps ?? []).map((step: any) => ({
            id: step.id,
            ok: step.ok,
            detail: typeof step.detail === 'string' ? step.detail.slice(0, 600) : undefined,
          })),
          reason: result.report?.reason ?? null,
          failures: result.report?.failures ?? null,
        })
      } catch (error: any) {
        return json({ ok: false, action, error: String(error?.message ?? error) })
      }
    },
  }
}
