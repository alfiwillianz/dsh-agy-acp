# Architecture assessment: ACP as a first-class dsh execution backend

Status: assessment + implemented plugin-local backend. Verified against dsh `0.2.2-rc.1` and
`@agentclientprotocol/sdk` `2.4.0` (ACP v1 stable entrypoint). Everything marked **Proposed** is not a dsh API
today; everything else cites the package and type that actually exists.

## 1. Executive summary

dsh currently has exactly one way to talk to a model: the **LLM provider** seam (`@deepseek-ai/dsh-llm`,
`LlmAdapter`). The agent loop owns the turn/step loop, executes tools, and appends the durable session events.

An ACP agent is the opposite shape: it owns its own loop, executes its own tools, keeps its own session context,
and asks the *client* for permission. Adapting it to `LlmAdapter` works, but it is a compatibility layer:

- dsh expects a stateless completion endpoint; ACP exposes a stateful autonomous agent.
- dsh's `StreamChunk` has no "provider-executed tool" concept, so ACP tool activity is flattened to text.
- dsh re-sends the whole conversation on every model call; ACP sessions are stateful, so the old adapter created
  a fresh ACP session per call and replayed the transcript as text.
- dsh's loop would try to execute a `tool-call` chunk; the ACP agent already executed it.

**Recommendation:** introduce an **Agent Backend** abstraction upstream in dsh, alongside (not instead of) the LLM
provider abstraction. An agent backend owns a turn, executes tools, streams structured updates, and delegates
permission requests. The LLM provider seam stays for stateless completion providers and auxiliary calls.

Until that upstream seam exists, this plugin implements the backend boundary locally (`src/backend.ts`,
`src/acp-backend.ts`) and keeps `LlmAdapter` as the compatibility surface. The highest-value improvement that can
be made without upstream changes — **persistent ACP sessions with delta prompts and replay fallback** — is
implemented and tested.

## 2. What dsh actually provides (verified)

### 2.1 LLM provider seam

`@deepseek-ai/dsh-llm` exports:

- `abstract class LlmAdapter` with the required `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` and
  optional `providerInfo`, `listModels`, `resolveModel`, `prepareCall`, `providerRetryPolicy`,
  `imageRequestPricing`, `imageRequestTarget`.
- `LlmRuntime` (`ctx.llm`) with `registerAdapter(providers, adapter)`, `registerConfigurableProviders(entries)`,
  `listModels`, `resolveModelInfo`, `prepareCall`, and the `llm/stream` waterfall.
- `GenerateOptions` carries `provider`, `model`, `reasoningEffort`, `messages`, `system`, `tools`,
  `toolHistory`, `sessionId`, `purpose`, and `signal`.
- `StreamChunk` variants: `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`,
  `usage`, `finish`. `ContentBlockMap` is merge-extensible, but the loop treats `tool-call` blocks as work it must
  execute.
- `FinishReason` variants: `stop`, `tool-calls`, `max-tokens`, `aborted`, `error`.

The seam is explicitly provider-neutral and stateless: the loop builds each request from the session log. It has no
concept of a provider-owned execution loop.

### 2.2 Agent and loop

`@deepseek-ai/dsh-agent` exports:

- `interface Agent { readonly id: SessionId }`, augmented by `runtime-types.d.ts` with `options`, `session`,
  `model`, `inbox`, `status`, `ctx`, `cancel`, `whenIdle`, `runMaintenance`, `send`, `followup`, `steer`,
  `inject`.
- `class AgentRegistry` (`ctx.agents`) with `create`, `resume`, `register`, `enter`, `announce`, `get`, `list`,
  `roots`, `setFactory`, `turnBoundaryOf`, and the initiator scope.
- `interface AgentFactory` with `createAgent(ownerCtx, options)` and `resume(ownerCtx, options)`. The concrete
  factory is supplied by `@deepseek-ai/dsh-agent-loop` (`AgentLoop`).
- `CreateAgentOptions` / `ResumeAgentOptions` carry identity, parent, session metadata, seed, `agentOptions`, and a
  `setup` callback.

`@deepseek-ai/dsh-agent-loop` implements the loop (`ReactLoopAgent`). It owns turn/step boundaries, request
assembly from the session log, tool execution, and the inbox. **It is not a public extension point for an external
execution loop.** `AgentRegistry.setFactory` accepts one factory, and the loop registers it.

Consequence: an external ACP agent cannot "take over" an existing dsh agent today. The plugin can only run behind
the LLM adapter, or a new upstream backend seam is needed.

### 2.3 Session event sourcing

`@deepseek-ai/dsh-session` exports:

- `class Session` with `append(type, data, ...surfaceIntent)`, `snapshotEvents`, `requestHeader`, `surface`,
  `header`, and the `SessionEventMap`.
- Durable events include `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `developer/message`,
  `system/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `request/header`,
  `request/context`, and `session/end-seed`.
- `appendPluginRecord(session, type, data)` appends an **ignorable, non-surface** `plugin:*` record. It is the
  documented extension mechanism for plugin-owned state. `PluginRecordMap` is merge-extensible.
- `Session.append` is public. A backend that owns a turn can append `tool/call` / `tool/result` events directly,
  which is the cleanest way to preserve structured tool lifecycle without inventing a content block.

### 2.4 Approval seam

`@deepseek-ai/dsh-user-approval` exports:

- `ApprovalService` (`ctx.approval`) with `request(req: ApprovalRequest): Promise<ApprovalOutcome>`.
- `ApprovalRequest` carries `agent`, `toolName`, optional `callId`, optional `reason`, and optional `signal`.
- `ApprovalOutcome` is `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`. Only `'allowed-once'` is a
  grant; a missing/throwing answerer yields `'unavailable'` (fail closed).
- The service requires an open turn and a live agent; an idle ask rejects before appending audit events.

### 2.5 Other seams used by this plugin

- `ctx.workingDirectory.get(session)` (`@deepseek-ai/dsh-working-directory`) gives the session's effective cwd.
- `ctx.attachments` (`@deepseek-ai/dsh-attachment`) is optional and provides `readImage`, `saveImage`,
  `fileHostPath`, and `readFileStream`.
- `ctx.effect` and the Cordis plugin lifecycle (`name`, `inject`, `Config`, `apply`) mount and unload the plugin.

### 2.6 The reverse direction already exists

`@deepseek-ai/dsh-acp` is an **ACP server**: it exposes dsh agents to ACP clients. It creates agents through
`ctx.agents.create()` / `resume()`, drives them with `agent.send()`, listens to `session/event`, and translates
committed dsh events into ACP `session/update` notifications. It is a useful reference for the event vocabulary,
but it is not an ACP client and cannot be reused as an execution backend.

## 3. Why `LlmAdapter` is the wrong long-term home

| Concern | LLM provider | ACP agent |
|---|---|---|
| Turn ownership | dsh loop | ACP agent |
| Tool execution | dsh tools | ACP agent |
| Session state | derived from dsh log | owned by the agent |
| Request shape | full conversation each call | one new prompt per turn |
| Tool events | `tool-call` chunks the loop executes | `session/update` notifications |
| Permissions | dsh tool approval | ACP `session/request_permission` |
| Cancellation | abort the stream | `session/cancel` + prompt stop reason |
| Multimodal | provider content blocks | ACP content blocks + capabilities |

Forcing the right column through the left column loses information and creates artificial constraints. The
compatibility layer is still useful (it works today, and it keeps the model picker and session UI working), but it
should not be the architectural endpoint.

## 4. Proposed Agent Backend abstraction (upstream)

The following is a **proposal**, adapted to dsh's existing vocabulary. It is deliberately close to the interface
implemented in `src/backend.ts`, so the plugin can migrate without a rewrite.

### 4.1 Interface

```ts
// Proposed: @deepseek-ai/dsh-agent (or a new @deepseek-ai/dsh-agent-backend)
export interface AgentBackendCapabilities {
  readonly prompt: { readonly text: true; readonly image: boolean; readonly audio: boolean; readonly embeddedContext: boolean }
  readonly session: { readonly load: boolean; readonly resume: boolean; readonly close: boolean; readonly list: boolean }
}

export interface AgentBackendSession {
  readonly id: string                       // backend-owned session id
  readonly cwd: string
  readonly capabilities: AgentBackendCapabilities
  prompt(content: readonly ContentBlock[], signal?: AbortSignal): Promise<AgentStopReason>
  cancel(): void
  close(): Promise<void>
  setConfigOption?(id: string, value: string): Promise<void>
}

export interface AgentBackend {
  readonly capabilities: AgentBackendCapabilities
  createSession(input: { cwd: string; handlers: AgentSessionHandlers }): Promise<AgentBackendSession>
  resumeSession(input: { cwd: string; sessionId: string; handlers: AgentSessionHandlers }): Promise<AgentBackendSession>
  dispose(): Promise<void>
}

export interface AgentSessionHandlers {
  onUpdate(update: AgentUpdate): void
  onPermission(request: AgentPermissionRequest): Promise<ApprovalOutcome>
}
```

`AgentUpdate` is a structured union (text, reasoning, image, tool-call, tool-update, plan, mode, config, usage,
notice, session-info, compaction, unknown). The plugin's `src/backend.ts` is a concrete instance of this shape.

### 4.2 Runtime integration

A backend-backed agent should be a first-class `Agent` implementation, not a tool and not an `LlmAdapter`:

- It implements the `Agent` runtime face (`send`, `followup`, `steer`, `inject`, `cancel`, `whenIdle`,
  `runMaintenance`, `model`, `inbox`, `status`, `ctx`, `session`).
- `send`/`followup` open `turn/start`, append `user/message`, call `backend.prompt()`, and close `turn/end`.
- `steer`/`inject` map to backend-specific prompt/cancel semantics when supported; otherwise they queue for the
  next turn and are documented as unsupported.
- Backend updates append durable events:
  - text/reasoning → `assistant/message` (or a streamed `assistant/attempt` plus a final `assistant/message`),
  - tool-call/tool-update → `tool/call` + `tool/result`,
  - plan/notice/usage/session-info → plugin records or new core events,
  - errors/cancellation → `turn/end` with the matching `TurnEndReason`.
- Permission requests go to `ctx.approval.request({ agent, toolName, callId, reason, signal })`; only
  `'allowed-once'` maps to an ACP `allow_once` selection.
- The backend session id and capabilities are durable plugin records (or a future core projection), so a resumed
  dsh session can attempt `session/load` / `session/resume`.

### 4.3 Factory selection

`AgentRegistry.setFactory` accepts one factory. The least invasive upstream change is:

1. Add an optional `backend` field to `AgentOptions` / `CreateAgentOptions` (a registered backend id).
2. `AgentLoop` (the factory) checks it and constructs a `BackendAgent` instead of `ReactLoopAgent`.
3. A new `AgentBackendRegistry` service (`ctx.agentBackends`) lets plugins register backends by id.
4. The existing loop remains the default; no existing plugin changes.

Alternative: a separate `@deepseek-ai/dsh-agent-backend-loop` plugin registers the factory and delegates to the
default loop for non-backend agents. This avoids touching `dsh-agent-loop`, but it still requires a new factory
selection mechanism.

### 4.4 Structured tool events

The preferred solution is **not** a new content block. A `BackendAgent` owns the turn, so it can append
`tool/call` and `tool/result` events directly, exactly like the loop does. The UI, persistence, and compaction
already understand those events. The model-visible history then contains the real tool lifecycle.

If a backend cannot provide a tool result (e.g., the agent only reports a completed tool call without output), the
backend appends a `tool/result` with an explicit "output unavailable" message, or a plugin record plus a text
summary. It must never fabricate a successful result.

A new `tool-call` block variant with `executedBy: 'provider'` is an alternative, but it touches assembly, the loop,
compaction, and every UI. The event-based approach is smaller and uses existing contracts.

## 5. What this plugin implements today

### 5.1 Backend boundary

- `src/backend.ts` — backend-neutral capability, session, update, permission, and backend interfaces.
- `src/acp-backend.ts` — `AcpAgentBackendImpl`, a generic ACP implementation over `AcpProcess`. It knows nothing
  about Antigravity; model filtering, family collapsing, session modes, and thinking levels stay in the adapter.
- `src/events.ts` — ACP `SessionUpdate` → structured `AgentUpdate` translation, including tool content, plans,
  notices, usage, compaction, and unknown updates.
- `src/acp-process.ts` — SDK-backed ACP client, process lifecycle, capability normalization, `session/load` /
  `session/resume`, active-prompt-scoped permission waits, and stale-request rejection.

### 5.2 Session continuity

`src/continuity.ts` keeps one ACP session per dsh session:

- The first turn creates an ACP session and sends the full conversation.
- Later turns send only the new tail (the messages after the assistant message dsh recorded).
- A fingerprint of every non-system message and the exact streamed assistant text are compared before reuse.
  Divergence (compaction, fork, retry, rewritten assistant message, changed cwd) triggers a fresh session + full
  replay.
- A system prompt change is delivered as `<system_update>` instead of recreating the session.
- After a process crash or idle stop, `session/load` (preferred) or `session/resume` is attempted **only when the
  agent advertises the capability**; any failure falls back to replay.
- Per-session mutexes serialize turns; `maxSessions` evicts least-recently-used idle sessions; an idle timer closes
  unused sessions.
- Auxiliary calls (`purpose` set, e.g. `session-title` / `compaction`) and calls without a `sessionId` always use an
  ephemeral session, so they never pollute the main conversation.

### 5.3 Permissions

- `permissionMode: 'reject'` denies without asking dsh.
- `allow-once` selects ACP `allow_once`; it never escalates to `allow_always`.
- `allow-always` is an explicit opt-in and selects `allow_always` when offered.
- A denial selects `reject_once`; if the agent offers no reject option, the outcome is `cancelled`.
- A missing approval seam, missing live agent, throwing answerer, or aborted turn fails closed.
- The ACP `toolCallId` is forwarded as dsh's approval `callId`.
- Permission requests that arrive after their prompt settled are rejected as stale; a prompt's permission waits are
  scoped to that prompt, not the session.
- `sessionMode` defaults to `plan`; if the agent does not offer it, the turn fails rather than running in a less
  restrictive mode. `default` is an explicit opt-in and logs a warning.

### 5.4 Multimodal and structured preservation

- Images are sent as ACP `image` blocks when `promptCapabilities.image` is advertised and `ctx.attachments` can read
  the bytes. Otherwise they become an explicit placeholder plus a warning.
- Files become `resource_link` (host path available) or embedded `resource` (text + `embeddedContext`); otherwise a
  placeholder plus a warning.
- Assistant images are saved through `ctx.attachments.saveImage` and emitted as dsh `image` blocks when possible.
- ACP tool lifecycle, plans, notices, usage, mode/config changes, and compaction are recorded as
  `plugin:agy-acp/tool`, `plugin:agy-acp/update`, and `plugin:agy-acp/session` records. They are non-surface,
  ignorable, survive fork/resume, and are readable with `pluginRecordOf()`.
- Tool activity is still rendered as compact text in the assistant transcript because dsh's `StreamChunk` cannot
  represent provider-executed tools. This is the documented compatibility compromise.

## 6. Migration plan

### Phase 0 — current (plugin-local, implemented)

- Keep `LlmAdapter` as the public provider surface.
- Add the backend boundary and persistent sessions behind it.
- Add capability negotiation, permission hardening, multimodal prompts, and structured plugin records.
- Keep the existing Antigravity model catalog and provider route unchanged.

### Phase 1 — plugin-local backend service

- Expose the backend as a plugin service (e.g. `ctx.agyAcpBackend`) for programmatic consumers.
- Add a `spawn_acp_agent` tool that drives an ACP session as a subagent and returns its result. This is useful, but
  it is still a tool, not a first-class execution backend.
- Persist the ACP session id and cursor in `plugin:agy-acp/session` records and read them back on resume, so a dsh
  process restart can attempt `session/load` deterministically.

### Phase 2 — upstream `AgentBackend`

- Add `AgentBackend`, `AgentBackendSession`, `AgentUpdate`, and `AgentPermissionRequest` to `dsh-agent` (or a new
  package).
- Add `AgentBackendRegistry` (`ctx.agentBackends`) and a `backend` field to `AgentOptions` / `CreateAgentOptions`.
- Implement `BackendAgent` (or extend `AgentLoop`) to drive a backend and append the standard session events.
- Add a backend session projection (or a documented plugin record) for durable session identity and capabilities.
- Keep the existing loop as the default; no existing plugin changes.

### Phase 3 — deprecate the ACP-as-LLM path

- Route ACP agents through `BackendAgent`; keep `LlmAdapter` for stateless completion providers and auxiliary calls.
- Remove the text-flattening compromise for main turns; retain it only for auxiliary calls that genuinely need a
  completion-style response.
- Keep the current plugin as a compatibility shim for older dsh versions.

## 7. Upstream vs plugin responsibilities

| Change | Where |
|---|---|
| `AgentBackend` interface, registry, `BackendAgent` | dsh upstream (`dsh-agent` / `dsh-agent-loop`) |
| Backend selection in `AgentOptions` / factory | dsh upstream |
| Durable backend session projection | dsh upstream (or plugin records until then) |
| ACP client, capability negotiation, process lifecycle | this plugin |
| Antigravity model catalog, family collapsing, modes, thinking levels | this plugin (`models.ts`, `adapter.ts`) |
| Permission mapping and fail-closed policy | this plugin (delegating to `ctx.approval`) |
| Multimodal prompt conversion | this plugin (using `ctx.attachments` when composed) |
| Structured ACP records | this plugin (using `appendPluginRecord`) |

## 8. Known limitations

1. **No upstream backend seam yet.** The plugin's backend is behind `LlmAdapter`; dsh still believes it is calling
   a model. Tool activity is text in the transcript, with structured records on the side.
2. **Cross-process ACP session resume is best-effort.** It requires the agent to advertise `loadSession` or
   `session/resume`; otherwise the plugin replays the conversation into a fresh ACP session. The ACP session id is
   not yet read back from the dsh session log after a dsh restart (it is kept in memory for process crashes). A
   resumed session that returns no configuration options still has `plan` enforced through `session/set_mode`, and
   the turn fails closed if the agent cannot confirm it. Resume also trusts the agent's persisted session to match
   the conversation the plugin last sent: the plugin verifies its own history prefix, but replayed `session/load`
   updates are intentionally not re-emitted, so a mismatched agent-side session is not detected from the wire.
3. **System prompt changes are approximated.** A changed system prompt is sent as `<system_update>`; it is not a
   native ACP session reconfiguration.
4. **Auxiliary calls use ephemeral sessions.** Title generation and compaction do not share the main ACP context.
5. **Usage is not mapped to dsh token accounting.** ACP `usage_update` reports context usage, not input/output
   token counts; it is recorded but not emitted as `TokenUsage`.
6. **Antigravity native mode can bypass ACP permissions.** Observed on `agy` 1.5.x: `default` mode wrote files
   without a `session/request_permission`. `plan` remains the default and is enforced fail-closed. ACP permissions
   are not a sandbox; they only govern operations the agent chooses to ask about.
7. **Assistant images require the attachment service.** Without `ctx.attachments`, an ACP image output becomes an
   explicit text placeholder.
8. **Audio is not supported.** ACP audio prompts are rendered as a placeholder with a warning.
9. **The generic backend is not yet a generic plugin.** The provider route, model filtering, and Antigravity
   config options remain Antigravity-specific. Another ACP agent can reuse `AcpAgentBackendImpl` and
   `SessionContinuity`, but it needs its own adapter and provider registration.

## 9. Test coverage

`bun test` covers 147 tests across 11 files, including:

- process startup, initialization, capability normalization, malformed responses, missing CLI, auth required;
- session creation, streaming, tool updates, concurrent sessions, idle shutdown, disposal;
- `session/load` and `session/resume`, including load replay updates and unsupported capabilities;
- persistent session reuse, delta prompts, divergence replay, crash recovery, resume failure fallback, concurrent
  dsh sessions, eviction, and `sessionContinuity: false`;
- cancellation (including agents that ignore it) and session reuse after cancellation;
- permission approval, denial, fail-closed paths, `reject` short-circuit, `callId` forwarding, and stale requests;
- multimodal prompt blocks (images, files, embedded resources, placeholders, warnings);
- config validation and plugin registration/unload.

The mock ACP agent (`test/mock-agent.ts`) speaks the real SDK over stdio, so the tests exercise the wire protocol
without Google credentials or network access.
