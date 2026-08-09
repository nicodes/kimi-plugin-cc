---
description: Send the read-only Kimi explorer subagent to research the codebase and the web
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <alias>] <research question>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `kimi:kimi-explorer` subagent via the `Agent` tool (`subagent_type: "kimi:kimi-explorer"`), forwarding the raw user request as the prompt.
`kimi:kimi-explorer` is a subagent, not a skill — do not call `Skill(kimi:kimi-explorer)` (no such skill) or `Skill(kimi:explorer)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Kimi's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `kimi:kimi-explorer` subagent in the background.
- If the request includes `--wait`, run the `kimi:kimi-explorer` subagent in the foreground.
- If neither flag is present, default to foreground for a narrow question and background for broad or open-ended research.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the research question.
- `--model`, `--resume`, and `--fresh` are routing flags. Preserve them for the forwarded call, but do not treat them as part of the research question.
- Do not run a resume-candidate check for explorers. Forward `--resume` only when the user passed it explicitly.

Operating rules:

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task --read-only ...` and returns that command's stdout as-is.
- This command is strictly read-only: nothing gets built, fixed, or changed. The run executes under Kimi's `explore` agent profile, which has no write tools, and the companion rejects `--read-only --write`.
- Return the Kimi companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/kimi:status`, fetch `/kimi:result`, call `/kimi:cancel`, summarize output, or do follow-up work of its own.
- Implementation requests belong to `/kimi:coder`; reviews belong to `/kimi:reviewer` or `/kimi:review`. Redirect the user rather than forcing them through the explorer.
- If the helper reports that Kimi is missing or not configured, stop and tell the user to run `/kimi:setup`.
- If the user did not supply a question, ask what Kimi should research.
