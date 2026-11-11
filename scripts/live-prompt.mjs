import { AcpProcess } from '../lib/types/acp-process.js'
import { AgyAcpAdapter } from '../lib/types/adapter.js'
import { resolveConfig } from '../lib/types/config.js'
import { createLogger } from '../lib/types/log.js'

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
try {
  let text = ''
  for await (const chunk of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi in one short sentence.' }] }],
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
  console.log('TEXT_LENGTH', text.length)
} catch (e) {
  console.error('FAILED', e)
} finally {
  await proc.dispose()
}
