# Changelog

## 0.1.0

- Initial release, ported from codex-plugin-cc's architecture onto the Kimi CLI.
- Commands: `/kimi:setup`, `/kimi:review`, `/kimi:rescue`, `/kimi:status`, `/kimi:result`, `/kimi:cancel`.
- One-shot `kimi -p --output-format stream-json` transport with session capture and resume.
- Reviews run under the read-only `explore` agent profile with a prompt-level read-only contract and a before/after working-tree write check.
- Background task jobs with detached workers, session-scoped tracking, and process-tree cancel.
