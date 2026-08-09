# Changelog

## 0.2.0

- Replace the single `kimi-rescue` subagent and `/kimi:rescue` command with three explicit role subagents and commands: `/kimi:coder` (write-capable implementation), `/kimi:explorer` (strictly read-only research, enforced by a new `task --read-only` guard), and `/kimi:reviewer` (delegated review over the same runtime as `/kimi:review`).
- Resume is now role-matched: `--resume` only continues sessions created by the same role, so a coder can never silently pick up a read-only explorer session.
- `/kimi:status` labels task jobs as `coder` or `explorer` instead of `rescue`.

## 0.1.0

- Initial release, ported from codex-plugin-cc's architecture onto the Kimi CLI.
- Commands: `/kimi:setup`, `/kimi:review`, `/kimi:rescue`, `/kimi:status`, `/kimi:result`, `/kimi:cancel`.
- One-shot `kimi -p --output-format stream-json` transport with session capture and resume.
- Reviews run under the read-only `explore` agent profile with a prompt-level read-only contract and a before/after working-tree write check.
- Background task jobs with detached workers, session-scoped tracking, and process-tree cancel.
