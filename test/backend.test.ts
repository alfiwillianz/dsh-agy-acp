import { afterEach, describe, expect, test } from 'bun:test'
import { AcpAgentBackendImpl } from '../src/acp-backend.js'
import { AcpProcess, normalizeCapabilities } from '../src/acp-process.js'
import type { AgentPermissionRequest, AgentUpdate } from '../src/backend.js'
import { UnsupportedAcpError } from '../src/errors.js'
import { translateUpdate } from '../src/events.js'
import { silentLogger } from '../src/log.js'
import { newProc } from './helpers.js'

const procs: AcpProcess[] = []
function make(scenario = '') {
  const proc = newProc(scenario)
  procs.push(proc)
  return { proc, backend: new AcpAgentBackendImpl(proc, silentLogger) }
}

afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.dispose()))
})

function collector() {
  const updates: AgentUpdate[] = []
  const permissions: AgentPermissionRequest[] = []
  return {
    updates,
    permissions,
    handlers: {
      onUpdate: (u: AgentUpdate) => void updates.push(u),
      onPermission: async (r: AgentPermissionRequest) => {
        permissions.push(r)
        return { outcome: 'selected' as const, optionId: 'allow' }
      },
    },
  }
}

describe('capability normalization', () => {
  test('an empty initialize result advertises nothing', () => {
    const caps = normalizeCapabilities({ protocolVersion: 1 })
    expect(caps.session).toEqual({ load: false, resume: false, close: false, list: false, delete: false })
    expect(caps.prompt).toEqual({ image: false, audio: false, embeddedContext: false })
  })

  test('present capabilities are reported, absent ones stay negative', () => {
    const caps = normalizeCapabilities({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, list: {} },
        mcpCapabilities: { http: true },
      },
    })
    expect(caps.session).toEqual({ load: true, resume: true, close: true, list: true, delete: false })
    expect(caps.prompt).toEqual({ image: true, audio: false, embeddedContext: true })
    expect(caps.mcp).toEqual({ http: true, sse: false })
  })

  test('null session capabilities are negative', () => {
    const caps = normalizeCapabilities({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: null, close: null } },
    })
    expect(caps.session.resume).toBe(false)
    expect(caps.session.close).toBe(false)
  })
})

describe('session update translation', () => {
  test('text and reasoning chunks', () => {
    expect(
      translateUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as never),
    ).toEqual({ kind: 'text', text: 'hi' })
    expect(
      translateUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } } as never),
    ).toEqual({ kind: 'reasoning', text: 'think' })
  })

  test('image chunks preserve bytes and media type', () => {
    expect(
      translateUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      } as never),
    ).toEqual({ kind: 'image', data: 'AAAA', mimeType: 'image/png' })
  })

  test('tool calls and updates preserve structure and output text', () => {
    const call = translateUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read file',
      name: 'read',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/tmp/a' }],
      rawInput: { path: '/tmp/a' },
    } as never)
    expect(call).toMatchObject({
      kind: 'tool-call',
      id: 't1',
      name: 'read',
      title: 'Read file',
      toolKind: 'read',
      status: 'in_progress',
      locations: ['/tmp/a'],
    })

    const update = translateUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'file body' } },
        { type: 'diff', path: '/tmp/a' },
        { type: 'terminal', terminalId: 'term-1' },
      ],
    } as never)
    expect(update).toMatchObject({
      kind: 'tool-update',
      id: 't1',
      status: 'completed',
      output: 'file body\ndiff: /tmp/a\n[terminal term-1]',
      contentKinds: ['text', 'diff', 'terminal'],
    })
  })

  test('plans, notices, usage and unknown updates are preserved', () => {
    expect(
      translateUpdate({
        sessionUpdate: 'plan',
        entries: [{ content: 'step', priority: 'high', status: 'pending' }],
      } as never),
    ).toEqual({ kind: 'plan', entries: [{ content: 'step', priority: 'high', status: 'pending' }] })
    expect(
      translateUpdate({ sessionUpdate: 'notice', severity: 'warning', title: 'Heads up', description: 'detail' } as never),
    ).toEqual({ kind: 'notice', severity: 'warning', title: 'Heads up', description: 'detail' })
    expect(translateUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100 } as never)).toEqual({
      kind: 'usage',
      used: 10,
      size: 100,
    })
    expect(translateUpdate({ sessionUpdate: 'brand_new_thing', value: 1 } as never)).toMatchObject({
      kind: 'unknown',
      type: 'brand_new_thing',
    })
  })
})

describe('AcpAgentBackend', () => {
  test('createSession exposes the negotiated capabilities', async () => {
    const { backend } = make()
    const c = collector()
    const session = await backend.createSession({ cwd: process.cwd(), handlers: c.handlers })
    expect(session.id).toMatch(/^mock-/)
    expect(session.resumed).toBe(false)
    expect(session.capabilities.session.close).toBe(true)
    await session.close()
    expect(session.closed).toBe(true)
  })

  test('resumeSession throws a clear UnsupportedAcpError when neither load nor resume is advertised', async () => {
    const { backend } = make()
    const error = await backend
      .resumeSession({ cwd: process.cwd(), sessionId: 'missing', handlers: collector().handlers })
      .catch((e) => e)
    expect(error).toBeInstanceOf(UnsupportedAcpError)
    expect(error.message).toContain('neither')
  })

  test('resumeSession uses session/load without leaking replayed history into the live stream', async () => {
    const { backend } = make('load-session')
    const c = collector()
    const session = await backend.resumeSession({ cwd: process.cwd(), sessionId: 'loaded-1', handlers: c.handlers })
    expect(session.id).toBe('loaded-1')
    expect(session.resumed).toBe(true)
    expect(c.updates).toHaveLength(0)
    await session.close()
  })

  test('resumeSession uses session/resume when load is absent', async () => {
    const { backend } = make('resume-session')
    const c = collector()
    const session = await backend.resumeSession({ cwd: process.cwd(), sessionId: 'resumed-1', handlers: c.handlers })
    expect(session.id).toBe('resumed-1')
    expect(session.resumed).toBe(true)
    expect(c.updates).toHaveLength(0)
    await session.close()
  })

  test('setMode applies the standard session mode', async () => {
    const { backend } = make('load-session,set-mode')
    const c = collector()
    const session = await backend.resumeSession({ cwd: process.cwd(), sessionId: 'loaded-1', handlers: c.handlers })
    await session.setMode?.('plan')
    expect(await session.prompt([{ type: 'text', text: 'x' }])).toBe('end_turn')
    expect(c.updates.some((u) => u.kind === 'text' && u.text.includes('[mode:plan]'))).toBe(true)
    await session.close()
  })

  test('permission requests reach the backend handler with a live abort signal', async () => {
    const { backend } = make('permission')
    const c = collector()
    const session = await backend.createSession({ cwd: process.cwd(), handlers: c.handlers })
    const stop = await session.prompt([{ type: 'text', text: 'write it' }])
    expect(stop).toBe('end_turn')
    expect(c.permissions).toHaveLength(1)
    expect(c.permissions[0]!.toolCall.kind).toBe('edit')
    expect(c.permissions[0]!.signal.aborted).toBe(false)
    expect(c.updates.some((u) => u.kind === 'text' && u.text.includes('permission:allow'))).toBe(true)
    await session.close()
  })
})
