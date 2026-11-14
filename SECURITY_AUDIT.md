# Security audit — dsh-agy-acp

Scope: everything in this directory except third-party `node_modules/` (source, tests, config, docs, lockfile).
Method: (1) keyword search for every credential-related term plus variants, (2) a behavioural search of `src/` for
every filesystem / environment / network / process API, (3) live experiments against the real `agy` 1.5.9 (originally
1.5.3) and dsh 0.2.2-rc.1.

**Conclusion:** the plugin contains no code that reads, copies, parses, exports, refreshes, stores or transmits Google
credentials, implements OAuth, proxies any API, or contacts any network endpoint. Every keyword hit below is either a
*defensive* control (rejecting or redacting), a test of that control, or the name of an unrelated field.

The persistent-session and multimodal changes do not add a network or credential path. They add: an in-memory map
from dsh session id to ACP session, capability-gated `session/load` / `session/resume`, optional reads from dsh's
attachment store (`ctx.attachments`), and structured `plugin:agy-acp/*` records in the dsh session log. Each is
described below.

## 1. Keyword search — every occurrence explained

| Term | Occurrences | Explanation |
|---|---|---|
| `OAuth` | none in `src/`; `test/mock-agent.ts` (`id: "oauth-personal"`) | The mock imitates the `authMethods` list the real server advertises; the plugin never reads or uses `authMethods` and never calls `authenticate`. No OAuth flow exists. |
| `refreshToken` / `refresh_token` | `src/log.ts` (redaction regex); `test/log.test.ts` | Log: **redacts** the string if the child's stderr ever echoes one (defense in depth). The plugin never has a refresh token. |
| `accessToken` / `access_token` | `src/log.ts` (same redaction regex) | Same as above. |
| `acp_token` | none | No such file or identifier is created or referenced anywhere. |
| `.gemini` | none (fixed-string search) | Never read, listed or written by the plugin. Related: `--gemini-dir` / `--gemini_dir` appear in `src/config.ts` and one test **only** as members of the rejected-argument list, so a user cannot redirect the CLI's data directory through plugin config. |
| `Anthropic` / `Messages API` | none | No Anthropic client, protocol or endpoint. |
| credential copying / token extraction | none | No code path touches credential storage. Occurrences of the word "credential" are comments stating the plugin does not handle credentials, the config deny-list, and tests of it. |
| `token` (broad) | `src/config.ts` deny-list regex; `src/log.ts` redaction; `max_tokens` / `max_turn_requests` in `src/acp-process.ts`, `src/adapter.ts` | The last two are ACP **stop reasons** (model output limits), unrelated to authentication. Tests use a clearly fake `ya29.FAKE_TOKEN_VALUE…` string to prove redaction works. |
| `ya29.` | `src/log.ts` (redaction regex), `test/mock-agent.ts`, `test/acp-process.test.ts`, `test/log.test.ts` | Known prefix of Google bearer tokens, used only to *mask* it in relayed stderr; the test feeds a fake value and asserts it never reaches an error message. |
| email addresses | `src/log.ts` (redaction regex), `test/log.test.ts` | `agy` prints the signed-in account to stderr; the plugin masks it before relaying diagnostics. |

(`README.md` and this file mention these terms to explain the controls and were excluded from the counts above.)

## 2. Behavioural audit of `src/`

| Capability | Result |
|---|---|
| Filesystem | One direct write: `appendFileSync` in `src/log.ts`, to the log file the **user** configured (or stderr). `src/attachments.ts` reads attachment bytes through the composed `ctx.attachments` service (`readImage`, `readFileStream`, `fileHostPath`) — it does not open files itself. `process.cwd()` is used only as the ACP session's working directory when no live dsh agent provides one. |
| Environment | No `process.env` access. (The child inherits dsh's environment by Node's default; the plugin neither reads nor alters it. See residual risk F2.) |
| Network | No `fetch`, `http(s)`, `net`, `tls`, WebSocket or socket code. The plugin's only I/O is the child's stdin/stdout/stderr and the optional attachment service. |
| Processes | One `spawn(command, args)` in `src/acp-process.ts` — the configured Antigravity CLI. No shell (`shell` option is not set), no `exec`. |
| Protocol | All JSON-RPC framing is `@agentclientprotocol/sdk` (`ndJsonStream`). stdout is the protocol channel and is never logged to; stderr is drained separately and goes only to the logger (credential- and email-redacted). |
| Session continuity | One in-memory ACP session per dsh session. It sends only the new tail; divergence triggers a fresh session + replay. `session/load` / `session/resume` are attempted only when the agent advertises the capability. No credential or environment data is added to prompts. |
| Structured records | `src/records.ts` appends `plugin:agy-acp/session`, `plugin:agy-acp/tool`, and `plugin:agy-acp/update` records through dsh's documented `appendPluginRecord`. They are non-surface and ignorable. They contain ACP session ids, tool ids/titles/kinds, paths/commands the agent itself reported, and status/output text — the same metadata the plugin already logs in debug mode. They do not contain prompt text or credentials. |
| `agy -p` / headless | Not used anywhere. |
| Authentication calls | `authenticate` / `logout` / `--login` are never invoked; `--login` is a rejected argument. On "auth required" the plugin only tells the user to log in with the CLI. |
| dsh approval | The plugin calls `ctx.approval.request` with a tool name, reason, and (when available) the ACP tool-call id. It never grants an approval itself; a missing agent, missing seam, error, cancellation, or stale request denies. `permissionMode: "reject"` denies without asking. |
| Dependencies | Runtime: `@agentclientprotocol/sdk` 2.4.0 and `@deepseek-ai/schemastery` ~3.19.0. The dsh packages are peer dependencies supplied by the host; `@deepseek-ai/dsh-attachment` is optional and accessed structurally. |

## 3. Behaviour verified (live or by test)

The first rows were verified live against `agy` 1.5.3 and dsh 0.2.2-rc.1 before the persistent-session change; the
model-catalog and new-model rows were re-verified live on `agy` 1.5.9. Rows
marked "verified by test" were added with the new backend/continuity/permission tests and have not yet been re-run
against a live `agy`; re-run `bun scripts/live-prompt.mjs` twice in one dsh session to exercise the persistent path.

| Check | Outcome |
|---|---|
| Server's model list includes Claude / GPT-OSS entries | Not exposed; only the 4 Gemini families (3 thinking levels, plus `xhigh` on Hydrogen) were registered. |
| Live discovery | `session/new` reported 18 advertised models; the adapter exposed `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator-g1-pro`, and `gemini-3.8-flash` with `low`/`medium`/`high` (`xhigh` on Hydrogen). |
| Live prompt (new models) | `gemini-4-hydrogen` at `xhigh`, `gemini-pro-orchestrator-g1-pro`, and `gemini-4-hydrogen` at `low` each streamed a reply and finished with `stop`. |
| Live prompt | `"Say hi in one short sentence."` streamed `"Hi there, how can I help you today?"` and finished with `stop`. |
| dsh approval allowed | ACP `session/request_permission` was forwarded to `ctx.approval.request`; `allowed-once` selected `allow_once`. |
| dsh approval denied | A rejection selected `reject_once`; the tool call failed. |
| No approval seam / no live agent / throwing approval | All fail closed (`reject_once` or `cancelled`). |
| `permissionMode: "reject"` | Denies without calling `ctx.approval.request` (verified by test). |
| Stale permission after the prompt settled | Rejected as `cancelled`; never shown to the user (verified by test). |
| After runs | No `agy acp` process left running. |

## 4. Findings and residual risks

**F1 — Antigravity may write files without asking (mitigated by default, not eliminated).**
In `default` session mode `agy` 1.5.x performs file writes without sending `session/request_permission`, so dsh's
approval seam cannot govern them. The plugin cannot fix this without reading or changing the CLI's own permission
settings, which is out of bounds by design. Mitigation: `sessionMode` defaults to **`plan`**, is enforced fail-closed
(if the server does not offer `plan`, the turn errors rather than running unrestricted), and `accept-edits` cannot be
selected. Users who set `"default"` accept this behaviour. Re-verify on CLI upgrade.

**F2 — Environment inheritance.** The `agy` child inherits dsh's full environment (needed for it to find `HOME`, its own
login, etc.). The plugin neither reads nor forwards any variable, but anything in dsh's environment is visible to
`agy`. This is inherent to launching the official CLI.

**F3 — Agent-reported text is displayed.** Tool-call titles, paths and command lines supplied by Antigravity are shown
in the transcript and, in debug mode only, written to the log (metadata only; prompt text is never logged). Do not
enable `debug` with a shared log destination if paths/commands are sensitive. The CLI's own stderr is relayed in debug
mode; it is credential- and email-redacted, but may still contain local paths.

**F4 — Approval needs a live dsh agent.** dsh's approval service requires an open turn and a live agent. A model call
that is not attributable to an agent (for example, an auxiliary title-generation request with no session identity)
fails closed if Antigravity asks for permission during it. This is a denial, not an escalation. A permission request
that arrives after its prompt settled is likewise rejected as stale.

**F5 — Experimental integration.** The dsh `LlmAdapter` contract is public, but this plugin is young. A future dsh
release could change the adapter contract; the failure mode is "provider does not load", not a security downgrade.
Pin versions and re-test on upgrade.

**F6 — Not a statement of Google approval.** ACP is a documented interface of the official CLI; whether third-party
clients are permitted under your account terms is a policy question this audit does not answer.

**F7 — ACP permissions are not a sandbox.** `session/request_permission` only governs operations the agent chooses to
route through it. The plugin cannot enumerate or block operations the agent performs silently. This is why
`sessionMode: "plan"` remains the default and why the audit does not claim the integration is confined. Consider
`--sandbox` in `args` (a documented `agy acp` flag) and OS-level confinement for defence in depth.

**F8 — Persistent sessions retain context.** With `sessionContinuity: true`, the ACP agent keeps the conversation
context across turns, which is the point of the feature. A divergence (compaction, fork, retry, rewritten assistant
message) causes the plugin to replay the conversation into a fresh ACP session, so the agent may see the history
again. No additional data is sent beyond the conversation dsh already holds.

**F9 — Attachments are sent to the agent.** When `imageInput` is enabled and the agent advertises image prompts,
image bytes from dsh's attachment store are base64-encoded into the ACP prompt. Files are sent as `resource_link`
URIs or embedded text. This is the user's own content and is necessary for multimodal input; it is not read from
any path the plugin chooses.

**F10 — Structured records contain agent-reported metadata.** `plugin:agy-acp/tool` records include tool titles,
kinds, paths, commands, and output text reported by the agent. They live in the dsh session log and inherit its
access controls. They never contain prompt text or credentials. If a session log is shared, treat these records like
the transcript itself.

## 5. Reproduce

```fish
cd ~/Projects/dsh-agy-acp
grep -rniE --exclude-dir=node_modules 'oauth|refresh_?token|access_?token|acp_token|anthropic|messages api' src test
grep -rnF  --exclude-dir=node_modules '.gemini' src test
grep -nE 'node:fs|process\.env|fetch\(|https?\.|node:net|spawn\(' src/*.ts
bun test
```
