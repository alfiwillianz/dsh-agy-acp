import { appendFileSync } from 'node:fs'

/**
 * Debug logger. Writes ONLY to stderr or a file — never stdout. (Our own stdout is not the JSON-RPC channel,
 * but dsh's TUI/CLI may use it, and the child's stdout is reserved for JSON-RPC and is never logged here.)
 *
 * Only metadata is logged: method names, ids, lifecycle events and the child's stderr. Prompt text, file
 * contents and anything credential-like are never passed to the logger by this plugin.
 */
export interface Logger {
  readonly enabled: boolean
  debug(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export const silentLogger: Logger = {
  enabled: false,
  debug() {},
  warn() {},
  error() {},
}

export function createLogger(options: { debug: boolean; logFile?: string | undefined }): Logger {
  const write = (level: string, message: string, extra?: Record<string, unknown>) => {
    const line =
      `[agy-acp] ${new Date().toISOString()} ${level} ${message}` +
      (extra && Object.keys(extra).length ? ` ${safeJson(extra)}` : '') +
      '\n'
    try {
      if (options.logFile) appendFileSync(options.logFile, line)
      else process.stderr.write(line)
    } catch {
      /* logging must never break the integration */
    }
  }
  return {
    enabled: options.debug,
    debug: (m, e) => {
      if (options.debug) write('DEBUG', m, e)
    },
    // Warnings and errors always go to stderr/file, even without debug, so failures are never silent.
    warn: (m, e) => write('WARN', m, e),
    error: (m, e) => write('ERROR', m, e),
  }
}

/**
 * Defense in depth for the CLI's stderr, which we relay to the log/error messages: mask anything that looks like a
 * bearer credential. This plugin never reads credentials; this only guards against the child echoing one.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\b(access_token|refresh_token|id_token|api[_-]?key)(["'\s:=]+)[^\s"',}&]{6,}/gi, '$1$2[redacted]')
    // `agy` prints the signed-in account to stderr; keep account identifiers out of dsh's logs too.
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}
