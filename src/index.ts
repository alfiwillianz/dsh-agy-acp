import type { Context } from '@deepseek-ai/cordis'
import { AcpProcess } from './acp-process.js'
import { AgyAcpAdapter } from './adapter.js'
import { Config, resolveConfig, type Config as ConfigType } from './config.js'
import { createLogger } from './log.js'

/**
 * dsh plugin: exposes the Gemini models reported by Google's official `agy acp` server as the `antigravity`
 * provider, and routes Antigravity's permission requests through dsh's approval seam.
 *
 * Authentication is entirely the Antigravity CLI's: this plugin never reads, stores, copies or refreshes any
 * credential. If the CLI is not signed in, model discovery fails with instructions and no models are registered.
 */

export { Config }
export { AgyAcpAdapter } from './adapter.js'
export { AcpProcess } from './acp-process.js'
export { DEFAULT_CONFIG, resolveConfig, type AgyConfig, type Config as AgyAcpConfig } from './config.js'

export const name = 'agy-acp'
export const inject = ['llm']

/** Provider route key used by `GenerateOptions.provider` and the model picker. */
export const PROVIDER = 'antigravity'

export function apply(ctx: Context, config: ConfigType): void {
  const resolved = resolveConfig(config) // throws ConfigError => plugin fails to load, clearly
  const log = createLogger({ debug: resolved.debug, logFile: resolved.logFile })
  const proc = new AcpProcess(resolved, log)
  const adapter = new AgyAcpAdapter(ctx, resolved, proc, log)

  // 1) Register the provider route. Model discovery happens lazily on the first list/resolve/stream.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  // 2) Declare the route in the configurable-provider directory so settings surfaces can show it. This is
  //    advisory: if another plugin already declared the route, the adapter above still serves requests.
  const settingsNs =
    (ctx.fiber as unknown as { entry?: { options?: { id?: string } } }).entry?.options?.id ?? name
  let directory: (() => void) | undefined
  try {
    directory = ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER,
        displayName: 'Antigravity (Gemini via ACP)',
        settingsNs,
        settingsPath: [],
      },
    ])
  } catch (e) {
    log.warn('could not declare the configurable provider', { message: (e as Error)?.message })
  }

  // 3) Unload: unregister, cancel in-flight work, terminate the subprocess.
  ctx.effect(
    () => () => {
      try {
        registration()
      } catch {
        /* already released */
      }
      try {
        directory?.()
      } catch {
        /* already released */
      }
      void proc.dispose()
    },
    'agy-acp',
  )
}
