# dsh-agy-acp (experimental)

A **dsh** plugin that lets dsh talk to Google's official Antigravity ACP server (`agy acp`) and use the **Gemini**
models it reports.

```
dsh agent loop ──► this plugin (LlmAdapter compatibility surface)
                        │
                        ├── SessionContinuity: one ACP session per dsh session, delta prompts, replay fallback
                        │
                        └── AcpAgentBackend ──► ACP client (@agentclientprotocol/sdk) ──► `agy acp` (official, unmodified) ──► Antigravity
```

> **Status: experimental.** See [Limitations](#limitations-read-these). Protocol compatibility is **not** a statement
> of Google approval — see [Policy note](#policy-note). The architectural rationale and the proposed upstream
> `AgentBackend` seam are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## What it does

- Spawns `agy acp` and speaks ACP JSON-RPC over stdio, exclusively through `@agentclientprotocol/sdk`.
- Registers the `antigravity` provider with dsh's LLM seam (`ctx.llm.registerAdapter`), so the models appear in dsh's
  model picker and every model call streams through the normal dsh agent loop.
- **Keeps one ACP session per dsh session** and sends only the new user tail on later turns, instead of creating a
  fresh ACP session and replaying the whole conversation as text on every call. History divergence (compaction,
  fork, retry, rewritten assistant message) falls back to a fresh session + full replay.
- **Negotiates ACP capabilities** from `initialize` and only uses what the agent advertises: `session/load`,
  `session/resume`, `session/close`, image prompts, embedded context, and notices/compaction updates.
- Discovers models from the server's own `session/new` response and exposes **only the Gemini models it reports**, one
  model per family, with the server's thinking levels as dsh **reasoning efforts** (`low` / `medium` / `high`, plus
  `xhigh` — "Extra High" — where the server advertises it, as Gemini 4 Hydrogen does). The server also lists Claude
  and GPT-OSS entries; they are deliberately not exposed: this integration only uses Google's own models through
  `agy`, and partner models are outside its supported path.
- Streams text and reasoning, and shows Antigravity's own tool activity as compact text lines in the transcript
  (dsh has no provider-executed tool concept; see [Limitations](#limitations-read-these)). Structured tool, plan,
  notice, usage, and session events are also recorded as `plugin:agy-acp/*` session records.
- **Preserves images and files** as ACP content blocks when the agent advertises the capability and dsh's attachment
  service is composed; otherwise it emits an explicit placeholder and a warning instead of silently dropping them.
- Forwards ACP `session/request_permission` requests to **dsh's approval seam** (`ctx.approval.request`), so the
  interactive approval UI and the session's `ask` / `never` policy apply. Stale requests are rejected, `reject` mode
  never prompts, and `allow-once` never escalates.
- Cancels cleanly (`session/cancel`), survives and reports crashes, reconnects, and terminates the subprocess on
  unload.

## What it never does

Authentication belongs entirely to the Antigravity CLI. This plugin does **not** read, copy, parse, export, refresh or
store any token; does not touch `~/.gemini` or any Antigravity data directory; implements no OAuth; runs no HTTP
proxy; calls no Google endpoint; never uses `agy -p`; and exposes no credential configuration (credential-looking
option names are rejected). See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md).

## Architecture

```
┌──────────────────────────────── dsh process ────────────────────────────────┐
│                                                                             │
│  agent loop ── GenerateOptions ──► provider "antigravity"                   │
│                                    adapter.ts  (LlmAdapter compatibility)   │
│                                          │                                  │
│                     ┌────────────────────┴─────────────────────┐            │
│                     ▼                                          ▼            │
│              main turns                               auxiliary calls        │
│              continuity.ts                            turn.ts (ephemeral)    │
│              one ACP session per dsh session          one session per call   │
│                     │                                          │            │
│                     └────────────────────┬─────────────────────┘            │
│                                          ▼                                  │
│                                    acp-backend.ts (generic ACP backend)     │
│                                    backend.ts (capabilities, updates,       │
│                                                permission interface)        │
│                                          │                                  │
│                     approval ◄───────────┘  ctx.approval.request (dsh)      │
│                     requests ───────────►   permission.ts (ACP outcome)     │
│                                          │                                  │
│                                          ▼                                  │
│                                    acp-process.ts (lifecycle, capabilities, │
│                                    load/resume, cancel, restart, cleanup)   │
│                                          │                                  │
│                     session records ◄────┘  plugin:agy-acp/* (structured)   │
└──────────────────────────────────────────┬──────────────────────────────────┘
                                           │ stdin/stdout = ACP JSON-RPC only
                                           ▼
                                     `agy acp`  ──(owns login & credentials, talks to Google)──► Antigravity
```

Files: `config.ts` (validated options) · `acp-process.ts` (SDK client + process lifecycle + capabilities) ·
`acp-backend.ts` / `backend.ts` (generic ACP backend boundary) · `continuity.ts` (persistent sessions, delta prompts,
replay fallback) · `events.ts` (ACP update translation) · `prompt.ts` (text and multimodal prompt blocks) ·
`attachments.ts` (dsh attachment store → ACP content) · `records.ts` (structured `plugin:agy-acp/*` records) ·
`adapter.ts` (dsh `LlmAdapter` + chunk mapping) · `turn.ts` (ephemeral/auxiliary turn) · `index.ts` (cordis plugin) ·
`permission.ts`, `models.ts` (pure helpers).

## Install

Prerequisites: dsh `0.2.2-rc.1` (or a compatible version), Node `>=24`, and the Antigravity CLI (`agy`) **already
signed in**.

```fish
# 1. Make sure agy is on PATH (Fish)
fish_add_path ~/.local/bin
agy --version
agy acp --help | head -3          # must print "Start the Agent Client Protocol (ACP) stdio server"

# 2. Sign in using the CLI itself (this plugin never logs in for you)
agy                               # follow the interactive Google login, then exit

# 3. Build the plugin
cd ~/Projects/dsh-agy-acp
bun install
bun run build

# 4. Install it into your profile
dsh plugin --profile dsh-tui add /home/alfi/Projects/dsh-agy-acp
```

Because this package declares `dsh.bundle.patch`, the plugin manager installs it and appends `dsh-agy-acp` to the
profile's `dsh.profile.bundles`. If your dsh version only forwards the pnpm command, add the bundle manually:

```jsonc
// ~/.dsh/profiles/dsh-tui/package.json
{
  "dependencies": {
    "dsh-agy-acp": "link:/home/alfi/Projects/dsh-agy-acp"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-harness-tui/dsh-tui", "dsh-agy-acp"]
    }
  }
}
```

```fish
cd ~/.dsh/profiles/dsh-tui && pnpm install
```

Then restart dsh (or let the profile HMR reload). Pick a model in the model picker:

```
Antigravity (Gemini via ACP) → Gemini 4 Argon       (reasoning: low / medium / high)
Antigravity (Gemini via ACP) → Gemini 4 Hydrogen    (reasoning: low / medium / high / Extra High)
Antigravity (Gemini via ACP) → Orchestrator (Argon) (fixed configuration, no reasoning effort)
Antigravity (Gemini via ACP) → Gemini 3.8 Flash     (reasoning: low / medium / high)
```

The list is whatever your plan's `agy acp` reports (for example, Gemini 4 Carbon appears on Google AI Ultra), so it
can grow between CLI releases without a plugin update. Orchestrator is a fixed two-model configuration (a planner
plus Gemini 4 Hydrogen) and the server reports no thinking levels for it, so dsh shows no reasoning selector.

The provider is registered by the plugin row `agy-acp`. To tune it, override that row's config in the profile's own
`cordis.patch.yml` (do **not** insert a second same-id row):

```yaml
# ~/.dsh/profiles/dsh-tui/cordis.patch.yml
- id: agy-acp
  name: dsh-agy-acp
  config:
    command: agy
    args: ["acp"]
    permissionMode: allow-once
    sessionMode: plan
    startupTimeoutMs: 20000
    requestTimeoutMs: 120000
    idleTimeoutMs: 300000
    debug: false
    toolActivity: text
    modelsRefreshMs: 60000
    sessionContinuity: true
    resumeSessions: true
    maxSessions: 8
    sessionIdleTimeoutMs: 900000
    structuredEvents: true
    imageInput: true
    warnOnUnsupportedContent: true
```

If the models do not appear, check dsh's stderr for `[agy-acp]` errors. Common causes: `agy` is not on PATH, the CLI
is not signed in, or the CLI is too old to expose `acp`. The plugin registers **no** models in those cases and never
falls back to another transport. After logging in, restart dsh (model discovery is cached for `modelsRefreshMs`).

### Options

| Option | Default | Meaning |
|---|---|---|
| `command` | `"agy"` | Antigravity CLI executable (name or absolute path). |
| `args` | `["acp"]` | Arguments. Flags that bypass permissions or redirect the CLI are rejected (see below). |
| `permissionMode` | `"allow-once"` | ACP option chosen **after dsh approves**: `allow-once`, `allow-always` (explicit opt-in), or `reject` (deny all). Denials never select an allow option. If only `allow_always` is offered, `allow-once` rejects rather than escalating. |
| `sessionMode` | `"plan"` | Antigravity session mode. `plan` is restrictive; `default` is Antigravity's native mode (see Limitations). `accept-edits` is not selectable. |
| `startupTimeoutMs` | `20000` | Spawn + `initialize` limit. |
| `requestTimeoutMs` | `120000` | Limit for non-prompt requests, and inactivity limit during a turn (time spent waiting on an approval is excluded). |
| `idleTimeoutMs` | `300000` | Stop the subprocess after this long with no active sessions (`0` disables). It restarts on demand. |
| `debug` / `logFile` | `false` / stderr | Diagnostics go to stderr or a file — never stdout. Logs hold metadata only (method names, ids, tool kinds/paths/commands), no prompt text, and the CLI's stderr is credential- and email-redacted. |
| `toolActivity` | `"text"` | `text` writes a compact line per Antigravity tool call into the assistant transcript; `hidden` drops tool activity. |
| `modelsRefreshMs` | `60000` | How long a discovered model catalog is reused before asking `agy acp` again. |
| `sessionContinuity` | `true` | Reuse one ACP session per dsh session and send only the new user tail. `false` restores the old one-session-per-call behavior. |
| `resumeSessions` | `true` | After a crash/idle stop, try `session/load` or `session/resume` when the agent advertises it; otherwise replay. |
| `maxSessions` | `8` | Maximum persistent ACP sessions kept alive; least-recently-used idle sessions are closed. `0` disables the cap. |
| `sessionIdleTimeoutMs` | `900000` | Close a persistent ACP session after this long without a turn. `0` disables idle cleanup. |
| `structuredEvents` | `true` | Append `plugin:agy-acp/session`, `plugin:agy-acp/tool`, and `plugin:agy-acp/update` records to the dsh session log. |
| `imageInput` | `true` | Send image prompt blocks when the agent advertises `promptCapabilities.image` and dsh's attachment service is composed. |
| `warnOnUnsupportedContent` | `true` | Log a warning when an image, file, or unknown content block cannot be represented. |

Rejected on purpose: any option whose name looks credential-related, and the args `--dangerously-skip-permissions`,
`--cloud_code_endpoint`, `--override_user_agent_name`, `--gemini-dir`/`--gemini_dir`, `--app-data-dir`/`--app_data_dir`,
`--cli_dir_name`, `--login`.

## Session continuity

The old adapter opened a fresh ACP session for every dsh model call and replayed the whole conversation as text.
That worked, but it threw away Antigravity's native execution context and re-serialized the transcript on every turn.

The plugin now keeps one ACP session per dsh session:

1. The first main turn creates an ACP session and sends the full conversation.
2. Later turns send **only the new user tail** (the messages after the assistant message dsh recorded).
3. Before reuse, the plugin compares a fingerprint of every non-system message and the exact assistant text it
   streamed. If they diverge (compaction, fork, retry, rewritten assistant message, changed working directory), it
   starts a fresh ACP session and replays the conversation.
4. A changed system prompt is delivered as a `<system_update>` block instead of recreating the session.
5. After a subprocess crash or idle stop, it attempts `session/load` (preferred) or `session/resume` **only if the
   agent advertised the capability**; any failure falls back to a fresh session + replay.
6. Auxiliary calls (`session-title`, `compaction`, and any call without a dsh session id) always use an ephemeral
   ACP session, so they never pollute the main conversation.

Sessions are serialized per dsh session, capped by `maxSessions`, and closed after `sessionIdleTimeoutMs` without a
turn. The subprocess then stops after `idleTimeoutMs` with no remaining sessions, so a persistent session keeps
`agy acp` alive until it is closed. `sessionContinuity: false` restores the old one-session-per-call behavior.

**Limits:** continuity is process-local. After a dsh restart the plugin does not yet read the ACP session id back
from the session log, so it replays into a fresh ACP session. Cross-process resume also depends on the ACP agent
implementing `session/load` or `session/resume`; the plugin never assumes either exists.

**Resumed sessions and the restrictive mode:** a resumed ACP session may return no configuration options. Because
`sessionMode: "plan"` is a security boundary, the plugin then enforces it with the standard `session/set_mode`
method; if the agent cannot confirm `plan`, the turn fails closed instead of running in an unknown mode.

## Multimodal content

- **Images** are sent as ACP `image` blocks when the agent advertises `promptCapabilities.image` and dsh's
  attachment service (`ctx.attachments`) is composed. Otherwise they become `[image omitted: …]` plus a warning.
- **Files** become `resource_link` blocks when a host path is available, or embedded `resource` blocks when the
  agent advertises `embeddedContext` and the file is UTF-8 text. Otherwise they become `[file: …]` plus a warning.
- **Assistant images** are saved through `ctx.attachments.saveImage` and emitted as dsh image blocks when possible;
  without the attachment service they become an explicit text placeholder.
- **Audio** is not supported by dsh's content vocabulary; ACP audio prompts are rendered as a placeholder.
- **Reasoning** is streamed as dsh reasoning blocks when the agent exposes it.
- **Structured ACP events** (tool lifecycle, plans, notices, usage, mode/config changes, compaction) are recorded as
  `plugin:agy-acp/*` records. They are non-surface, ignorable, survive fork/resume, and can be read with
  `pluginRecordOf()`.

## Permissions

Antigravity asks the ACP client for consent via `session/request_permission`. The plugin maps the request to a dsh
approval question (`ctx.approval.request`) with a tool name and a reason:

| ACP kind | dsh tool name | Reason |
|---|---|---|
| `execute` | `bash` | `Antigravity wants to run: <command>` |
| `edit` / `delete` / `move` | `edit` | `Antigravity wants to <kind> <paths>` |
| `read` | `read` | `Antigravity wants to read <paths>` |
| `fetch` | `web_fetch` | `Antigravity wants to fetch: <url>` |
| `search` | `grep` | `Antigravity wants to search: <title>` |
| other | `agy_<kind>` | the tool title (and paths, if any) |

Approval selects ACP `allow_once`; denial selects `reject_once`; no live agent, no approval seam, a throwing approval,
or a cancelled turn all result in denial. Nothing is saved as "always allow" on the user's behalf. dsh's session
approval policy (`ask` / `never`) still applies before the answerers are consulted.

Additional hardening:

- `permissionMode: "reject"` denies **without asking dsh** — the answer is known without a prompt.
- The ACP `toolCallId` is forwarded as dsh's approval `callId`, so the approval UI can attach the prompt to the tool
  call it already streamed.
- Permission waits are scoped to the active prompt. A request that arrives after its prompt settled is rejected as
  stale (`cancelled`), never shown to the user and never approved.
- A cancellation releases the pending approval immediately; a late answer is discarded.
- `allow-once` never escalates to `allow_always`. If the agent offers only `allow_always`, the request is rejected.
- `allow-always` is an explicit opt-in and is the only mode that selects `allow_always`.

**ACP permissions are not a sandbox.** They only cover operations the agent chooses to ask about. See
[SECURITY_AUDIT.md](./SECURITY_AUDIT.md) for the observed Antigravity `default`-mode file-write gap.

## Limitations (read these)

1. **File writes are not gated by ACP in Antigravity's native mode (agy 1.5.x).** Observed live on 1.5.2: in
   `default` mode `agy` wrote files — inside *and outside* the workspace — **without sending any permission request**,
   so dsh's approval rules could not stop it. Shell commands *are* gated. In `plan` mode the same write prompt produced
   only a plan and **no file was written**. Hence `sessionMode: "plan"` is the default. If you set `"default"`, treat
   Antigravity as able to write files on its own. Consider also `--sandbox` in `args` (restricts terminal), which is a
   documented `agy acp` flag.
2. **Tool activity is text in the transcript, structured in the session log.** dsh's `StreamChunk` has no
   provider-executed tool concept: a `tool-call` block would make the dsh loop try to execute a tool Antigravity
   already ran. So Antigravity's tool activity is surfaced as compact text lines (`[agy read] …`, `[agy] … —
   completed`), or hidden with `toolActivity: "hidden"`. The full structured lifecycle is still recorded as
   `plugin:agy-acp/tool` records. A first-class upstream `AgentBackend` would remove this compromise; see
   [ARCHITECTURE.md](./ARCHITECTURE.md).
3. **dsh's tool definitions are not forwarded.** Antigravity is an agent, not a completion API; it runs its own tools.
   When dsh offers native tool schemas, the prompt adds a short `<agent_runtime>` note explaining that the host's
   tools are not forwarded.
4. **Continuity is process-local.** The plugin keeps ACP session ids in memory across subprocess crashes, but not
   across a dsh restart. After a restart it creates a fresh ACP session and replays the conversation. Cross-process
   resume also depends on the agent implementing `session/load` or `session/resume`; neither is assumed.
5. **Auxiliary calls are ephemeral.** Title generation, compaction, and any call without a dsh session id open a
   fresh ACP session and close it afterwards, so they do not share the main conversation.
6. **Limits and usage are not reported by ACP.** Context/output limits come from a table of Google's published figures
   (1,048,576 / 65,536 for Gemini 4 Argon, Gemini 4 Hydrogen, and Gemini 3.8 Flash; `FAMILY_LIMITS` in
   `src/models.ts`, may be lower on your plan). Orchestrator and unknown families use dsh's defaults. ACP
   `usage_update` reports context usage, not input/output token counts; it is recorded but not emitted as dsh
   `TokenUsage`, so dsh's token meter estimates it.
7. **Pending dsh approval on cancel.** If a turn is cancelled while a dsh approval prompt is open, the ACP side is
   released immediately and a late answer is discarded, but the prompt may remain visible until answered.
8. **Models are families** (`gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator-g1-pro`,
   `gemini-3.8-flash`); reasoning efforts `low|medium|high|xhigh` map to the server's `thought_level`. A level is
   accepted when the server's `thought_level` select lists it **or** when the catalog advertises it through a
   `<family>-<level>` model id — Gemini 4 Hydrogen advertises `xhigh` that way while the select still lists only
   low/medium/high. Both are applied via the stable `session/set_config_option` (`model`, `thought_level`, `mode`).
   If a model cannot be selected, the call errors instead of silently using another model.
9. **The generic backend is not yet a generic plugin.** `AcpAgentBackendImpl` and `SessionContinuity` are
   Antigravity-agnostic, but the provider route, Gemini filtering, family collapsing, and config-option handling are
   Antigravity-specific. Another ACP agent needs its own adapter and provider registration.
10. **Experimental integration.** The dsh `LlmAdapter` contract is public, but this plugin is young. Pin versions and
    re-test on upgrades.

## Compatibility (tested)

| Component | Version |
|---|---|
| dsh | `0.2.2-rc.1` (cordis plugin API: `name` / `inject` / `Config` / `apply`; `ctx.llm.registerAdapter`) |
| Antigravity CLI | `agy` 1.5.9 — `agy acp`, ACP protocol v1, agent name "Antigravity ACP Server" (earlier: 1.5.3, 1.5.2) |
| `@agentclientprotocol/sdk` | 2.4.0 (v1 stable entrypoint; client API `client().onRequest().connect()`) |
| dsh packages | `@deepseek-ai/dsh-llm`, `dsh-agent`, `dsh-session` (plugin records), `dsh-user-approval`, `dsh-working-directory` 0.2.2-rc.1; `dsh-attachment` is optional (multimodal input/output) |
| Runtime / OS | Node 26.13.0, Bun 1.4.4 (tests), Linux (CachyOS) |

Verified live on this machine: model discovery (4 Gemini families, `low`/`medium`/`high` plus `xhigh` on Hydrogen),
model + reasoning-effort selection, real streamed Gemini responses (`"Say hi in one short sentence."` → `"Hi there,
how can I help you today?"`, finish `stop`; Hydrogen at `xhigh` and Orchestrator both answered `"OK"` to a direct
prompt), and clean subprocess exit. The persistent-session path is verified against
the mock ACP server, not yet against a live `agy`; run `bun scripts/live-prompt.mjs` (two turns in one ACP session) to
confirm the second turn reuses the session. Not verified: Windows/macOS, and the dsh TUI model picker end-to-end
(the adapter is exercised directly).

## Tests

```fish
bun test
```

152 tests against a mock ACP server (`test/mock-agent.ts`, real SDK on the agent side), no Google credentials or
network required. Coverage: process startup, initialization, capability normalization, session creation, streaming,
tool-call updates, permission approval/denial/fail-closed, `reject` short-circuit, `callId` forwarding, stale
permission rejection, cancellation (incl. agents that ignore it), unexpected termination + reconnect, `session/load`
and `session/resume`, malformed responses, missing CLI, unsupported ACP command, concurrent sessions, idle shutdown,
disposal, model discovery and family collapsing (incl. `xhigh` levels the `thought_level` select omits), prompt
building, multimodal prompt blocks, persistent session reuse
and delta prompts, divergence replay, crash recovery and resume fallback, eviction, config validation, and the full
`LlmAdapter` → `StreamChunk` path.

Manual smoke tests (require the real CLI and consume a little quota):

```fish
bun run build
bun scripts/smoke.mjs        # discovery only
bun scripts/live-prompt.mjs  # two real Gemini turns in one ACP session (continuity check)
```

## Policy note

Using the documented ACP interface of the official `agy` binary is **protocol compatibility**. It is not a claim that
Google has reviewed or approved this plugin, and it says nothing about whether your Antigravity plan's terms permit use
through third-party clients. Check Google's current terms for your account type before relying on it.

**Only Google models are ever selected.** The plugin filters the server's catalog to Gemini entries and always sets the
model explicitly on every session, so a request can never silently fall through to a partner model (Claude, GPT-OSS)
that `agy` also lists. If you believe using partner models through `agy` is restricted on your account, this
integration stays on the supported Google-only path.
