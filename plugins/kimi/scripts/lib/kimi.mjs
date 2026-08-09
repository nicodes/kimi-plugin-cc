import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { binaryAvailable, runCommand } from "./process.mjs";

/**
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

export const KIMI_INSTALL_HINT =
  "Install it with `npm install -g @moonshot-ai/kimi-code` (Node >= 22.19) or `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, then rerun `/kimi:setup`.";

const RETRYABLE_EXIT_CODE = 75;
const STDERR_TAIL_LIMIT = 64 * 1024;
const RAW_STDOUT_LIMIT = 64 * 1024;
const SESSION_ID_PATTERN = /^session_[0-9a-f][0-9a-f-]*$/i;
const AUTH_STDERR_PATTERN = /\/login|\blogin\b|401|unauthorized|forbidden|api[ _-]?key|no model configured/i;

function kimiBinary(env = process.env) {
  return env.KIMI_PLUGIN_KIMI_BIN || "kimi";
}

export function getKimiAvailability(cwd, env = process.env) {
  return binaryAvailable(kimiBinary(env), ["--version"], { cwd, env });
}

export function getKimiDoctorStatus(cwd, env = process.env) {
  const result = runCommand(kimiBinary(env), ["doctor"], { cwd, env, shell: false });
  if (result.error) {
    return { healthy: false, detail: result.error.message };
  }
  const detail = (result.stdout.trim() || result.stderr.trim() || `exit ${result.status}`).trim();
  return { healthy: result.status === 0, detail };
}

export function kimiCodeHome(env = process.env) {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

// kimi doctor validates config syntax only, not authentication. The closest
// offline signal that a model/login is configured is a default_model entry in
// config.toml; real auth errors still surface on the first prompt run.
export function getKimiConfigStatus(env = process.env) {
  const configFile = path.join(kimiCodeHome(env), "config.toml");
  let content;
  try {
    content = fs.readFileSync(configFile, "utf8");
  } catch {
    return {
      configured: false,
      configFile,
      detail: "config.toml not found. Type `! kimi login` to sign in and create it."
    };
  }
  const modelMatch = content.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  if (!modelMatch) {
    return {
      configured: false,
      configFile,
      detail: "No default_model configured. Type `! kimi login` to sign in, or set default_model in config.toml."
    };
  }
  return { configured: true, configFile, detail: `default_model = ${modelMatch[1]}` };
}

export function classifyKimiFailure(exitCode, stderr, spawnError = null) {
  if (spawnError && /** @type {NodeJS.ErrnoException} */ (spawnError).code === "ENOENT") {
    return { kind: "not-installed", detail: `Kimi CLI is not installed. ${KIMI_INSTALL_HINT}` };
  }
  const stderrText = String(stderr ?? "");
  if (AUTH_STDERR_PATTERN.test(stderrText)) {
    return {
      kind: "auth",
      detail: "Kimi reported an authentication or configuration problem. Type `! kimi login` to sign in, then retry."
    };
  }
  if (exitCode === RETRYABLE_EXIT_CODE) {
    return {
      kind: "retryable",
      detail: `Kimi reported a retryable/transient error (exit ${RETRYABLE_EXIT_CODE}). Re-run the command.`
    };
  }
  return { kind: "error", detail: stderrText.trim().split(/\r?\n/).slice(-3).join("\n") || `exit ${exitCode}` };
}

export function sessionIndexPath(env = process.env) {
  return path.join(kimiCodeHome(env), "session_index.jsonl");
}

export function readSessionIndex(env = process.env) {
  let content;
  try {
    content = fs.readFileSync(sessionIndexPath(env), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.sessionId === "string") {
        entries.push(parsed);
      }
    } catch {
      // Tolerate partial writes and unknown line formats.
    }
  }
  return entries;
}

function canonicalPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function findNewSessionForWorkdir(entries, workDir, knownIds) {
  const canonicalWorkDir = canonicalPath(workDir);
  const matches = entries.filter(
    (entry) =>
      typeof entry.workDir === "string" &&
      canonicalPath(entry.workDir) === canonicalWorkDir &&
      !knownIds.has(entry.sessionId)
  );
  if (matches.length === 0) {
    return null;
  }
  return {
    sessionId: matches[matches.length - 1].sessionId,
    ambiguous: matches.length > 1
  };
}

export function knownSessionIdsForWorkdir(workDir, env = process.env) {
  const canonicalWorkDir = canonicalPath(workDir);
  const ids = new Set();
  for (const entry of readSessionIndex(env)) {
    if (typeof entry.workDir === "string" && canonicalPath(entry.workDir) === canonicalWorkDir) {
      ids.add(entry.sessionId);
    }
  }
  return ids;
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function parseToolCallArguments(rawArguments) {
  if (typeof rawArguments !== "string") {
    return rawArguments && typeof rawArguments === "object" ? rawArguments : {};
  }
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function describeToolCall(toolCall) {
  const name = String(toolCall?.function?.name ?? toolCall?.name ?? "tool");
  const args = parseToolCallArguments(toolCall?.function?.arguments);

  if (/shell|bash|exec|cmd|^run$/i.test(name)) {
    const command = String(args.command ?? args.cmd ?? "");
    return {
      message: command ? `Running command: ${shorten(command)}` : `Running tool: ${name}.`,
      phase: command && looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }

  if (/write|edit|patch|create|apply|replace|delete|remove|move|rename/i.test(name)) {
    const target = String(args.path ?? args.file ?? args.file_path ?? "");
    return {
      message: target ? `Applying file change: ${shorten(target)}` : `Applying file change (${name}).`,
      phase: "editing"
    };
  }

  return { message: `Running tool: ${name}.`, phase: "investigating" };
}

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function extractMetaSessionId(record) {
  const candidates = [record.session_id, record.sessionId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && SESSION_ID_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

class CappedBuffer {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.length = 0;
  }

  append(text) {
    if (!text) {
      return;
    }
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.limit && this.chunks.length > 1) {
      this.length -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  toString() {
    const joined = this.chunks.join("");
    return joined.length > this.limit ? joined.slice(-this.limit) : joined;
  }
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || (!message && Object.keys(extra).length === 0)) {
    return;
  }
  onProgress({ message: message ?? "", phase, ...extra });
}

export function createStreamJsonParser({ onProgress = null } = {}) {
  const state = {
    lastFinalCandidate: null,
    lastAssistantContent: null,
    sessionId: null,
    sessionIdSource: null,
    toolCallCount: 0,
    rawStdout: new CappedBuffer(RAW_STDOUT_LIMIT)
  };

  function handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      state.rawStdout.append(`${line}\n`);
      return;
    }
    if (!record || typeof record !== "object") {
      state.rawStdout.append(`${line}\n`);
      return;
    }

    if (record.role === "assistant") {
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          state.toolCallCount += 1;
          const described = describeToolCall(toolCall);
          emitProgress(onProgress, described.message, described.phase);
        }
        return;
      }
      const content = normalizeContent(record.content).trim();
      if (content) {
        state.lastAssistantContent = content;
        state.lastFinalCandidate = content;
      }
      return;
    }

    if (record.role === "tool") {
      emitProgress(onProgress, null, null, {
        message: "",
        logTitle: null,
        logBody: null
      });
      return;
    }

    if (record.role === "meta") {
      const sessionId = extractMetaSessionId(record);
      if (sessionId && !state.sessionId) {
        state.sessionId = sessionId;
        state.sessionIdSource = "meta";
        emitProgress(onProgress, `Kimi session: ${sessionId}`, null, { threadId: sessionId });
      }
      return;
    }

    state.rawStdout.append(`${line}\n`);
  }

  function finalize() {
    const finalMessage = state.lastFinalCandidate ?? state.lastAssistantContent ?? state.rawStdout.toString().trim();
    return {
      finalMessage: finalMessage || "",
      sessionId: state.sessionId,
      sessionIdSource: state.sessionIdSource,
      toolCallCount: state.toolCallCount,
      rawStdout: state.rawStdout.toString()
    };
  }

  return { handleLine, finalize };
}

export function buildKimiArgs(options = {}) {
  if (options.agent && options.resumeSessionId) {
    throw new Error(
      "Kimi cannot combine --agent with --session; resumed runs inherit the original session's agent profile."
    );
  }
  if (!options.prompt || !String(options.prompt).trim()) {
    throw new Error("A prompt is required to run Kimi.");
  }

  const args = ["-p", options.prompt, "--output-format", "stream-json"];
  if (options.resumeSessionId) {
    args.push("--session", options.resumeSessionId);
  } else if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  return args;
}

export async function runKimiTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? null;
  const args = buildKimiArgs(options);

  const knownIds = options.resumeSessionId ? null : knownSessionIdsForWorkdir(cwd, env);

  emitProgress(
    onProgress,
    options.resumeSessionId ? `Resuming Kimi session ${options.resumeSessionId}.` : "Starting Kimi.",
    "starting",
    options.resumeSessionId ? { threadId: options.resumeSessionId } : {}
  );

  const child = spawn(kimiBinary(env), args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });

  const parser = createStreamJsonParser({ onProgress });
  const stderrTail = new CappedBuffer(STDERR_TAIL_LIMIT);

  const stdoutDone = new Promise((resolve) => {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => parser.handleLine(line));
    lines.on("close", resolve);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderrTail.append(chunk));

  const { exitCode, spawnError } = await new Promise((resolve) => {
    let settled = false;
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        resolve({ exitCode: null, spawnError: error });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ exitCode: code ?? 1, spawnError: null });
      }
    });
  });
  await stdoutDone;

  const parsed = parser.finalize();
  const stderr = stderrTail.toString();

  if (spawnError) {
    const classification = classifyKimiFailure(null, stderr, spawnError);
    emitProgress(onProgress, classification.detail, "failed");
    return {
      status: 1,
      classification,
      sessionId: null,
      sessionIdSource: null,
      sessionIdAmbiguous: false,
      finalMessage: "",
      toolCallCount: 0,
      stderr,
      rawStdout: parsed.rawStdout,
      error: spawnError
    };
  }

  let sessionId = options.resumeSessionId ?? parsed.sessionId;
  let sessionIdSource = options.resumeSessionId ? "resume" : parsed.sessionIdSource;
  let sessionIdAmbiguous = false;

  if (!sessionId && knownIds) {
    const discovered = findNewSessionForWorkdir(readSessionIndex(env), cwd, knownIds);
    if (discovered) {
      sessionId = discovered.sessionId;
      sessionIdSource = "index";
      sessionIdAmbiguous = discovered.ambiguous;
      emitProgress(onProgress, `Kimi session: ${sessionId}`, null, { threadId: sessionId });
    }
  }

  if (exitCode !== 0) {
    const classification = classifyKimiFailure(exitCode, stderr);
    const firstStderrLine = stderr.trim().split(/\r?\n/).find(Boolean) ?? "";
    emitProgress(onProgress, `Kimi failed: ${firstStderrLine || classification.detail}`, "failed", {
      logTitle: "Kimi stderr (thinking/progress)",
      logBody: stderr
    });
    return {
      status: exitCode,
      classification,
      sessionId,
      sessionIdSource,
      sessionIdAmbiguous,
      finalMessage: parsed.finalMessage,
      toolCallCount: parsed.toolCallCount,
      stderr,
      rawStdout: parsed.rawStdout,
      error: null
    };
  }

  if (!parsed.finalMessage) {
    emitProgress(onProgress, "Kimi produced no final assistant message.", "failed", {
      logTitle: "Kimi stderr (thinking/progress)",
      logBody: stderr
    });
    return {
      status: 1,
      classification: { kind: "error", detail: "Kimi produced no final assistant message." },
      sessionId,
      sessionIdSource,
      sessionIdAmbiguous,
      finalMessage: "",
      toolCallCount: parsed.toolCallCount,
      stderr,
      rawStdout: parsed.rawStdout,
      error: null
    };
  }

  emitProgress(onProgress, "Final answer captured.", "finalizing", {
    logTitle: "Kimi stderr (thinking/progress)",
    logBody: stderr
  });

  return {
    status: 0,
    classification: null,
    sessionId,
    sessionIdSource,
    sessionIdAmbiguous,
    finalMessage: parsed.finalMessage,
    toolCallCount: parsed.toolCallCount,
    stderr,
    rawStdout: parsed.rawStdout,
    error: null
  };
}
