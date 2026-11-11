import z from '@deepseek-ai/schemastery'
import { ConfigError } from './errors.js'

export type PermissionMode = 'allow-once' | 'allow-always' | 'reject'

/**
 * Antigravity's own session mode, applied through the standard `mode` config option at session creation.
 *  - `plan` (default): observed to route mutations (e.g. shell) through `session/request_permission`, which this
 *    plugin forwards to dsh's approval seam.
 *  - `default`: Antigravity's native mode. In agy 1.5.x it writes files WITHOUT asking the ACP client, so dsh's
 *    approval rules cannot govern file writes. Opt in only if you accept that.
 * `accept-edits` is intentionally not selectable.
 */
export type SessionMode = 'plan' | 'default'

/** How Antigravity's own tool activity is surfaced in the dsh transcript. */
export type ToolActivity = 'text' | 'hidden'

/** Validated, fully-defaulted plugin configuration. */
export interface AgyConfig {
  /** Antigravity CLI executable. Default: `agy`. */
  readonly command: string
  /** Arguments. Default: `["acp"]`. Flags that bypass permissions or redirect the CLI are rejected. */
  readonly args: string[]
  /**
   * What to select on the ACP side once dsh's own approval seam has approved a request.
   * `allow-once` (default) never persists anything; `allow-always` is an explicit opt-in; `reject` denies all.
   */
  readonly permissionMode: PermissionMode
  /** Antigravity session mode; see {@link SessionMode}. Default `plan` (most restrictive practical). */
  readonly sessionMode: SessionMode
  /** Max time for spawn + `initialize`. */
  readonly startupTimeoutMs: number
  /** Max time for non-prompt requests; also the inactivity limit during a prompt turn. */
  readonly requestTimeoutMs: number
  /** Stop the subprocess after this long without active sessions. 0 disables. */
  readonly idleTimeoutMs: number
  readonly debug: boolean
  /** If set, diagnostic output goes to this file instead of stderr. */
  readonly logFile?: string | undefined
  /**
   * `text` (default) writes a compact line for each Antigravity tool call into the assistant transcript, so the
   * user can see what the agent did. dsh has no provider-executed tool concept, so these are plain text blocks.
   * `hidden` drops tool activity entirely.
   */
  readonly toolActivity: ToolActivity
  /** How long a discovered model catalog is reused before asking `agy acp` again. */
  readonly modelsRefreshMs: number
}

export const DEFAULT_CONFIG: AgyConfig = {
  command: 'agy',
  args: ['acp'],
  permissionMode: 'allow-once',
  sessionMode: 'plan',
  startupTimeoutMs: 20_000,
  requestTimeoutMs: 120_000,
  idleTimeoutMs: 300_000,
  debug: false,
  toolActivity: 'text',
  modelsRefreshMs: 60_000,
}

/** The cordis config schema. Every field has a default so an empty config is valid. */
export type Config = AgyConfig

export const Config: Schemastery<Config> = z.object({
  command: z.string().default(DEFAULT_CONFIG.command),
  args: z.array(z.string()).default([...DEFAULT_CONFIG.args]),
  permissionMode: z.union(['allow-once', 'allow-always', 'reject']).default(DEFAULT_CONFIG.permissionMode),
  sessionMode: z.union(['plan', 'default']).default(DEFAULT_CONFIG.sessionMode),
  startupTimeoutMs: z.number().default(DEFAULT_CONFIG.startupTimeoutMs),
  requestTimeoutMs: z.number().default(DEFAULT_CONFIG.requestTimeoutMs),
  idleTimeoutMs: z.number().default(DEFAULT_CONFIG.idleTimeoutMs),
  debug: z.boolean().default(DEFAULT_CONFIG.debug),
  logFile: z.string().default(''),
  toolActivity: z.union(['text', 'hidden']).default(DEFAULT_CONFIG.toolActivity),
  modelsRefreshMs: z.number().default(DEFAULT_CONFIG.modelsRefreshMs),
})

/**
 * Flags the plugin refuses to pass to `agy acp`. Each either bypasses permissions or redirects the CLI away from
 * its own official endpoint / identity / credential storage — all outside this plugin's security model.
 */
const FORBIDDEN_ARG = new Set([
  '--dangerously-skip-permissions',
  '--cloud_code_endpoint',
  '--override_user_agent_name',
  '--gemini-dir',
  '--gemini_dir',
  '--app-data-dir',
  '--app_data_dir',
  '--cli_dir_name',
  '--login',
])

function finiteNumber(value: number, key: string, min: number): number {
  if (!Number.isFinite(value) || value < min) throw new ConfigError(`"${key}" must be a number >= ${min}`)
  return value
}

/**
 * Validate the schema-validated config once more, then normalize it.
 *
 * Schemastery gives us types and defaults; this pass enforces the security-relevant rules that a schema cannot
 * express (forbidden CLI flags), trims the executable name, and normalizes an empty `logFile` to `undefined`.
 * Throws {@link ConfigError}, which makes the plugin fail to load with a clear message rather than silently
 * running with a weaker configuration.
 */
export function resolveConfig(input?: Partial<Config>): AgyConfig {
  // Accept a partial config (tests, hand-built callers) and fill each omitted field from the safe defaults.
  const provided = Object.fromEntries(
    Object.entries(input ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<Config>
  const raw: Config = { ...DEFAULT_CONFIG, ...provided }
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command === '') throw new ConfigError('"command" must be a non-empty string')

  const args = raw.args ?? DEFAULT_CONFIG.args
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    throw new ConfigError('"args" must be an array of strings')
  }
  for (const arg of args) {
    const flag = arg.split('=', 1)[0] ?? arg
    if (FORBIDDEN_ARG.has(flag)) {
      throw new ConfigError(`Argument "${flag}" is not allowed: it bypasses permissions or redirects the official CLI.`)
    }
  }

  if (raw.permissionMode !== 'allow-once' && raw.permissionMode !== 'allow-always' && raw.permissionMode !== 'reject') {
    throw new ConfigError('"permissionMode" must be "allow-once", "allow-always" or "reject"')
  }
  if (raw.sessionMode !== 'plan' && raw.sessionMode !== 'default') {
    throw new ConfigError('"sessionMode" must be "plan" or "default" ("accept-edits" is deliberately not supported)')
  }
  if (raw.toolActivity !== 'text' && raw.toolActivity !== 'hidden') {
    throw new ConfigError('"toolActivity" must be "text" or "hidden"')
  }

  const logFile = typeof raw.logFile === 'string' && raw.logFile.trim() !== '' ? raw.logFile.trim() : undefined

  return {
    command,
    args: [...args],
    permissionMode: raw.permissionMode,
    sessionMode: raw.sessionMode,
    startupTimeoutMs: finiteNumber(raw.startupTimeoutMs, 'startupTimeoutMs', 100),
    requestTimeoutMs: finiteNumber(raw.requestTimeoutMs, 'requestTimeoutMs', 100),
    idleTimeoutMs: finiteNumber(raw.idleTimeoutMs, 'idleTimeoutMs', 0),
    debug: raw.debug === true,
    logFile,
    toolActivity: raw.toolActivity,
    modelsRefreshMs: finiteNumber(raw.modelsRefreshMs, 'modelsRefreshMs', 0),
  }
}

/** Stable key identifying one subprocess (only command + args change what gets spawned). */
export function configKey(c: AgyConfig): string {
  return JSON.stringify([c.command, c.args])
}
