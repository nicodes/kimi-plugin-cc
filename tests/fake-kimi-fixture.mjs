import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeKimi(binDir, behavior = "task-ok") {
  const statePath = path.join(binDir, "fake-kimi-state.json");
  const scriptPath = path.join(binDir, "kimi");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextSessionId: 1, invocations: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(record) {
  process.stdout.write(JSON.stringify(record) + "\\n");
}

function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(process.env.HOME || "", ".kimi-code");
}

function appendSessionIndex(sessionId) {
  const home = kimiHome();
  fs.mkdirSync(home, { recursive: true });
  const entry = {
    sessionId,
    sessionDir: path.join(home, "sessions", sessionId),
    workDir: process.cwd()
  };
  fs.appendFileSync(path.join(home, "session_index.jsonl"), JSON.stringify(entry) + "\\n");
}

function parseArgs(argv) {
  const parsed = { prompt: null, model: null, agent: null, session: null, continueSession: false, outputFormat: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--prompt") {
      parsed.prompt = argv[++i];
    } else if (arg === "-m" || arg === "--model") {
      parsed.model = argv[++i];
    } else if (arg === "--agent") {
      parsed.agent = argv[++i];
    } else if (arg === "-S" || arg === "--session" || arg === "-r" || arg === "--resume") {
      parsed.session = argv[++i];
    } else if (arg === "-c" || arg === "--continue") {
      parsed.continueSession = true;
    } else if (arg === "--output-format") {
      parsed.outputFormat = argv[++i];
    }
  }
  return parsed;
}

const argv = process.argv.slice(2);

if (argv[0] === "--version" || argv[0] === "-V") {
  if (BEHAVIOR === "not-installed") {
    process.exit(1);
  }
  console.log("Kimi Code 0.34.0 (fake)");
  process.exit(0);
}

if (argv[0] === "doctor") {
  if (BEHAVIOR === "doctor-fails") {
    console.error("config.toml is invalid: unexpected key");
    process.exit(1);
  }
  console.log("All checked config files are valid.");
  process.exit(0);
}

const parsed = parseArgs(argv);
const state = loadState();
state.invocations.push({ argv, cwd: process.cwd() });
saveState(state);

// Mirror the real CLI's argument constraints so regressions in arg
// construction fail tests instead of only failing live.
if (parsed.outputFormat && !parsed.prompt) {
  console.error("error: --output-format requires --prompt");
  process.exit(1);
}
if (parsed.agent && (parsed.session || parsed.continueSession)) {
  console.error("error: Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at session creation and the bound agent is restored automatically on resume.");
  process.exit(1);
}
if (!parsed.prompt) {
  console.error("error: interactive mode is not supported by the fake kimi fixture");
  process.exit(1);
}

send({ role: "meta", type: "system.version", version: "0.34.0 (fake)" });

if (BEHAVIOR === "auth-error") {
  console.error("error: failed to run prompt: 401 unauthorized. Run kimi and use /login to sign in.");
  process.exit(1);
}
if (BEHAVIOR === "retryable") {
  console.error("error: upstream timeout, retry later");
  process.exit(75);
}

const sessionId = parsed.session || ("session_" + String(state.nextSessionId));
if (!parsed.session) {
  state.nextSessionId += 1;
  saveState(state);
}

function finish(finalRecord) {
  if (BEHAVIOR !== "no-meta") {
    send({
      role: "meta",
      type: "session.resume_hint",
      session_id: sessionId,
      command: "kimi -r " + sessionId,
      content: "To resume this session: kimi -r " + sessionId
    });
  }
  if (finalRecord) {
    send(finalRecord);
  }
  if (!parsed.session) {
    appendSessionIndex(sessionId);
  }
  process.exit(0);
}

process.stderr.write("thinking: examining the request\\n");

if (BEHAVIOR === "writes-file") {
  fs.writeFileSync(path.join(process.cwd(), "fake-kimi-wrote-this.txt"), "oops\\n");
}

const toolCallId = "tool_fake_1";
send({
  role: "assistant",
  tool_calls: [
    { type: "function", id: toolCallId, function: { name: "Bash", arguments: JSON.stringify({ command: "git status" }) } }
  ]
});
send({ role: "tool", tool_call_id: toolCallId, content: "On branch main\\nnothing to commit\\n" });

if (BEHAVIOR === "no-final") {
  finish(null);
}

let finalText;
if (parsed.prompt.includes("read_only_contract") || parsed.prompt.includes("Verdict:")) {
  finalText = "Verdict: needs-attention\\n\\nSummary: One concern surfaced by the fake reviewer.\\n\\nFindings:\\n- [high] src/app.js:4 Missing empty-state guard. The change assumes data is always present.\\n\\nNext steps:\\n- Add an empty-state test.";
} else if (parsed.session || parsed.prompt.includes("Continue from the current session state")) {
  finalText = "Resumed the prior session.\\nFollow-up prompt accepted.";
} else {
  finalText = "Handled the requested task.\\nTask prompt accepted.";
}

if (BEHAVIOR === "slow-task") {
  setTimeout(() => {
    finish({ role: "assistant", content: finalText });
  }, 5000);
} else if (BEHAVIOR === "array-content") {
  finish({ role: "assistant", content: [{ type: "text", text: finalText }] });
} else {
  finish({ role: "assistant", content: finalText });
}
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0kimi" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "kimi.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function readFakeKimiState(binDir) {
  const statePath = path.join(binDir, "fake-kimi-state.json");
  if (!fs.existsSync(statePath)) {
    return { nextSessionId: 1, invocations: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function buildEnv(binDir, kimiHomeDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    KIMI_CODE_HOME: kimiHomeDir
  };
}
