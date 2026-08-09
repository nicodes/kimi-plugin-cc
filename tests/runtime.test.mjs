import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeKimi, readFakeKimiState } from "./fake-kimi-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "kimi", "scripts", "kimi-companion.mjs");
const HOOK = path.join(ROOT, "plugins", "kimi", "scripts", "session-lifecycle-hook.mjs");

function makeFixture(behavior = "task-ok", options = {}) {
  const binDir = makeTempDir();
  const kimiHome = path.join(makeTempDir(), ".kimi-code");
  const workDir = makeTempDir();
  const pluginData = makeTempDir();
  installFakeKimi(binDir, behavior);

  if (options.configured !== false) {
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(path.join(kimiHome, "config.toml"), 'default_model = "kimi-code/k3"\n');
  }

  initGitRepo(workDir);
  fs.writeFileSync(path.join(workDir, "app.js"), "console.log('v1');\n");
  run("git", ["add", "."], { cwd: workDir });
  run("git", ["commit", "-m", "init"], { cwd: workDir });

  const env = {
    ...buildEnv(binDir, kimiHome),
    CLAUDE_PLUGIN_DATA: pluginData
  };
  delete env.KIMI_COMPANION_SESSION_ID;

  return { binDir, kimiHome, workDir, pluginData, env };
}

function companion(fixture, args, options = {}) {
  return run("node", [COMPANION, ...args], {
    cwd: fixture.workDir,
    env: { ...fixture.env, ...(options.env ?? {}) },
    input: options.input
  });
}

async function waitFor(predicate, timeoutMs = 15000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("setup reports ready when kimi, config, and doctor are healthy", () => {
  const fixture = makeFixture("task-ok");

  const result = companion(fixture, ["setup", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.kimi.available, true);
  assert.equal(report.config.configured, true);
  assert.equal(report.doctor.healthy, true);
});

test("setup points at install and login when kimi is missing or unconfigured", () => {
  const missing = makeFixture("not-installed");
  const missingResult = companion(missing, ["setup", "--json"]);
  const missingReport = JSON.parse(missingResult.stdout);
  assert.equal(missingReport.ready, false);
  assert.equal(missingReport.kimi.available, false);
  assert.match(missingReport.nextSteps.join("\n"), /Install the Kimi Code CLI/);

  const unconfigured = makeFixture("task-ok", { configured: false });
  const unconfiguredResult = companion(unconfigured, ["setup", "--json"]);
  const unconfiguredReport = JSON.parse(unconfiguredResult.stdout);
  assert.equal(unconfiguredReport.ready, false);
  assert.match(unconfiguredReport.nextSteps.join("\n"), /! kimi login/);
});

test("setup reports doctor failures", () => {
  const fixture = makeFixture("doctor-fails");

  const report = JSON.parse(companion(fixture, ["setup", "--json"]).stdout);

  assert.equal(report.ready, false);
  assert.equal(report.doctor.healthy, false);
  assert.match(report.nextSteps.join("\n"), /kimi doctor/);
});

test("review runs under the explore agent with the read-only contract and reports findings", () => {
  const fixture = makeFixture("task-ok");
  fs.writeFileSync(path.join(fixture.workDir, "app.js"), "console.log('v2');\n");

  const result = companion(fixture, ["review"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Kimi Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.doesNotMatch(result.stdout, /WARNING: the review run modified the working tree/);

  const invocation = readFakeKimiState(fixture.binDir).invocations.at(-1);
  assert.ok(invocation.argv.includes("--agent"), "review must pass --agent");
  assert.equal(invocation.argv[invocation.argv.indexOf("--agent") + 1], "explore");
  const prompt = invocation.argv[invocation.argv.indexOf("-p") + 1];
  assert.match(prompt, /read_only_contract/);
  assert.match(prompt, /Verdict:/);
  assert.match(prompt, /working tree diff/);
});

test("review warns loudly when the run modifies the working tree", () => {
  const fixture = makeFixture("writes-file");
  fs.writeFileSync(path.join(fixture.workDir, "app.js"), "console.log('v2');\n");

  const result = companion(fixture, ["review"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING: the review run modified the working tree/);
  assert.match(result.stdout, /fake-kimi-wrote-this\.txt/);
});

test("review passes focus text and forwards the model alias", () => {
  const fixture = makeFixture("task-ok");
  fs.writeFileSync(path.join(fixture.workDir, "app.js"), "console.log('v2');\n");

  const result = companion(fixture, ["review", "--model", "kimi-code/k3", "concurrency issues"]);

  assert.equal(result.status, 0, result.stderr);
  const invocation = readFakeKimiState(fixture.binDir).invocations.at(-1);
  const prompt = invocation.argv[invocation.argv.indexOf("-p") + 1];
  assert.match(prompt, /concurrency issues/);
  assert.equal(invocation.argv[invocation.argv.indexOf("-m") + 1], "kimi-code/k3");
});

test("task defaults to the read-only explore agent and --write drops it", () => {
  const fixture = makeFixture("task-ok");

  const readOnly = companion(fixture, ["task", "inspect the repo"]);
  assert.equal(readOnly.status, 0, readOnly.stderr);
  assert.match(readOnly.stdout, /Handled the requested task/);
  let invocation = readFakeKimiState(fixture.binDir).invocations.at(-1);
  assert.ok(invocation.argv.includes("--agent"));
  assert.equal(invocation.argv[invocation.argv.indexOf("--agent") + 1], "explore");

  const write = companion(fixture, ["task", "--write", "fix the bug"]);
  assert.equal(write.status, 0, write.stderr);
  invocation = readFakeKimiState(fixture.binDir).invocations.at(-1);
  assert.ok(!invocation.argv.includes("--agent"), "--write tasks must not pin an agent profile");
});

test("task --resume-last resumes the tracked session without an agent flag", () => {
  const fixture = makeFixture("task-ok");

  const first = companion(fixture, ["task", "start the work"]);
  assert.equal(first.status, 0, first.stderr);

  const resumed = companion(fixture, ["task", "--resume-last", "keep going"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed the prior session/);
  assert.match(resumed.stdout, /write capability follows the original session/);

  const invocation = readFakeKimiState(fixture.binDir).invocations.at(-1);
  assert.ok(invocation.argv.includes("--session"));
  assert.equal(invocation.argv[invocation.argv.indexOf("--session") + 1], "session_1");
  assert.ok(!invocation.argv.includes("--agent"));
});

test("task --resume-last without a tracked session suggests a fresh start", () => {
  const fixture = makeFixture("task-ok");

  const result = companion(fixture, ["task", "--resume-last"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous read-only \(explorer\) Kimi session is tracked/);
});

test("task rejects --read-only combined with --write", () => {
  const fixture = makeFixture("task-ok");

  const result = companion(fixture, ["task", "--read-only", "--write", "do something"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --write or --read-only/);
});

test("resume is role-matched: a coder cannot resume an explorer session", () => {
  const fixture = makeFixture("task-ok");

  const explorerRun = companion(fixture, ["task", "--read-only", "research the repo"]);
  assert.equal(explorerRun.status, 0, explorerRun.stderr);

  const coderResume = companion(fixture, ["task", "--resume-last", "--write", "now fix it"]);
  assert.notEqual(coderResume.status, 0);
  assert.match(coderResume.stderr, /No previous write-capable \(coder\) Kimi session is tracked/);

  const explorerResume = companion(fixture, ["task", "--resume-last", "--read-only", "dig deeper"]);
  assert.equal(explorerResume.status, 0, explorerResume.stderr);
  assert.match(explorerResume.stdout, /Resumed the prior session/);
});

test("task-resume-candidate filters by role", () => {
  const fixture = makeFixture("task-ok");

  companion(fixture, ["task", "--read-only", "research something"]);

  const writeCandidate = JSON.parse(companion(fixture, ["task-resume-candidate", "--write", "--json"]).stdout);
  assert.equal(writeCandidate.available, false);

  const readOnlyCandidate = JSON.parse(companion(fixture, ["task-resume-candidate", "--read-only", "--json"]).stdout);
  assert.equal(readOnlyCandidate.available, true);
  assert.equal(readOnlyCandidate.candidate.threadId, "session_1");
});

test("status labels task jobs by role", () => {
  const fixture = makeFixture("task-ok");

  companion(fixture, ["task", "--read-only", "explore work"]);
  companion(fixture, ["task", "--write", "coder work"]);

  const report = JSON.parse(companion(fixture, ["status", "--json"]).stdout);
  const labels = [report.latestFinished, ...report.recent].filter(Boolean).map((job) => job.kindLabel).sort();
  assert.deepEqual(labels, ["coder", "explorer"]);
});

test("task surfaces auth failures with login guidance", () => {
  const fixture = makeFixture("auth-error");

  const result = companion(fixture, ["task", "do something"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Kimi task failed/);
  assert.match(result.stdout, /! kimi login/);
});

test("task surfaces retryable failures with the exit-75 hint", () => {
  const fixture = makeFixture("retryable");

  const result = companion(fixture, ["task", "do something"]);

  assert.equal(result.status, 75);
  assert.match(result.stdout, /retryable\/transient error \(exit 75\)/);
});

test("background task runs end-to-end through the detached worker", async () => {
  const fixture = makeFixture("task-ok");

  const launch = companion(fixture, ["task", "--background", "long running work"]);
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /started in the background as (task-[a-z0-9-]+)/);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)[1];

  await waitFor(() => {
    const status = companion(fixture, ["status", jobId, "--json"]);
    const snapshot = JSON.parse(status.stdout);
    return snapshot.job.status === "completed" ? snapshot : null;
  });

  const result = companion(fixture, ["result", jobId]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, /Kimi session ID: session_1/);
  assert.match(result.stdout, /Resume in Kimi: kimi --session session_1/);
});

test("cancel kills a running background task", async () => {
  const fixture = makeFixture("slow-task");

  const launch = companion(fixture, ["task", "--background", "slow work"]);
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)[1];

  await waitFor(() => {
    const status = companion(fixture, ["status", jobId, "--json"]);
    const snapshot = JSON.parse(status.stdout);
    return snapshot.job.status === "running" ? snapshot : null;
  });

  const cancel = companion(fixture, ["cancel", jobId]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /Cancelled task-/);

  const status = companion(fixture, ["status", jobId, "--json"]);
  assert.equal(JSON.parse(status.stdout).job.status, "cancelled");
});

test("status renders the workspace overview", () => {
  const fixture = makeFixture("task-ok");
  companion(fixture, ["task", "first thing"]);

  const result = companion(fixture, ["status"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Kimi Status/);
  assert.match(result.stdout, /Kimi session ID: session_1/);
  assert.match(result.stdout, /Resume in Kimi: kimi --session session_1/);
});

test("task-resume-candidate reports tracked sessions", () => {
  const fixture = makeFixture("task-ok");

  const before = JSON.parse(companion(fixture, ["task-resume-candidate", "--json"]).stdout);
  assert.equal(before.available, false);

  companion(fixture, ["task", "trackable work"]);

  const after = JSON.parse(companion(fixture, ["task-resume-candidate", "--json"]).stdout);
  assert.equal(after.available, true);
  assert.equal(after.candidate.threadId, "session_1");
});

test("jobs are scoped to the Claude session id when one is set", () => {
  const fixture = makeFixture("task-ok");
  const sessionEnv = { KIMI_COMPANION_SESSION_ID: "claude-session-a" };

  companion(fixture, ["task", "session scoped work"], { env: sessionEnv });

  const sameSession = JSON.parse(
    companion(fixture, ["task-resume-candidate", "--json"], { env: sessionEnv }).stdout
  );
  assert.equal(sameSession.available, true);

  const otherSession = JSON.parse(
    companion(fixture, ["task-resume-candidate", "--json"], { env: { KIMI_COMPANION_SESSION_ID: "claude-session-b" } }).stdout
  );
  assert.equal(otherSession.available, false);
});

test("SessionStart hook exports env vars and SessionEnd prunes session jobs", async () => {
  const fixture = makeFixture("slow-task");
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "");

  const startResult = run("node", [HOOK, "SessionStart"], {
    cwd: fixture.workDir,
    env: { ...fixture.env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({ session_id: "claude-session-hook" })
  });
  assert.equal(startResult.status, 0, startResult.stderr);
  const envContent = fs.readFileSync(envFile, "utf8");
  assert.match(envContent, /export KIMI_COMPANION_SESSION_ID='claude-session-hook'/);
  assert.match(envContent, /export CLAUDE_PLUGIN_DATA=/);

  const sessionEnv = { KIMI_COMPANION_SESSION_ID: "claude-session-hook" };
  const launch = companion(fixture, ["task", "--background", "slow work"], { env: sessionEnv });
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)[1];
  await waitFor(() => {
    const status = companion(fixture, ["status", jobId, "--json"]);
    return JSON.parse(status.stdout).job.status === "running" ? true : null;
  });

  const endResult = run("node", [HOOK, "SessionEnd"], {
    cwd: fixture.workDir,
    env: { ...fixture.env, ...sessionEnv },
    input: JSON.stringify({ session_id: "claude-session-hook", cwd: fixture.workDir })
  });
  assert.equal(endResult.status, 0, endResult.stderr);

  const status = companion(fixture, ["status", "--json"]);
  const report = JSON.parse(status.stdout);
  assert.equal(report.running.length, 0);
  assert.equal(report.latestFinished, null);
  assert.equal(report.recent.length, 0);
});
