---
description: Check whether the local Kimi Code CLI is installed, configured, and healthy
argument-hint: ''
allowed-tools: Bash(node:*), Bash(npm:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup --json
```

If the result says Kimi is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Kimi Code now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Kimi Code (Recommended)`
  - `Skip for now`
- If the user chooses install and Node.js is version 22.19 or newer, run:

```bash
npm install -g @moonshot-ai/kimi-code
```

- If Node.js is older than 22.19, use the standalone installer instead:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup --json
```

If Kimi is already installed or npm is unavailable:
- Do not ask about installation.

Authentication rules:
- Kimi uses an interactive device-code login. Claude must never run `kimi login` itself.
- If the report says Kimi is installed but not configured or not signed in, tell the user to type `! kimi login` in the prompt so the login runs in their own session.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- Present the `kimi doctor` output verbatim when it reports problems; doctor is the authority on config validity.
