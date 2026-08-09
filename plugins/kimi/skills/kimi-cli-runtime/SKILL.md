---
name: kimi-cli-runtime
description: Internal helper contract for calling the kimi-companion runtime from Claude Code
user-invocable: false
---

# Kimi Runtime

Use this skill only inside the `kimi:kimi-coder`, `kimi:kimi-explorer`, and `kimi:kimi-reviewer` subagents.

Per-role helper contract — each role invokes exactly one companion subcommand, once:

| Role | Helper invocation | Notes |
|---|---|---|
| `kimi:kimi-coder` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task --write "<raw arguments>"` | Always `--write`; runs Kimi's default full-tool profile |
| `kimi:kimi-explorer` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task --read-only "<raw arguments>"` | Always `--read-only`, never `--write` (the companion rejects the combination); runs Kimi's `explore` profile, which has no write tools |
| `kimi:kimi-reviewer` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" review "<raw arguments>"` | Forward `--base`/`--scope`/focus text; pin `--base <target-branch>` for PR reviews |

Execution rules:
- Each subagent is a forwarder, not an orchestrator. Its only job is to invoke its helper subcommand once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Kimi CLI strings, or any other Bash activity.
- No role calls `setup`, `status`, `result`, or `cancel`; the coder and explorer never call `review`, and the reviewer never calls `task`.
- Prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, passing config aliases such as `kimi-code/k3` or `kimi-code/kimi-for-coding` through unchanged.

Routing flags (coder and explorer):
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous run of the same role.

Runtime facts:
- Resume is role-matched: `task --write --resume-last` only resumes previous coder (write-capable) sessions, and `task --read-only --resume-last` only resumes previous explorer sessions. A resumed session cannot change its agent profile.
- There is no `--effort` flag; reasoning effort comes from the user's Kimi config.
- `/kimi:status` shows coder, explorer, and review jobs with distinct kind labels.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the helper command exactly as-is.
- If the Bash call fails or Kimi cannot be invoked, return nothing.
