/** Typed errors so callers (and tests) can distinguish failure modes without string matching. */

export class AgyError extends Error {
  override readonly name: string = 'AgyError'
}

/** The plugin's own configuration is invalid. */
export class ConfigError extends AgyError {
  override readonly name: string = 'ConfigError'
}

/** The configured executable could not be found or executed. */
export class CliMissingError extends AgyError {
  override readonly name: string = 'CliMissingError'
  constructor(
    readonly command: string,
    cause?: unknown,
  ) {
    super(
      `Antigravity CLI "${command}" was not found or is not executable. Install Google's Antigravity CLI ` +
        `(\`agy\`) and make sure it is on PATH, or set the plugin's "command" option to its absolute path.`,
      { cause },
    )
  }
}

/** The subprocess started but does not speak ACP (e.g. an older CLI without `acp`). */
export class UnsupportedAcpError extends AgyError {
  override readonly name: string = 'UnsupportedAcpError'
  constructor(
    detail: string,
    readonly stderrTail = '',
  ) {
    super(
      `The Antigravity CLI does not expose a working ACP server (${detail}). This plugin only speaks ACP to ` +
        `\`agy acp\` and deliberately has no fallback.${stderrTail ? `\nstderr: ${stderrTail}` : ''}`,
    )
  }
}

/** The ACP server needs the user to sign in with the Antigravity CLI itself. */
export class AuthRequiredError extends AgyError {
  override readonly name: string = 'AuthRequiredError'
  constructor(detail?: string) {
    super(
      'Antigravity is not signed in. Authentication is owned by the Antigravity CLI: run `agy` (or ' +
        '`agy acp --login`) in a terminal, complete the Google login, then restart dsh.' +
        (detail ? ` (${detail})` : ''),
    )
  }
}

export class StartupTimeoutError extends AgyError {
  override readonly name: string = 'StartupTimeoutError'
  constructor(readonly ms: number) {
    super(`Antigravity ACP server did not initialize within ${ms} ms.`)
  }
}

export class RequestTimeoutError extends AgyError {
  override readonly name: string = 'RequestTimeoutError'
  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`Antigravity ACP request "${what}" timed out after ${ms} ms.`)
  }
}

/** The subprocess exited while a request was in flight (or before answering). */
export class ProcessExitedError extends AgyError {
  override readonly name: string = 'ProcessExitedError'
  constructor(
    detail: string,
    readonly stderrTail = '',
  ) {
    super(
      `The Antigravity ACP process terminated (${detail}).${stderrTail ? `\nstderr: ${stderrTail}` : ''}`,
    )
  }
}

/** The server answered, but not with a valid ACP response. */
export class ProtocolError extends AgyError {
  override readonly name: string = 'ProtocolError'
}

/** The turn or session was cancelled by the caller. */
export class CancelledError extends AgyError {
  override readonly name: string = 'CancelledError'
  constructor(message = 'Antigravity request was cancelled.') {
    super(message)
  }
}

/** Stable provider-neutral failure code for one typed error. */
export function errorCode(e: unknown): string {
  if (e instanceof CliMissingError) return 'MISSING_CLI'
  if (e instanceof AuthRequiredError) return 'AUTH'
  if (e instanceof UnsupportedAcpError) return 'UNSUPPORTED_ACP'
  if (e instanceof StartupTimeoutError || e instanceof RequestTimeoutError) return 'TIMEOUT'
  if (e instanceof ProcessExitedError) return 'TRANSPORT'
  if (e instanceof ProtocolError) return 'PROTOCOL'
  if (e instanceof CancelledError) return 'ABORTED'
  if (e instanceof ConfigError) return 'INVALID_CONFIG'
  return 'AGY_ACP_ERROR'
}
