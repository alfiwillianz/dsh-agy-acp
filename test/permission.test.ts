import { describe, expect, test } from 'bun:test'
import { chooseOutcome, describeToolCall } from '../src/permission.js'

const options = [
  { optionId: 'allow', kind: 'allow_once' as const },
  { optionId: 'always', kind: 'allow_always' as const },
  { optionId: 'reject', kind: 'reject_once' as const },
]

describe('chooseOutcome', () => {
  test('approval selects allow_once by default', () => {
    expect(chooseOutcome('allow-once', true, options)).toEqual({ outcome: 'selected', optionId: 'allow' })
  })

  test('denial never selects an allow option', () => {
    expect(chooseOutcome('allow-once', false, options)).toEqual({ outcome: 'selected', optionId: 'reject' })
  })

  test('allow-always is an explicit opt-in', () => {
    expect(chooseOutcome('allow-always', true, options)).toEqual({ outcome: 'selected', optionId: 'always' })
  })

  test('reject mode denies even approved requests', () => {
    expect(chooseOutcome('reject', true, options)).toEqual({ outcome: 'selected', optionId: 'reject' })
  })

  test('allow-once does not escalate when only allow_always is offered', () => {
    expect(chooseOutcome('allow-once', true, [{ optionId: 'a', kind: 'allow_once' }])).toEqual({
      outcome: 'selected',
      optionId: 'a',
    })
    expect(chooseOutcome('allow-once', true, [{ optionId: 'always', kind: 'allow_always' }])).toEqual({
      outcome: 'cancelled',
    })
  })

  test('a denial without a reject option cancels', () => {
    expect(chooseOutcome('allow-once', false, [{ optionId: 'a', kind: 'allow_once' }])).toEqual({
      outcome: 'cancelled',
    })
  })
})

describe('describeToolCall', () => {
  test('execute maps to bash with the command in the reason', () => {
    expect(
      describeToolCall({ kind: 'execute', title: 'Run tests', rawInput: { command: 'bun test' } }),
    ).toEqual({ toolName: 'bash', reason: 'Antigravity wants to run: bun test' })
  })

  test('edit maps to edit with the paths in the reason', () => {
    expect(
      describeToolCall({ kind: 'edit', title: 'Write file', locations: [{ path: '/tmp/a.txt' }] }),
    ).toEqual({ toolName: 'edit', reason: 'Antigravity wants to edit /tmp/a.txt' })
  })

  test('read maps to read', () => {
    expect(describeToolCall({ kind: 'read', locations: [{ path: '/tmp/a.txt' }] })).toEqual({
      toolName: 'read',
      reason: 'Antigravity wants to read /tmp/a.txt',
    })
  })

  test('fetch maps to web_fetch with the url', () => {
    expect(describeToolCall({ kind: 'fetch', rawInput: { url: 'https://example.com' } })).toEqual({
      toolName: 'web_fetch',
      reason: 'Antigravity wants to fetch: https://example.com',
    })
  })

  test('unknown kinds get a namespaced tool name and the title', () => {
    expect(describeToolCall({ kind: 'weird kind', title: 'Something' })).toEqual({
      toolName: 'agy_weird_kind',
      reason: 'Something',
    })
  })
})
