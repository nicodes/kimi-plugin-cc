---
description: Delegate a Kimi code review of local git changes to the reviewer subagent
argument-hint: "[--background|--wait] [--base <ref>] [--scope auto|working-tree|branch] [--model <alias>] [focus...]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `kimi:kimi-reviewer` subagent via the `Agent` tool (`subagent_type: "kimi:kimi-reviewer"`), forwarding the raw user request as the prompt.
`kimi:kimi-reviewer` is a subagent, not a skill — do not call `Skill(kimi:kimi-reviewer)` (no such skill) or `Skill(kimi:reviewer)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Kimi's output verbatim.

Raw user request:
$ARGUMENTS

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to route the review and return Kimi's output verbatim to the user.

Execution mode:

- If the request includes `--background`, run the `kimi:kimi-reviewer` subagent in the background.
- If the request includes `--wait`, run the `kimi:kimi-reviewer` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `review`, and do not treat them as part of the focus text.
- `--base`, `--scope`, and `--model` are review flags. Preserve them for the forwarded `review` call.
- When the user is reviewing a pull request's branch, make sure `--base <target-branch>` is pinned — the default `--scope auto` reviews the working tree when it is dirty, which may not match the PR.

Operating rules:

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" review ...` and returns that command's stdout as-is.
- Return the Kimi companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the output contains a working-tree write warning, surface it to the user prominently before the findings.
- Do not fix any issues mentioned in the review output.
- For an inline review without a subagent, `/kimi:review` runs the same review directly.
- If the helper reports that Kimi is missing or not configured, stop and tell the user to run `/kimi:setup`.
