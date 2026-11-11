import { describe, expect, test } from 'bun:test'
import { redact } from '../src/log.js'

describe('redact', () => {
  test('masks bearer tokens and Google token prefixes', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]')
    expect(redact('token=ya29.FAKE_TOKEN_VALUE_1234567890')).toBe('token=[redacted]')
  })

  test('masks access/refresh token assignments', () => {
    expect(redact('access_token="abcdef123456"')).toBe('access_token="[redacted]"')
    expect(redact('refresh_token: abcdef123456')).toBe('refresh_token: [redacted]')
  })

  test('masks account email addresses printed by the CLI', () => {
    expect(redact('authenticated as alfi@example.com')).toBe('authenticated as [redacted-email]')
  })

  test('leaves ordinary diagnostics alone', () => {
    expect(redact('session/new took 12ms')).toBe('session/new took 12ms')
  })
})
