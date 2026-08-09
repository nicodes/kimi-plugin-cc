# kimi-plugin-cc

Use [Kimi Code](https://github.com/MoonshotAI/kimi-code) from Claude Code to review code or delegate tasks.

This is a Claude Code plugin marketplace modeled on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), adapted for the Kimi CLI. Instead of a long-lived app-server, it shells out one-shot `kimi -p <prompt> --output-format stream-json` runs and parses the NDJSON stream.

## Install

1. Add the marketplace:
   ```
   /plugin marketplace add nicodes/kimi-plugin-cc
   ```
2. Install the plugin:
   ```
   /plugin install kimi@kimi-plugin-cc
   ```
3. Reload plugins:
   ```
   /reload-plugins
   ```
4. Check the toolchain:
   ```
   /kimi:setup
   ```

Requirements: Node.js >= 18.18, git, and the `kimi` CLI on PATH ([install instructions](https://moonshotai.github.io/kimi-code/)). Kimi authenticates via an interactive device-code flow — type `! kimi login` yourself when setup asks for it; Claude never runs the login for you.

## Commands

| Command | What it does |
| --- | --- |
| `/kimi:setup` | Check install, config, and `kimi doctor` health; offer to install the CLI. |
| `/kimi:review [--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch] [focus...]` | Review uncommitted changes or the branch diff inline (no subagent). Runs under Kimi's read-only `explore` agent plus a prompt-level read-only contract, and verifies afterwards that the working tree was untouched. |
| `/kimi:coder [--background\|--wait] [--resume\|--fresh] [--model <alias>] <task>` | Delegate implementation or debugging to the write-capable `kimi-coder` subagent. |
| `/kimi:explorer [--background\|--wait] [--resume\|--fresh] [--model <alias>] <question>` | Delegate strictly read-only codebase and web research to the `kimi-explorer` subagent (`explore` profile, no write tools). |
| `/kimi:reviewer [--background\|--wait] [--base <ref>] [--scope auto\|working-tree\|branch] [--model <alias>] [focus...]` | Delegate a review to the `kimi-reviewer` subagent — same review runtime as `/kimi:review`, routed through an agent so it composes with the coder/explorer hierarchy. |
| `/kimi:status [job-id] [--wait] [--all]` | Show active and recent Kimi jobs for this repository. |
| `/kimi:result [job-id]` | Show the stored final output of a finished job, with a `kimi --session <id>` resume hint. |
| `/kimi:cancel [job-id]` | Kill an active background job (process-tree kill; the Kimi CLI has no interrupt API). |

Suggested first run: `/kimi:review --background`, then `/kimi:status`, then `/kimi:result`.

## Behavior notes

- **Read-only enforcement is two-layered.** Reviews and read-only tasks run with `--agent explore` (no write tools in that profile) *and* a `<read_only_contract>` prompt block; the companion snapshots `git status` before and after and prepends a loud warning if the tree changed anyway.
- **Sessions.** Every run's Kimi session id is captured (from the `session.resume_hint` stream record, falling back to `~/.kimi-code/session_index.jsonl`) and stored on the job record. `--resume` continues the most recent tracked task session via `kimi --session <id>`. A resumed session keeps the agent profile it was created with, so resume is role-matched: `/kimi:coder --resume` only continues coder (write-capable) sessions and `/kimi:explorer --resume` only explorer sessions.
- **Model selection** defaults to your Kimi config (`default_model` in `~/.kimi-code/config.toml`). Pass `--model <alias>` (e.g. `kimi-code/k3`, `kimi-code/kimi-for-coding`) to override per run. There is no `--effort` flag; thinking effort comes from Kimi config.
- **Environment overrides:** `KIMI_PLUGIN_KIMI_BIN` (path to the kimi binary), `KIMI_CODE_HOME` (Kimi home directory, honored for session-index discovery).

## Development

```
npm test
```

Tests run against a fake `kimi` binary (`tests/fake-kimi-fixture.mjs`) that emits canned stream-json and enforces the real CLI's flag constraints. No Kimi install or account is needed to run the suite.

## Appendix: verified CLI behavior (kimi-code 0.34.0)

The design rests on these probed behaviors; re-verify them when the CLI majorly changes:

- `--agent explore` combines with `-p`; the explore profile has read-only tools (Read, Grep, Glob, read-only Bash) and refuses file writes.
- `-p --output-format stream-json` emits NDJSON: a `{"role":"meta","type":"system.version"}` record, OpenAI-chat-shaped `assistant`/`tool` records (tool names like `Bash`, `Read`; `arguments` is a JSON string; assistant records with `tool_calls` carry no `content`), and a final `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>"}` record.
- `-S/--session <id>` combines with `-p` and resumes with full session memory.
- `--agent` + `--session`/`--continue` is rejected (exit 1): "the agent is bound at session creation".
- `~/.kimi-code/session_index.jsonl` gains one `{sessionId, sessionDir, workDir}` line per completed headless run.
- With an empty `KIMI_CODE_HOME`, `kimi -p` exits 1 with "No model configured. Run `kimi` and use /login…" on stderr — but `kimi doctor` still exits 0 (doctor validates config syntax only, not auth), which is why setup checks `default_model` in config.toml separately.
- A ~24 KB prompt passes through argv fine on Linux; the inline-diff budget is capped at 24 KB for Windows argv safety.
