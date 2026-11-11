# dsh-agy-acp (experimental)

A **dsh** plugin that lets dsh talk to Google's official Antigravity ACP server (`agy acp`) and use the **Gemini**
models it reports.

```
dsh agent loop ──► this plugin (LlmAdapter) ──► ACP client (@agentclientprotocol/sdk) ──► `agy acp` (official, unmodified) ──► Antigravity
```

> **Status: experimental.** See [Limitations](#limitations-read-these). Protocol compatibility is **not** a statement
> of Google approval — see [Policy note](#policy-note).

## What it does

- Spawns `agy acp` and speaks ACP JSON-RPC over stdio, exclusively through `@agentclientprotocol/sdk`.
- Registers the `antigravity` provider with dsh's LLM seam (`ctx.llm.registerAdapter`), so the models appear in dsh's
  model picker and every model call streams through the normal dsh agent loop.
- Discovers models from the server's own `session/new` response and exposes **only the Gemini models it reports**, one
  model per family, with the server's thinking levels as dsh **reasoning efforts** (`low` / `medium` / `high`). The
  server also lists Claude / GPT-OSS entries; they are deliberately not exposed.
- Streams text and reasoning, and shows Antigravity's own tool activity as compact text lines in the transcript
  (dsh has no provider-executed tool concept; see [Limitations](#limitations-read-these)).
- Forwards ACP `session/request_permission` requests to **dsh's approval seam** (`ctx.approval.request`), so the
  interactive approval UI and the session's `ask` / `never` policy apply.
- Cancels cleanly (`session/cancel`), survives and reports crashes, and terminates the subprocess on unload.

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
│                                    adapter.ts  (LlmAdapter)                 │
│                                     prompt.ts: messages → prompt text       │
│                                     frames → StreamChunk                    │
│                                          │                                  │
│                                          ▼                                  │
│                                    turn.ts: one ACP session per model call  │
│                                          │                                  │
│                     approval ◄───────────┘  ctx.approval.request (dsh)      │
│                     requests ───────────►   permission.ts (ACP outcome)     │
│                                          │                                  │
│                                          ▼                                  │
│                                    acp-process.ts (lifecycle, timeouts,     │
│                                    cancel, restart, cleanup)                │
└──────────────────────────────────────────┬──────────────────────────────────┘
                                           │ stdin/stdout = ACP JSON-RPC only
                                           ▼
                                     `agy acp`  ──(owns login & credentials, talks to Google)──► Antigravity
```

Files: `config.ts` (validated options) · `acp-process.ts` (SDK client + process lifecycle) · `turn.ts` (one prompt
turn) · `adapter.ts` (dsh `LlmAdapter` + chunk mapping) · `index.ts` (cordis plugin) · `permission.ts`, `models.ts`,
`prompt.ts` (pure helpers).

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
Antigravity (Gemini via ACP) → Gemini 4 Argon   (reasoning: low / medium / high)
Antigravity (Gemini via ACP) → Gemini 3.8 Flash (reasoning: low / medium / high)
```

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

Rejected on purpose: any option whose name looks credential-related, and the args `--dangerously-skip-permissions`,
`--cloud_code_endpoint`, `--override_user_agent_name`, `--gemini-dir`/`--gemini_dir`, `--app-data-dir`/`--app_data_dir`,
`--cli_dir_name`, `--login`.

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

## Limitations (read these)

1. **File writes are not gated by ACP in Antigravity's native mode (agy 1.5.x).** Observed live on 1.5.2: in
   `default` mode `agy` wrote files — inside *and outside* the workspace — **without sending any permission request**,
   so dsh's approval rules could not stop it. Shell commands *are* gated. In `plan` mode the same write prompt produced
   only a plan and **no file was written**. Hence `sessionMode: "plan"` is the default. If you set `"default"`, treat
   Antigravity as able to write files on its own. Consider also `--sandbox` in `args` (restricts terminal), which is a
   documented `agy acp` flag.
2. **Tool activity is text, not tool calls.** dsh's `StreamChunk` has no provider-executed tool concept: a `tool-call`
   block would make the dsh loop try to execute a tool Antigravity already ran. So Antigravity's tool activity is
   surfaced as compact text lines (`[agy read] …`, `[agy] … — completed`), or hidden with `toolActivity: "hidden"`.
3. **dsh's tool definitions are not forwarded.** Antigravity is an agent, not a completion API; it runs its own tools.
   When dsh offers native tool schemas, the prompt adds a short `<agent_runtime>` note explaining that the host's
   tools are not forwarded.
4. **Stateless per call.** Each dsh model call opens a fresh ACP session and replays the transcript as text (images and
   files are omitted). Title generation, compaction, and other auxiliary model calls using this provider also run
   Gemini turns.
5. **Limits and usage are not reported by ACP.** Context/output limits come from a table of Google's published figures
   (1,048,576 / 65,536; `FAMILY_LIMITS` in `src/models.ts`, may be lower on your plan); unknown families use dsh's
   defaults. Token usage is not reported, so dsh's token meter estimates it.
6. **Pending dsh approval on cancel.** If a turn is cancelled while a dsh approval prompt is open, the ACP side is
   released immediately, but the prompt may remain visible until answered.
7. **Models are families** (`gemini-4-argon`, `gemini-3.8-flash`); reasoning efforts `low|medium|high` map to the
   server's `thought_level`. Both are applied via the stable `session/set_config_option` (`model`, `thought_level`,
   `mode`). If a model cannot be selected, the call errors instead of silently using another model.
8. **Experimental integration.** The dsh `LlmAdapter` contract is public, but this plugin is young. Pin versions and
   re-test on upgrades.

## Compatibility (tested)

| Component | Version |
|---|---|
| dsh | `0.2.2-rc.1` (cordis plugin API: `name` / `inject` / `Config` / `apply`; `ctx.llm.registerAdapter`) |
| Antigravity CLI | `agy` 1.5.3 — `agy acp`, ACP protocol v1, agent name "Antigravity ACP Server" (original plugin tested 1.5.2) |
| `@agentclientprotocol/sdk` | 2.4.0 (v1 stable entrypoint; client API `client().onRequest().connect()`) |
| dsh packages | `@deepseek-ai/dsh-llm`, `dsh-agent`, `dsh-user-approval`, `dsh-working-directory` 0.2.2-rc.1 |
| Runtime / OS | Node 26.13.0, Bun 1.4.4 (tests), Linux (CachyOS) |

Verified live on this machine: model discovery (2 Gemini families, 3 thinking levels), model + reasoning-effort
selection, a real streamed Gemini response (`"Say hi in one short sentence."` → `"Hi there, how can I help you today?"`,
finish `stop`), and clean subprocess exit. Verified by tests: permission approval/denial/fail-closed, cancellation,
crashes, malformed responses, missing CLI, unsupported ACP command, concurrent sessions, idle shutdown, and disposal.
Not verified: Windows/macOS, and the dsh TUI model picker end-to-end (the adapter is exercised directly).

## Tests

```fish
bun test
```

98 tests against a mock ACP server (`test/mock-agent.ts`, real SDK on the agent side), no Google credentials or network
required. Coverage: process startup, initialization, session creation, streaming, tool-call updates, permission
approval/denial/fail-closed, cancellation (incl. agents that ignore it), unexpected termination + reconnect, malformed
responses, missing CLI, unsupported ACP command, concurrent sessions, idle shutdown, disposal, model discovery and
family collapsing, prompt building, config validation, and the full `LlmAdapter` → `StreamChunk` path.

Manual smoke tests (require the real CLI and consume a little quota):

```fish
bun run build
bun scripts/smoke.mjs        # discovery only
bun scripts/live-prompt.mjs  # one real Gemini turn
```

## Policy note

Using the documented ACP interface of the official `agy` binary is **protocol compatibility**. It is not a claim that
Google has reviewed or approved this plugin, and it says nothing about whether your Antigravity plan's terms permit use
through third-party clients. Check Google's current terms for your account type before relying on it.
