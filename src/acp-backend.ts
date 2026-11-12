import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpCapabilities, AcpAgentBackend, AgentSession, AgentSessionHandlers, AgentStopReason } from './backend.js'
import type { AcpProcess, AcpSession } from './acp-process.js'
import { UnsupportedAcpError } from './errors.js'
import { translateUpdate } from './events.js'
import type { Logger } from './log.js'

/** One `AcpSession` exposed through the backend-neutral session interface. */
class BackendSession implements AgentSession {
  constructor(
    private readonly session: AcpSession,
    private readonly backend: AcpAgentBackend,
    readonly cwd: string,
  ) {}

  get id(): string {
    return this.session.sessionId
  }
  get info(): Readonly<Record<string, unknown>> {
    return this.session.response
  }
  get resumed(): boolean {
    return this.session.resumed
  }
  get closed(): boolean {
    // A stopped/crashed process invalidates every session it owned, even if this handle was never closed.
    return this.session.closed || !this.backend.running
  }
  get capabilities(): AcpCapabilities {
    return this.backend.capabilities
  }
  prompt(content: readonly ContentBlock[], signal?: AbortSignal): Promise<AgentStopReason> {
    return this.session.prompt(content, signal)
  }
  cancel(): void {
    this.session.cancel()
  }
  close(): Promise<void> {
    return this.session.close()
  }
  setConfigOption(configId: string, value: string): Promise<void> {
    return this.session.setConfigOption(configId, value)
  }
  setMode(modeId: string): Promise<void> {
    return this.session.setMode(modeId)
  }
}

/**
 * Generic ACP execution backend over one `AcpProcess`.
 *
 * This class knows nothing about Antigravity: model filtering, family collapsing, session modes, and thinking
 * levels live in the Antigravity adapter. A different ACP agent can reuse this backend unchanged.
 */
export class AcpAgentBackendImpl implements AcpAgentBackend {
  constructor(
    private readonly proc: AcpProcess,
    private readonly log: Logger,
  ) {}

  get capabilities(): AcpCapabilities {
    return this.proc.capabilities
  }

  get running(): boolean {
    return this.proc.running
  }

  async createSession(input: { cwd: string; handlers: AgentSessionHandlers }): Promise<AgentSession> {
    const session = await this.proc.openSession(input.cwd, this.#handlers(input.handlers))
    this.log.debug('created ACP session', {
      acpSession: session.sessionId,
      cwd: input.cwd,
      image: this.capabilities.prompt.image,
      embeddedContext: this.capabilities.prompt.embeddedContext,
      load: this.capabilities.session.load,
      resume: this.capabilities.session.resume,
    })
    return new BackendSession(session, this, input.cwd)
  }

  async resumeSession(input: {
    cwd: string
    sessionId: string
    handlers: AgentSessionHandlers
  }): Promise<AgentSession> {
    // Capabilities are only known after `initialize`; start the process before deciding which restore method to use.
    await this.proc.ensureStarted()
    // Prefer `session/load` (replays prior updates through the handlers) over `session/resume` (no replay).
    if (this.capabilities.session.load) {
      // `session/load` replays historical conversation updates. They are not this turn's output, so keep them out
      // of the live stream (and out of the continuity fingerprint) while the load request is in flight.
      let replaying = true
      let replayed = 0
      const handlers = this.#handlers({
        onUpdate: (update) => {
          if (replaying) {
            replayed++
            return
          }
          input.handlers.onUpdate(update)
        },
        onPermission: (request) =>
          replaying ? Promise.resolve({ outcome: 'cancelled' as const }) : input.handlers.onPermission(request),
      })
      try {
        const session = await this.proc.loadSession(input.cwd, input.sessionId, handlers)
        replaying = false
        this.log.debug('loaded ACP session', { acpSession: session.sessionId, cwd: input.cwd, replayed })
        return new BackendSession(session, this, input.cwd)
      } catch (e) {
        replaying = false
        throw e
      }
    }
    if (this.capabilities.session.resume) {
      const session = await this.proc.resumeSession(input.cwd, input.sessionId, this.#handlers(input.handlers))
      this.log.debug('resumed ACP session', { acpSession: session.sessionId, cwd: input.cwd })
      return new BackendSession(session, this, input.cwd)
    }
    throw new UnsupportedAcpError(
      'the agent advertises neither `loadSession` nor `sessionCapabilities.resume`, so an existing ACP session ' +
        'cannot be restored; a fresh session will be created and the conversation replayed',
    )
  }

  dispose(): Promise<void> {
    return this.proc.dispose()
  }

  #handlers(handlers: AgentSessionHandlers): {
    onUpdate: (update: import('./acp-process.js').SessionUpdate) => void
    onPermission: (
      request: import('./acp-process.js').PermissionRequest,
      signal: AbortSignal,
    ) => ReturnType<AgentSessionHandlers['onPermission']>
  } {
    return {
      onUpdate: (update) => {
        const translated = translateUpdate(update)
        if (translated === undefined) return
        try {
          handlers.onUpdate(translated)
        } catch (e) {
          this.log.warn('session update handler threw', { message: (e as Error)?.message })
        }
      },
      onPermission: (request, signal) =>
        handlers.onPermission({
          sessionId: request.sessionId,
          toolCall: request.toolCall,
          options: request.options,
          signal,
        }),
    }
  }
}
