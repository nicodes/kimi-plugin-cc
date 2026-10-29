---
description: Delegate an implementation, debugging, or fix task to the write-capable Kimi coder subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <alias>] [what Kimi should implement, debug, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `kimi:kimi-coder` subagent via the `Agent` tool (`subagent_type: "kimi:kimi-coder"`), forwarding the raw user request as the prompt.
`kimi:kimi-coder` is a subagent, not a skill — do not call `Skill(kimi:kimi-coder)` (no such skill) or `Skill(kimi:coder)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Kimi's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `kimi:kimi-coder` subagent in the background.
- If the request includes `--wait`, run the `kimi:kimi-coder` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Kimi, check for a resumable coder session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task-resume-candidate --write --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Kimi session or start a new one.
- The two choices must be:
  - `Continue current Kimi session`
  - `Start a new Kimi session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Kimi session (Recommended)` first.
- Otherwise put `Start a new Kimi session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task --write ...` and returns that command's stdout as-is.
- Return the Kimi companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/kimi:status`, fetch `/kimi:result`, call `/kimi:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one. Pass config aliases such as `kimi-code/k3` or `kimi-code/kimi-for-coding` through with `--model`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- Research-only requests belong to `/kimi:explorer`; reviews belong to `/kimi:reviewer` or `/kimi:review`. Redirect the user rather than forcing them through the coder.
- If the helper reports that Kimi is missing or not configured, stop and tell the user to run `/kimi:setup`.
- If the user did not supply a request, ask what Kimi should implement or fix.
