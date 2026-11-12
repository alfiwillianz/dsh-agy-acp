import { AcpProcess } from '../lib/types/acp-process.js'
import { AgyAcpAdapter } from '../lib/types/adapter.js'
import { resolveConfig } from '../lib/types/config.js'
import { createLogger } from '../lib/types/log.js'

/**
 * Manual live check: two turns in one dsh session.
 *
 * The first turn creates the ACP session; the second should reuse it and send only the new user message. This
 * script uses a fake dsh session id (no live dsh agent), so structured records and the approval seam are skipped;
 * it is a transport/continuity smoke test, not a full dsh integration test.
 */
const config = resolveConfig({
  debug: false,
  sessionMode: 'default',
  startupTimeoutMs: 20000,
  requestTimeoutMs: 60000,
})
const log = createLogger({ debug: false })
const proc = new AcpProcess(config, log)
const ctx = {
  get: (name) =>
    name === 'approval'
      ? {
          request: async () => {
            console.log('\n[approval requested]')
            return 'allowed-once'
          },
        }
      : undefined,
}
const adapter = new AgyAcpAdapter(ctx, config, proc, log)

async function turn(messages, signal) {
  let text = ''
  for await (const chunk of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'live-script',
    messages,
    signal,
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      process.stdout.write(chunk.text)
    } else if (chunk.type === 'reasoning-delta') {
      process.stderr.write(chunk.text)
    } else if (chunk.type === 'finish') {
      console.log('\nFINISH', JSON.stringify(chunk.reason))
    }
  }
  return text
}

const firstPrompt = 'Say hi in one short sentence.'
try {
  const first = await turn([{ role: 'user', content: [{ type: 'text', text: firstPrompt }] }])
  console.log('\nACTIVE_SESSIONS_AFTER_FIRST', proc.activeSessions)
  if (first.length === 0) throw new Error('the first turn produced no text; cannot exercise continuity')

  const second = await turn([
    { role: 'user', content: [{ type: 'text', text: firstPrompt }] },
    { role: 'assistant', content: [{ type: 'text', text: first }] },
    { role: 'user', content: [{ type: 'text', text: 'Now say goodbye in one short sentence.' }] },
  ])
  console.log('\nACTIVE_SESSIONS_AFTER_SECOND', proc.activeSessions)
  console.log('SECOND_TURN_TEXT_LENGTH', second.length)
} catch (e) {
  console.error('FAILED', e)
} finally {
  await adapter.dispose()
}
