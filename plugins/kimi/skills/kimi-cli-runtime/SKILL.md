---
name: kimi-cli-runtime
description: Internal helper contract for calling the kimi-companion runtime from Claude Code
user-invocable: false
---

# Kimi Runtime

Use this skill only inside the `kimi:kimi-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Kimi CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `status`, `result`, or `cancel` from `kimi:kimi-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, passing config aliases such as `kimi-code/k3` or `kimi-code/kimi-for-coding` through unchanged.
- Default to a write-capable Kimi run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` unchanged.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Runtime facts:
- Read-only task runs execute under Kimi's built-in `explore` agent profile, which has no write tools. `--write` runs use Kimi's default full-tool profile.
- A resumed session cannot change its agent profile: `task --resume-last --write` after a read-only run stays read-only. Start a fresh `--write` run to gain write access.
- There is no `--effort` flag; reasoning effort comes from the user's Kimi config.

Safety rules:
- Default to write-capable Kimi work in `kimi:kimi-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Kimi cannot be invoked, return nothing.
