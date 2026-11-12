#!/usr/bin/env bun
/**
 * Mock ACP agent used by the automated tests. Speaks real ACP over stdio through the official SDK (agent side),
 * so tests exercise the genuine wire protocol without Google credentials or network.
 *
 * Behaviour is selected with MOCK_SCENARIO (comma-separated flags):
 *   (default)       well-behaved agent
 *   exit-early      print usage to stderr and exit 2 before answering initialize   (unsupported `acp` command)
 *   slow-init       never answer initialize                                         (startup timeout)
 *   bad-init        answer initialize with a malformed result
 *   auth-required   session/new fails with JSON-RPC -32000
 *   bad-session     session/new returns a result without sessionId
 *   permission      prompt asks permission (write file) and reports the chosen option in the reply text
 *   permission-only-always   offers only an allow_always option
 *   hang            prompt never finishes until cancelled
 *   ignore-cancel   prompt never finishes, even when cancelled
 *   crash           exit(1) in the middle of a prompt
 *   junk-stdout     emit a non-JSON line on stdout before answering
 *   no-mode         do not offer a `mode` config option (restrictive session mode cannot be enforced)
 *   load-session    advertise `loadSession` and implement `session/load` (replays a user_message_chunk)
 *   resume-session  advertise `sessionCapabilities.resume` and implement `session/resume`
 *   set-mode        implement `session/set_mode`
 *   permission-after-prompt  send a permission request after the prompt settled (stale-request test)
 *   hang-once       the first prompt hangs until cancelled; later prompts behave normally
 *   stderr-noise    write diagnostics to stderr
 *   secret-stderr   write a fake bearer token to stderr (redaction test)
 */
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const flags = new Set((process.env.MOCK_SCENARIO ?? "").split(",").map((s) => s.trim()).filter(Boolean))
const log = (m: string) => process.stderr.write(`[mock-agent] ${m}\n`)

if (flags.has("exit-early")) {
  process.stderr.write("Error: unknown command \"acp\" for \"agy\"\nUsage: agy [flags]\n")
  process.exit(2)
}
if (flags.has("stderr-noise")) for (let i = 0; i < 50; i++) log(`noise line ${i}`)
if (flags.has("secret-stderr")) process.stderr.write("debug: Authorization: Bearer ya29.FAKE_TOKEN_VALUE_1234567890\n")

const MODELS = [
  { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
  { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { modelId: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
  { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]
const MODE_OPTION = {
  id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
  options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }, { value: "plan", name: "Plan" }],
}
const CONFIG_OPTIONS = [
  ...(flags.has("no-mode") ? [] : [MODE_OPTION]),
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-argon",
    options: [{ value: "gemini-4-argon", name: "Gemini 4 Argon" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "claude-sonnet-5-5", name: "Claude" }],
  },
  {
    id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "medium",
    options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
  },
]

const sessions = new Map<string, { cancelled: boolean; config: Record<string, string>; wake?: () => void; staleOutcome?: string; hungOnce?: boolean }>()
let counter = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const app = acp
  .agent({ name: "mock-agy" })
  .onRequest(acp.methods.agent.initialize, async () => {
    if (flags.has("slow-init")) await new Promise(() => {})
    if (flags.has("bad-init")) return { nope: true } as never
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "Mock Antigravity", version: "0.0.0-test" },
      agentCapabilities: {
        ...(flags.has("load-session") ? { loadSession: true } : {}),
        sessionCapabilities: {
          close: {},
          ...(flags.has("resume-session") ? { resume: {} } : {}),
        },
      },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
    }
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    if (flags.has("auth-required")) throw new acp.RequestError(-32000, "Authentication required")
    if (flags.has("junk-stdout")) process.stdout.write("this is not json-rpc\n")
    if (flags.has("bad-session")) return { models: {} } as never
    const sessionId = `mock-${++counter}`
    sessions.set(sessionId, { cancelled: false, config: {} })
    return {
      sessionId,
      models: { availableModels: MODELS, currentModelId: MODELS[0]!.modelId },
      configOptions: CONFIG_OPTIONS,
    } as never
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const p = ctx.params as unknown as { sessionId: string; cwd: string }
    sessions.set(p.sessionId, { cancelled: false, config: {} })
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: p.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed history" } },
    } as never)
    return {} as never
  })
  .onRequest(acp.methods.agent.session.resume, async (ctx) => {
    const p = ctx.params as unknown as { sessionId: string; cwd: string }
    sessions.set(p.sessionId, { cancelled: false, config: {} })
    return {} as never
  })
  .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    const p = ctx.params as unknown as { sessionId: string; modeId: string }
    const s = sessions.get(p.sessionId)
    if (!s) throw new acp.RequestError(-32002, "unknown session")
    s.config.mode = p.modeId
    return {} as never
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
    const p = ctx.params as unknown as { sessionId: string; configId: string; value: string }
    const s = sessions.get(p.sessionId)
    if (!s) throw new acp.RequestError(-32002, "unknown session")
    s.config[p.configId] = p.value
    return { configOptions: CONFIG_OPTIONS } as never
  })
  .onRequest(acp.methods.agent.session.close, async (ctx) => {
    sessions.delete((ctx.params as { sessionId: string }).sessionId)
    return {} as never
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    const s = sessions.get((ctx.params as { sessionId: string }).sessionId)
    if (s) {
      s.cancelled = true
      s.wake?.()
    }
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params as unknown as { sessionId: string; prompt: Array<{ type: string; text?: string }> }
    const s = sessions.get(sessionId)
    if (!s) throw new acp.RequestError(-32002, "unknown session")
    const text = prompt.map((b) => b.text ?? "").join("")
    const say = (t: string, kind: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk") =>
      ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: kind, content: { type: "text", text: t } },
      } as never)

    if (flags.has("crash")) {
      await say("partial")
      await sleep(30)
      process.exit(1)
    }
    if (flags.has("hang-once") && !s.hungOnce) {
      s.hungOnce = true
      await say(`working… [session:${sessionId}]`)
      await new Promise<void>((resolve) => {
        s.wake = resolve
        if (s.cancelled) resolve()
      })
      return { stopReason: "cancelled" }
    }
    if (flags.has("hang") || flags.has("ignore-cancel")) {
      await say("working…")
      if (flags.has("ignore-cancel")) await new Promise(() => {})
      await new Promise<void>((resolve) => {
        s.wake = resolve
        if (s.cancelled) resolve()
      })
      return { stopReason: "cancelled" }
    }

    if (flags.has("permission") || flags.has("permission-only-always")) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "tc-w", title: "Write notes.txt", kind: "edit", status: "pending", locations: [{ path: "/tmp/notes.txt" }] },
      } as never)
      const options = flags.has("permission-only-always")
        ? [{ optionId: "always", name: "Always allow", kind: "allow_always" }]
        : [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ]
      const res = (await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "tc-w", title: "Write notes.txt", kind: "edit", locations: [{ path: "/tmp/notes.txt" }] },
        options,
      } as never)) as { outcome: { outcome: string; optionId?: string } }
      const o = res.outcome
      const chosen = o.outcome === "selected" ? o.optionId : "cancelled"
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc-w", status: chosen === "allow" || chosen === "always" ? "completed" : "failed" },
      } as never)
      await say(`permission:${chosen}`)
      return { stopReason: s.cancelled ? "cancelled" : "end_turn" }
    }

    if (flags.has("permission-after-prompt")) {
      // Send a permission request after this prompt has settled. The client must reject it as stale instead of
      // asking the user for a turn that is already over.
      setTimeout(() => {
        void (async () => {
          try {
            const res = (await ctx.client.request(acp.methods.client.session.requestPermission, {
              sessionId,
              toolCall: { toolCallId: "tc-stale", title: "Stale write", kind: "edit", locations: [{ path: "/tmp/stale.txt" }] },
              options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
            } as never)) as { outcome: { outcome: string; optionId?: string } }
            s.staleOutcome = res.outcome.outcome === "selected" ? String(res.outcome.optionId) : res.outcome.outcome
          } catch {
            s.staleOutcome = "error"
          }
        })()
      }, 50)
    }

    // Default: stream text in chunks, with a thought, and a tool call that completes.
    await say("thinking about it", "agent_thought_chunk")
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read package.json", kind: "read", status: "in_progress", locations: [{ path: "/tmp/package.json" }], rawInput: { path: "/tmp/package.json" } },
    } as never)
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "{ \"name\": \"x\" }" } }] },
    } as never)
    const model = [s.config.model, s.config.thought_level].filter(Boolean).join("+")
    for (const part of ["Hello", ", ", "world", `! [echo:${text.slice(0, 80)}]`, model ? ` [model:${model}]` : "", ` [mode:${s.config.mode ?? "unset"}]`, ` [session:${sessionId}]`, s.staleOutcome ? ` [stale:${s.staleOutcome}]` : ""]) {
      if (!part) continue
      await say(part)
      await sleep(5)
    }
    return { stopReason: "end_turn" }
  })

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
)
const conn = app.connect(stream)
void conn.closed.then(() => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
