# Security audit — dsh-agy-acp

Scope: everything in this directory except third-party `node_modules/` (source, tests, config, docs, lockfile).
Method: (1) keyword search for every credential-related term plus variants, (2) a behavioural search of `src/` for
every filesystem / environment / network / process API, (3) live experiments against the real `agy` 1.5.3 and dsh
0.2.2-rc.1.

**Conclusion:** the plugin contains no code that reads, copies, parses, exports, refreshes, stores or transmits Google
credentials, implements OAuth, proxies any API, or contacts any network endpoint. Every keyword hit below is either a
*defensive* control (rejecting or redacting), a test of that control, or the name of an unrelated field.

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
| Filesystem | One write: `appendFileSync` in `src/log.ts`, to the log file the **user** configured (or stderr). No reads, no directory listing, no home-directory lookups. `process.cwd()` is used only as the ACP session's working directory when no live dsh agent provides one. |
| Environment | No `process.env` access. (The child inherits dsh's environment by Node's default; the plugin neither reads nor alters it. See residual risk F2.) |
| Network | No `fetch`, `http(s)`, `net`, `tls`, WebSocket or socket code. The plugin's only I/O is the child's stdin/stdout/stderr. |
| Processes | One `spawn(command, args)` in `src/acp-process.ts` — the configured Antigravity CLI. No shell (`shell` option is not set), no `exec`. |
| Protocol | All JSON-RPC framing is `@agentclientprotocol/sdk` (`ndJsonStream`). stdout is the protocol channel and is never logged to; stderr is drained separately and goes only to the logger (credential- and email-redacted). |
| `agy -p` / headless | Not used anywhere. |
| Authentication calls | `authenticate` / `logout` / `--login` are never invoked; `--login` is a rejected argument. On "auth required" the plugin only tells the user to log in with the CLI. |
| dsh approval | The plugin calls `ctx.approval.request` with a tool name and a reason. It never grants an approval itself; a missing agent, missing seam, error, or cancellation denies. |
| Dependencies | Runtime: `@agentclientprotocol/sdk` 2.4.0 and `@deepseek-ai/schemastery` ~3.19.0. The dsh packages are peer dependencies supplied by the host. |

## 3. Behaviour verified on the real system

| Check | Outcome |
|---|---|
| Server's model list includes Claude / GPT-OSS entries | Not exposed; only the 2 Gemini families (3 thinking levels) were registered. |
| Live discovery | `session/new` reported 13 advertised models; the adapter exposed `gemini-4-argon` and `gemini-3.8-flash` with `low`/`medium`/`high`. |
| Live prompt | `"Say hi in one short sentence."` streamed `"Hi there, how can I help you today?"` and finished with `stop`. |
| dsh approval allowed | ACP `session/request_permission` was forwarded to `ctx.approval.request`; `allowed-once` selected `allow_once`. |
| dsh approval denied | A rejection selected `reject_once`; the tool call failed. |
| No approval seam / no live agent / throwing approval | All fail closed (`reject_once` or `cancelled`). |
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
fails closed if Antigravity asks for permission during it. This is a denial, not an escalation.

**F5 — Experimental integration.** The dsh `LlmAdapter` contract is public, but this plugin is young. A future dsh
release could change the adapter contract; the failure mode is "provider does not load", not a security downgrade.
Pin versions and re-test on upgrade.

**F6 — Not a statement of Google approval.** ACP is a documented interface of the official CLI; whether third-party
clients are permitted under your account terms is a policy question this audit does not answer.

## 5. Reproduce

```fish
cd ~/Projects/dsh-agy-acp
grep -rniE --exclude-dir=node_modules 'oauth|refresh_?token|access_?token|acp_token|anthropic|messages api' src test
grep -rnF  --exclude-dir=node_modules '.gemini' src test
grep -nE 'node:fs|process\.env|fetch\(|https?\.|node:net|spawn\(' src/*.ts
bun test
```
