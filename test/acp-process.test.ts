import { afterEach, describe, expect, test } from "bun:test"
import { AcpProcess } from "../src/acp-process.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import {
  AuthRequiredError,
  CliMissingError,
  ProcessExitedError,
  ProtocolError,
  RequestTimeoutError,
  StartupTimeoutError,
  UnsupportedAcpError,
} from "../src/errors.js"
import { chooseOutcome } from "../src/permission.js"
import { silentLogger } from "../src/log.js"
import { collector, mockConfig, newProc } from "./helpers.js"

const procs: AcpProcess[] = []
const make = (scenario = "", overrides = {}) => {
  const p = newProc(scenario, overrides)
  procs.push(p)
  return p
}
afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.dispose()))
})

describe("startup and initialization", () => {
  test("spawns the ACP subprocess and completes initialize", async () => {
    const p = make()
    expect(p.running).toBe(false)
    await p.ensureStarted()
    expect(p.running).toBe(true)
  })

  test("missing Antigravity CLI fails clearly (no fallback) — repeatedly, regardless of event ordering", async () => {
    for (let i = 0; i < 8; i++) {
      const p = new AcpProcess({ ...DEFAULT_CONFIG, command: "/nonexistent/definitely-not-agy" }, silentLogger)
      procs.push(p)
      const err = await p.ensureStarted().catch((e) => e)
      expect(err).toBeInstanceOf(CliMissingError)
      expect(String(err.message)).toContain("/nonexistent/definitely-not-agy")
    }
  })

  test("a non-executable file is also reported as a missing/unusable CLI", async () => {
    const p = new AcpProcess({ ...DEFAULT_CONFIG, command: "/etc/hostname" }, silentLogger)
    procs.push(p)
    expect(await p.ensureStarted().catch((e) => e)).toBeInstanceOf(CliMissingError)
  })

  test("CLI that exits instead of serving ACP is reported as unsupported, with stderr", async () => {
    const p = make("exit-early")
    const err = await p.ensureStarted().catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedAcpError)
    expect(err.message).toContain('unknown command "acp"')
  })

  test("a server that never answers initialize hits the startup timeout and is killed", async () => {
    const p = make("slow-init", { startupTimeoutMs: 400 })
    const err = await p.ensureStarted().catch((e) => e)
    expect(err).toBeInstanceOf(StartupTimeoutError)
    expect(p.running).toBe(false)
  })

  test("malformed initialize result is rejected", async () => {
    const p = make("bad-init")
    const err = await p.ensureStarted().catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedAcpError)
  })
})

describe("sessions and streaming", () => {
  test("creates a session and reports the models the server advertises", async () => {
    const p = make()
    const { handlers } = collector()
    const s = await p.openSession(process.cwd(), handlers)
    expect(s.sessionId).toMatch(/^mock-/)
    const ids = ((s.response.models as { availableModels: Array<{ modelId: string }> }).availableModels).map((m) => m.modelId)
    expect(ids).toContain("gemini-4-argon-medium")
    await s.close()
  })

  test("streams text, thought and tool-call updates in order, then stops with end_turn", async () => {
    const p = make()
    const { handlers, got } = collector()
    const s = await p.openSession(process.cwd(), handlers)
    const stop = await s.prompt("hello there")
    expect(stop).toBe("end_turn")
    expect(got.text()).toContain("Hello, world!")
    expect(got.text()).toContain("[echo:hello there]")
    const kinds = got.updates.map((u) => u.sessionUpdate)
    expect(kinds).toContain("agent_thought_chunk")
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_call_update"))
    const done = got.updates.find((u) => u.sessionUpdate === "tool_call_update") as { status?: string }
    expect(done.status).toBe("completed")
    await s.close()
  })

  test("applies model selection through session/set_config_option", async () => {
    const p = make()
    const { handlers, got } = collector()
    const s = await p.openSession(process.cwd(), handlers)
    await s.setConfigOption("model", "gemini-3.8-flash")
    await s.setConfigOption("thought_level", "low")
    await s.prompt("x")
    expect(got.text()).toContain("[model:gemini-3.8-flash+low]")
  })

  test("multiple concurrent sessions on one process do not cross-talk", async () => {
    const p = make()
    const runs = await Promise.all(
      ["alpha", "bravo", "charlie", "delta"].map(async (word) => {
        const c = collector()
        const s = await p.openSession(process.cwd(), c.handlers)
        await s.prompt(word)
        const text = c.got.text()
        await s.close()
        return { word, text }
      }),
    )
    for (const r of runs) {
      expect(r.text).toContain(`[echo:${r.word}]`)
      for (const other of runs) if (other !== r) expect(r.text).not.toContain(`[echo:${other.word}]`)
    }
    expect(p.activeSessions).toBe(0)
  })

  test("authentication errors become AuthRequiredError that points to the CLI login", async () => {
    const p = make("auth-required")
    const err = await p.openSession(process.cwd(), collector().handlers).catch((e) => e)
    expect(err).toBeInstanceOf(AuthRequiredError)
    expect(err.message).toContain("agy")
  })
})

describe("permissions", () => {
  const options = [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]

  test("approval selects allow_once and the agent proceeds", async () => {
    const p = make("permission")
    const c = collector(async (req) => chooseOutcome("allow-once", true, req.options))
    const s = await p.openSession(process.cwd(), c.handlers)
    await s.prompt("write it")
    expect(c.got.permissions).toHaveLength(1)
    expect(c.got.permissions[0]!.toolCall.kind).toBe("edit")
    expect(c.got.text()).toContain("permission:allow")
    expect(c.got.text()).not.toContain("permission:always")
  })

  test("denial selects reject_once and the tool call fails", async () => {
    const p = make("permission")
    const c = collector(async (req) => chooseOutcome("allow-once", false, req.options))
    const s = await p.openSession(process.cwd(), c.handlers)
    await s.prompt("write it")
    expect(c.got.text()).toContain("permission:reject")
    const update = c.got.updates.filter((u) => u.sessionUpdate === "tool_call_update").pop() as { status?: string }
    expect(update.status).toBe("failed")
  })

  test("a session handler that throws fails closed (cancelled), never approved", async () => {
    const p = make("permission")
    const c = collector(async () => {
      throw new Error("boom")
    })
    const s = await p.openSession(process.cwd(), c.handlers)
    await s.prompt("write it")
    expect(c.got.text()).toContain("permission:cancelled")
  })

  test("when only allow_always is offered, allow-once policy does not escalate to it", async () => {
    const p = make("permission-only-always")
    const c = collector(async (req) => chooseOutcome("allow-once", true, req.options))
    const s = await p.openSession(process.cwd(), c.handlers)
    await s.prompt("write it")
    expect(c.got.text()).toContain("permission:cancelled")
  })

  test("chooseOutcome never approves on denial and honours reject mode", () => {
    expect(chooseOutcome("allow-once", false, options)).toEqual({ outcome: "selected", optionId: "reject" })
    expect(chooseOutcome("allow-once", true, options)).toEqual({ outcome: "selected", optionId: "allow" })
    expect(chooseOutcome("allow-always", true, options)).toEqual({ outcome: "selected", optionId: "always" })
    expect(chooseOutcome("reject", true, options)).toEqual({ outcome: "selected", optionId: "reject" })
    expect(chooseOutcome("allow-once", false, [{ optionId: "a", kind: "allow_once" }])).toEqual({ outcome: "cancelled" })
  })
})

describe("cancellation", () => {
  test("aborting the signal sends session/cancel and resolves with stopReason cancelled", async () => {
    const p = make("hang")
    const c = collector()
    const s = await p.openSession(process.cwd(), c.handlers)
    const ac = new AbortController()
    const run = s.prompt("long job", ac.signal)
    await Bun.sleep(150)
    const t0 = Date.now()
    ac.abort()
    expect(await run).toBe("cancelled")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test("an already-aborted signal cancels immediately", async () => {
    const p = make("hang")
    const s = await p.openSession(process.cwd(), collector().handlers)
    const ac = new AbortController()
    ac.abort()
    expect(await s.prompt("x", ac.signal)).toBe("cancelled")
  })

  test("cancellation releases a pending permission prompt immediately", async () => {
    const p = make("permission")
    let sawAbort = false
    const c = collector(
      (_req, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true
            resolve({ outcome: "cancelled" })
          })
        }),
    )
    const s = await p.openSession(process.cwd(), c.handlers)
    const ac = new AbortController()
    const run = s.prompt("write", ac.signal)
    await Bun.sleep(200)
    ac.abort()
    const stop = await run
    expect(sawAbort).toBe(true)
    expect(stop).toBe("cancelled")
  })

  test("an agent that ignores cancel does not hang the caller forever", async () => {
    const p = make("ignore-cancel")
    const s = await p.openSession(process.cwd(), collector().handlers)
    const ac = new AbortController()
    const run = s.prompt("x", ac.signal)
    await Bun.sleep(100)
    ac.abort()
    // After the grace period the caller is released with "cancelled" even though the agent never acknowledged it.
    const t0 = Date.now()
    expect(await run).toBe("cancelled")
    expect(Date.now() - t0).toBeLessThan(8_000)
  }, 15_000)

  test("inactivity during a turn raises a request timeout", async () => {
    const p = make("ignore-cancel", { requestTimeoutMs: 400 })
    const s = await p.openSession(process.cwd(), collector().handlers)
    const err = await s.prompt("x").catch((e) => e)
    expect(err).toBeInstanceOf(RequestTimeoutError)
  }, 15_000)
})

describe("failure handling", () => {
  test("a crash mid-prompt rejects with ProcessExitedError and the next use reconnects", async () => {
    const p = make("crash")
    const c = collector()
    const s = await p.openSession(process.cwd(), c.handlers)
    const err = await s.prompt("boom").catch((e) => e)
    expect(err).toBeInstanceOf(ProcessExitedError)
    expect(c.got.text()).toContain("partial")
    expect(p.running).toBe(false)

    // Reconnect: next process behaves normally.
    process.env.MOCK_SCENARIO = ""
    const again = collector()
    const s2 = await p.openSession(process.cwd(), again.handlers)
    expect(await s2.prompt("recovered")).toBe("end_turn")
    expect(again.got.text()).toContain("[echo:recovered]")
  })

  test("loadSession routes replayed history updates to the raw handlers", async () => {
    const p = make("load-session")
    const c = collector()
    const s = await p.loadSession(process.cwd(), "loaded-1", c.handlers)
    expect(s.sessionId).toBe("loaded-1")
    expect(s.resumed).toBe(true)
    expect(c.got.updates.some((u) => u.sessionUpdate === "user_message_chunk")).toBe(true)
    await s.close()
  })

  test("a crashed process releases its session ids so session/load can reuse them", async () => {
    const p = make("crash")
    const s = await p.openSession(process.cwd(), collector().handlers)
    const id = s.sessionId
    await s.prompt("boom").catch(() => {})
    expect(p.running).toBe(false)

    process.env.MOCK_SCENARIO = "load-session"
    const loaded = await p.loadSession(process.cwd(), id, collector().handlers)
    expect(loaded.sessionId).toBe(id)
    expect(loaded.resumed).toBe(true)
    await loaded.close()
  })

  test("malformed session/new result is a ProtocolError", async () => {
    const p = make("bad-session")
    const err = await p.openSession(process.cwd(), collector().handlers).catch((e) => e)
    expect(err).toBeInstanceOf(ProtocolError)
  })

  test("non-JSON noise on the protocol channel is survived (SDK answers with a parse error)", async () => {
    const p = make("junk-stdout")
    const c = collector()
    const s = await p.openSession(process.cwd(), c.handlers)
    expect(await s.prompt("still works")).toBe("end_turn")
  })

  test("stderr is drained separately and never corrupts the protocol stream", async () => {
    const p = make("stderr-noise")
    const c = collector()
    const s = await p.openSession(process.cwd(), c.handlers)
    expect(await s.prompt("noisy")).toBe("end_turn")
    expect(c.got.text()).toContain("Hello, world!")
  })
})

describe("cleanup", () => {
  test("dispose terminates the subprocess and is idempotent", async () => {
    const p = make()
    await p.ensureStarted()
    const pidsBefore = await childPids()
    expect(pidsBefore.length).toBeGreaterThan(0)
    await p.dispose()
    await p.dispose()
    expect(p.disposed).toBe(true)
    expect(p.running).toBe(false)
    await Bun.sleep(100)
    expect((await childPids()).filter((pid) => pidsBefore.includes(pid))).toHaveLength(0)
    await expect(p.ensureStarted()).rejects.toThrow(/disposed/)
  })

  test("closing a session releases it; an idle process stops itself and restarts on demand", async () => {
    const p = make("", { idleTimeoutMs: 200 })
    const s = await p.openSession(process.cwd(), collector().handlers)
    expect(p.activeSessions).toBe(1)
    await s.close()
    expect(p.activeSessions).toBe(0)
    await Bun.sleep(700)
    expect(p.running).toBe(false)
    const s2 = await p.openSession(process.cwd(), collector().handlers)
    expect(await s2.prompt("again")).toBe("end_turn")
  })

  test("dispose while a prompt is in flight unblocks the caller", async () => {
    const p = make("hang")
    const s = await p.openSession(process.cwd(), collector().handlers)
    const run = s.prompt("x").catch((e) => e)
    await Bun.sleep(100)
    await p.dispose()
    const result = await run
    expect(result instanceof Error || result === "cancelled").toBe(true)
  })

  test("stderr that looks like a bearer token is redacted before it reaches errors/logs", async () => {
    const p = make("secret-stderr,exit-early")
    const err = await p.ensureStarted().catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedAcpError)
    expect(String(err.message)).not.toContain("ya29.FAKE_TOKEN_VALUE")
  })
})

async function childPids(): Promise<number[]> {
  const proc = Bun.spawn(["pgrep", "-f", "test/mock-agent.ts"], { stdout: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.split("\n").map((s) => Number(s.trim())).filter((n) => n > 0 && n !== process.pid)
}
