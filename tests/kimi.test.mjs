import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeKimi, readFakeKimiState } from "./fake-kimi-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildKimiArgs,
  classifyKimiFailure,
  createStreamJsonParser,
  describeToolCall,
  findNewSessionForWorkdir,
  getKimiAvailability,
  readSessionIndex,
  runKimiTurn
} from "../plugins/kimi/scripts/lib/kimi.mjs";

function makeFixture(behavior = "task-ok") {
  const binDir = makeTempDir();
  const kimiHome = path.join(makeTempDir(), ".kimi-code");
  const workDir = makeTempDir();
  installFakeKimi(binDir, behavior);
  return { binDir, kimiHome, workDir, env: buildEnv(binDir, kimiHome) };
}

test("buildKimiArgs builds a fresh explore invocation", () => {
  const args = buildKimiArgs({ prompt: "do it", agent: "explore", model: "kimi-code/k3" });
  assert.deepEqual(args, ["-p", "do it", "--output-format", "stream-json", "--agent", "explore", "-m", "kimi-code/k3"]);
});

test("buildKimiArgs builds a resume invocation without an agent flag", () => {
  const args = buildKimiArgs({ prompt: "continue", resumeSessionId: "session_9" });
  assert.deepEqual(args, ["-p", "continue", "--output-format", "stream-json", "--session", "session_9"]);
});

test("buildKimiArgs rejects agent combined with resume", () => {
  assert.throws(() => buildKimiArgs({ prompt: "x", agent: "explore", resumeSessionId: "session_1" }), /cannot combine --agent/i);
});

test("stream parser extracts the last final assistant message", () => {
  const parser = createStreamJsonParser();
  parser.handleLine(JSON.stringify({ role: "meta", type: "system.version", version: "0.34.0" }));
  parser.handleLine(
    JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "t1", function: { name: "Bash", arguments: '{"command":"npm test"}' } }]
    })
  );
  parser.handleLine(JSON.stringify({ role: "tool", tool_call_id: "t1", content: "ok" }));
  parser.handleLine(JSON.stringify({ role: "assistant", content: "intermediate note" }));
  parser.handleLine(JSON.stringify({ role: "assistant", content: "final answer" }));
  parser.handleLine(
    JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_abc123", command: "kimi -r session_abc123" })
  );

  const result = parser.finalize();
  assert.equal(result.finalMessage, "final answer");
  assert.equal(result.sessionId, "session_abc123");
  assert.equal(result.sessionIdSource, "meta");
  assert.equal(result.toolCallCount, 1);
});

test("stream parser handles text-part array content", () => {
  const parser = createStreamJsonParser();
  parser.handleLine(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }));
  assert.equal(parser.finalize().finalMessage, "part one part two");
});

test("stream parser tolerates unparseable lines and empty output", () => {
  const parser = createStreamJsonParser();
  parser.handleLine("this is not json");
  const result = parser.finalize();
  assert.equal(result.finalMessage, "this is not json");
});

test("describeToolCall maps tool names onto job phases", () => {
  assert.equal(describeToolCall({ function: { name: "Bash", arguments: '{"command":"npm test"}' } }).phase, "verifying");
  assert.equal(describeToolCall({ function: { name: "Bash", arguments: '{"command":"ls"}' } }).phase, "running");
  assert.equal(describeToolCall({ function: { name: "Write", arguments: '{"path":"a.txt"}' } }).phase, "editing");
  assert.equal(describeToolCall({ function: { name: "Read", arguments: '{"path":"a.txt"}' } }).phase, "investigating");
  assert.equal(describeToolCall({ function: { name: "Grep", arguments: "{}" } }).phase, "investigating");
});

test("classifyKimiFailure detects install, auth, and retryable failures", () => {
  assert.equal(classifyKimiFailure(null, "", { code: "ENOENT" }).kind, "not-installed");
  assert.equal(classifyKimiFailure(1, "error: 401 unauthorized").kind, "auth");
  assert.equal(classifyKimiFailure(1, "No model configured. Run `kimi` and use /login to sign in.").kind, "auth");
  assert.equal(classifyKimiFailure(75, "upstream timeout").kind, "retryable");
  assert.equal(classifyKimiFailure(2, "boom").kind, "error");
});

test("findNewSessionForWorkdir picks the newest unknown session for the workdir", () => {
  const workDir = makeTempDir();
  const otherDir = makeTempDir();
  const entries = [
    { sessionId: "session_1", workDir },
    { sessionId: "session_2", workDir: otherDir },
    { sessionId: "session_3", workDir }
  ];

  const found = findNewSessionForWorkdir(entries, workDir, new Set(["session_1"]));
  assert.equal(found.sessionId, "session_3");
  assert.equal(found.ambiguous, false);

  const ambiguous = findNewSessionForWorkdir(entries, workDir, new Set());
  assert.equal(ambiguous.sessionId, "session_3");
  assert.equal(ambiguous.ambiguous, true);

  assert.equal(findNewSessionForWorkdir(entries, workDir, new Set(["session_1", "session_3"])), null);
});

test("runKimiTurn completes a task run and captures the session id from the meta record", async () => {
  const { workDir, env } = makeFixture("task-ok");
  const events = [];

  const result = await runKimiTurn(workDir, {
    prompt: "Do the thing",
    env,
    onProgress: (event) => events.push(event)
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "Handled the requested task.\nTask prompt accepted.");
  assert.equal(result.sessionId, "session_1");
  assert.equal(result.sessionIdSource, "meta");
  assert.equal(result.toolCallCount, 1);
  assert.ok(events.some((event) => event.phase === "running"));
});

test("runKimiTurn falls back to the session index when no meta record is emitted", async () => {
  const { workDir, env } = makeFixture("no-meta");

  const result = await runKimiTurn(workDir, { prompt: "Do the thing", env });

  assert.equal(result.status, 0);
  assert.equal(result.sessionId, "session_1");
  assert.equal(result.sessionIdSource, "index");
  assert.equal(result.sessionIdAmbiguous, false);
});

test("runKimiTurn passes resume flags and never the agent flag on resume", async () => {
  const { binDir, workDir, env } = makeFixture("task-ok");

  const result = await runKimiTurn(workDir, { prompt: "continue please", resumeSessionId: "session_7", env });

  assert.equal(result.status, 0);
  assert.equal(result.sessionId, "session_7");
  assert.match(result.finalMessage, /Resumed the prior session/);
  const invocation = readFakeKimiState(binDir).invocations.at(-1);
  assert.ok(invocation.argv.includes("--session"));
  assert.ok(!invocation.argv.includes("--agent"));
});

test("runKimiTurn classifies auth failures", async () => {
  const { workDir, env } = makeFixture("auth-error");

  const result = await runKimiTurn(workDir, { prompt: "hello", env });

  assert.notEqual(result.status, 0);
  assert.equal(result.classification.kind, "auth");
  assert.match(result.stderr, /401 unauthorized/);
});

test("runKimiTurn classifies retryable failures", async () => {
  const { workDir, env } = makeFixture("retryable");

  const result = await runKimiTurn(workDir, { prompt: "hello", env });

  assert.equal(result.status, 75);
  assert.equal(result.classification.kind, "retryable");
});

test("runKimiTurn fails cleanly when no final assistant message arrives", async () => {
  const { workDir, env } = makeFixture("no-final");

  const result = await runKimiTurn(workDir, { prompt: "hello", env });

  assert.equal(result.status, 1);
  assert.match(result.classification.detail, /no final assistant message/);
});

test("runKimiTurn reports a missing binary as not-installed", async () => {
  const binDir = makeTempDir();
  const workDir = makeTempDir();
  const env = { ...process.env, KIMI_PLUGIN_KIMI_BIN: path.join(binDir, "does-not-exist"), KIMI_CODE_HOME: makeTempDir() };

  const result = await runKimiTurn(workDir, { prompt: "hello", env });

  assert.equal(result.status, 1);
  assert.equal(result.classification.kind, "not-installed");
});

test("getKimiAvailability and readSessionIndex work against the fake install", async () => {
  const { binDir, workDir, kimiHome, env } = makeFixture("array-content");

  const availability = getKimiAvailability(workDir, env);
  assert.equal(availability.available, true);
  assert.match(availability.detail, /fake/);

  const result = await runKimiTurn(workDir, { prompt: "hello", env });
  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);

  const entries = readSessionIndex(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, "session_1");
  assert.equal(fs.existsSync(path.join(kimiHome, "session_index.jsonl")), true);
  assert.equal(readFakeKimiState(binDir).invocations.length, 1);
});
