import { describe, expect, test } from 'bun:test'
import type {
  AcpAgentBackend,
  AcpCapabilities,
  AgentSession,
  AgentSessionHandlers,
  AgentStopReason,
  AgentUpdate,
} from '../src/backend.js'
import { EMPTY_CAPABILITIES } from '../src/backend.js'
import { DEFAULT_CONFIG, type AgyConfig } from '../src/config.js'
import { SessionContinuity } from '../src/continuity.js'
import { CancelledError, UnsupportedAcpError } from '../src/errors.js'
import { silentLogger } from '../src/log.js'
import type { MessageLike } from '../src/prompt.js'

const user = (text: string): MessageLike => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string): MessageLike => ({ role: 'assistant', content: [{ type: 'text', text }] })

function textOf(content: readonly { type: string }[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('')
}

class FakeSession implements AgentSession {
  readonly prompts: string[] = []
  #closed = false
  readonly resumed: boolean
  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly info: Record<string, unknown>,
    private readonly handlers: AgentSessionHandlers,
    readonly capabilities: AcpCapabilities,
    private readonly running: () => boolean,
    resumed = false,
  ) {
    this.resumed = resumed
  }
  get closed(): boolean {
    return this.#closed || !this.running()
  }
  prompt(content: readonly { type: string }[], signal?: AbortSignal): Promise<AgentStopReason> {
    const text = textOf(content)
    this.prompts.push(text)
    if (signal?.aborted) return Promise.resolve('cancelled')
    this.handlers.onUpdate({ kind: 'text', text: `echo:${text}` })
    return Promise.resolve('end_turn')
  }
  cancel(): void {}
  close(): Promise<void> {
    this.#closed = true
    return Promise.resolve()
  }
  setConfigOption(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeBackend implements AcpAgentBackend {
  readonly sessions: FakeSession[] = []
  readonly resumedSessions: string[] = []
  #counter = 0
  resumeFails = false
  running = true
  capabilities: AcpCapabilities = {
    ...EMPTY_CAPABILITIES,
    protocolVersion: 1,
    session: { load: true, resume: true, close: true, list: false, delete: false },
  }
  createSession(input: { cwd: string; handlers: AgentSessionHandlers }): Promise<AgentSession> {
    const session = new FakeSession(
      `fake-${++this.#counter}`,
      input.cwd,
      { configOptions: [] },
      input.handlers,
      this.capabilities,
      () => this.running,
    )
    this.sessions.push(session)
    return Promise.resolve(session)
  }
  resumeSession(input: { cwd: string; sessionId: string; handlers: AgentSessionHandlers }): Promise<AgentSession> {
    if (!this.capabilities.session.load && !this.capabilities.session.resume) {
      return Promise.reject(new UnsupportedAcpError('the agent advertises neither load nor resume'))
    }
    if (this.resumeFails) return Promise.reject(new UnsupportedAcpError('resume failed in test'))
    this.resumedSessions.push(input.sessionId)
    const session = new FakeSession(
      input.sessionId,
      input.cwd,
      { configOptions: [] },
      input.handlers,
      this.capabilities,
      () => this.running,
      true,
    )
    this.sessions.push(session)
    return Promise.resolve(session)
  }
  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

function make(config: Partial<AgyConfig> = {}) {
  const backend = new FakeBackend()
  const continuity = new SessionContinuity(backend, { ...DEFAULT_CONFIG, ...config }, silentLogger)
  return { backend, continuity }
}

interface RunOverrides {
  dshSessionId?: string
  signal?: AbortSignal
  onUpdate?: (update: AgentUpdate) => void
  configureSession?: (session: AgentSession, resumed: boolean) => Promise<void>
}

async function run(
  continuity: SessionContinuity,
  messages: MessageLike[],
  overrides: RunOverrides = {},
): Promise<{ text: string; updates: AgentUpdate[]; result: Awaited<ReturnType<SessionContinuity['run']>> }> {
  let text = ''
  const updates: AgentUpdate[] = []
  const result = await continuity.run({
    dshSessionId: overrides.dshSessionId ?? 'dsh-1',
    cwd: '/tmp',
    model: 'gemini-4-argon',
    messages,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    onUpdate: (update) => {
      updates.push(update)
      if (update.kind === 'text') text += update.text
      overrides.onUpdate?.(update)
    },
    onPermission: async () => ({ outcome: 'cancelled' }),
    assistantText: () => text,
    configureSession: overrides.configureSession ?? (async () => {}),
  })
  return { text, updates, result }
}

describe('session continuity', () => {
  test('reuses one ACP session and sends only the new tail', async () => {
    const { backend, continuity } = make()
    const first = await run(continuity, [user('one')])
    expect(first.result.reused).toBe(false)
    expect(first.result.acpSessionId).toBe('fake-1')

    const second = await run(continuity, [user('one'), assistant('echo:one'), user('two')])
    expect(second.result.reused).toBe(true)
    expect(second.result.acpSessionId).toBe('fake-1')
    expect(second.text).toBe('echo:two')
    expect(backend.sessions).toHaveLength(1)
    expect(backend.sessions[0]!.prompts).toEqual(['one', 'two'])
    expect(continuity.stats).toMatchObject({ created: 1, reused: 1 })
  })

  test('replays the whole conversation when the history prefix diverges', async () => {
    const { backend, continuity } = make()
    await run(continuity, [user('one')])
    const second = await run(continuity, [user('different'), assistant('echo:one'), user('two')])
    expect(second.result.reused).toBe(false)
    expect(second.result.acpSessionId).toBe('fake-2')
    expect(second.text).toContain('<conversation_so_far>')
    expect(second.text).toContain('different')
    expect(backend.sessions).toHaveLength(2)
    expect(backend.sessions[0]!.closed).toBe(true)
  })

  test('replays when dsh rewrote the assistant message', async () => {
    const { backend, continuity } = make()
    await run(continuity, [user('one')])
    const second = await run(continuity, [user('one'), assistant('tampered'), user('two')])
    expect(second.result.acpSessionId).toBe('fake-2')
    expect(backend.sessions).toHaveLength(2)
  })

  test('keeps concurrent dsh sessions isolated', async () => {
    const { backend, continuity } = make()
    const [a, b] = await Promise.all([
      run(continuity, [user('alpha')], { dshSessionId: 'dsh-a' }),
      run(continuity, [user('bravo')], { dshSessionId: 'dsh-b' }),
    ])
    expect(a.result.acpSessionId).not.toBe(b.result.acpSessionId)
    expect(a.text).toBe('echo:alpha')
    expect(b.text).toBe('echo:bravo')
    expect(backend.sessions).toHaveLength(2)
  })

  test('resumes a session after the owning process died', async () => {
    const { backend, continuity } = make()
    await run(continuity, [user('one')])
    await backend.sessions[0]!.close()

    const second = await run(continuity, [user('one'), assistant('echo:one'), user('two')])
    expect(second.result.resumed).toBe(true)
    expect(second.result.reused).toBe(true)
    expect(second.result.acpSessionId).toBe('fake-1')
    expect(second.text).toBe('echo:two')
    expect(backend.resumedSessions).toEqual(['fake-1'])
  })

  test('configureSession is told when a session was resumed', async () => {
    const { backend, continuity } = make()
    const calls: boolean[] = []
    const configureSession = async (_session: AgentSession, resumed: boolean) => {
      calls.push(resumed)
    }
    await run(continuity, [user('one')], { configureSession })
    await backend.sessions[0]!.close()
    await run(continuity, [user('one'), assistant('echo:one'), user('two')], { configureSession })
    expect(calls).toEqual([false, true])
  })

  test('a stopped backend process invalidates its sessions', async () => {
    const { backend, continuity } = make()
    await run(continuity, [user('one')])
    backend.running = false
    backend.capabilities = { ...EMPTY_CAPABILITIES, protocolVersion: 1 }

    const second = await run(continuity, [user('one'), assistant('echo:one'), user('two')])
    expect(second.result.acpSessionId).toBe('fake-2')
    expect(second.result.reused).toBe(false)
  })

  test('falls back to a full replay when resume fails', async () => {
    const { backend, continuity } = make()
    await run(continuity, [user('one')])
    await backend.sessions[0]!.close()
    backend.resumeFails = true

    const second = await run(continuity, [user('one'), assistant('echo:one'), user('two')])
    expect(second.result.resumed).toBe(false)
    expect(second.result.reused).toBe(false)
    expect(second.result.acpSessionId).toBe('fake-2')
    expect(second.text).toContain('<conversation_so_far>')
  })

  test('does not attempt resume when the agent does not advertise it', async () => {
    const { backend, continuity } = make()
    backend.capabilities = { ...EMPTY_CAPABILITIES, protocolVersion: 1 }
    await run(continuity, [user('one')])
    await backend.sessions[0]!.close()

    const second = await run(continuity, [user('one'), assistant('echo:one'), user('two')])
    expect(second.result.acpSessionId).toBe('fake-2')
    expect(backend.resumedSessions).toEqual([])
  })

  test('evicts the least-recently-used session when maxSessions is exceeded', async () => {
    const { backend, continuity } = make({ maxSessions: 1 })
    await run(continuity, [user('one')], { dshSessionId: 'dsh-a' })
    await run(continuity, [user('two')], { dshSessionId: 'dsh-b' })
    expect(continuity.sessionCount).toBe(1)
    expect(backend.sessions[0]!.closed).toBe(true)
    expect(backend.sessions[1]!.closed).toBe(false)
  })

  test('an already-aborted signal never creates a session', async () => {
    const { backend, continuity } = make()
    const controller = new AbortController()
    controller.abort()
    await expect(run(continuity, [user('one')], { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError)
    expect(backend.sessions).toHaveLength(0)
  })

  test('sessionContinuity: false uses an ephemeral session per call', async () => {
    const { backend, continuity } = make({ sessionContinuity: false })
    const first = await run(continuity, [user('one')])
    const second = await run(continuity, [user('one'), assistant('echo:one'), user('two')])
    expect(first.result.acpSessionId).toBe('fake-1')
    expect(second.result.acpSessionId).toBe('fake-2')
    expect(backend.sessions[0]!.closed).toBe(true)
    expect(backend.sessions[1]!.closed).toBe(true)
  })

  test('closeAll closes every persistent session', async () => {
    const { backend, continuity } = make()
    await run(continuity, [user('one')], { dshSessionId: 'dsh-a' })
    await run(continuity, [user('two')], { dshSessionId: 'dsh-b' })
    await continuity.closeAll()
    expect(continuity.sessionCount).toBe(0)
    expect(backend.sessions.every((s) => s.closed)).toBe(true)
  })
})
