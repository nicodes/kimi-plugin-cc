#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  DEFAULT_CONTINUE_PROMPT,
  getKimiAvailability,
  getKimiConfigStatus,
  getKimiDoctorStatus,
  KIMI_INSTALL_HINT,
  runKimiTurn
} from "./lib/kimi.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { captureStatusSnapshot, collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { generateJobId, listJobs, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// Verified against kimi-code 0.34.0: --agent combines with -p, and the built-in
// explore profile has no write tools, making it the review sandbox.
const REVIEW_AGENT = "explore";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/kimi-companion.mjs setup [--json]",
      "  node scripts/kimi-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <alias>] [focus text]",
      "  node scripts/kimi-companion.mjs task [--background] [--write|--read-only] [--resume-last|--resume|--fresh] [--model <alias>] [--prompt-file <path>] [prompt]",
      "  node scripts/kimi-companion.mjs task-worker --job-id <id>",
      "  node scripts/kimi-companion.mjs task-resume-candidate [--write|--read-only] [--json]",
      "  node scripts/kimi-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/kimi-companion.mjs result [job-id] [--json]",
      "  node scripts/kimi-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  return normalized || null;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const kimiStatus = getKimiAvailability(cwd);
  const configStatus = kimiStatus.available
    ? getKimiConfigStatus()
    : { configured: false, detail: "skipped (kimi is not installed)" };
  const doctorStatus = kimiStatus.available
    ? getKimiDoctorStatus(cwd)
    : { healthy: false, detail: "skipped (kimi is not installed)" };

  const nextSteps = [];
  if (!kimiStatus.available) {
    nextSteps.push(`Install the Kimi Code CLI. ${KIMI_INSTALL_HINT}`);
  }
  if (kimiStatus.available && !configStatus.configured) {
    nextSteps.push(
      "Type `! kimi login` yourself to sign in with the device-code flow. It is interactive and must not be run by Claude."
    );
  }
  if (kimiStatus.available && !doctorStatus.healthy) {
    nextSteps.push("Fix the configuration issues reported by `kimi doctor` above.");
  }
  if (kimiStatus.available && configStatus.configured && doctorStatus.healthy) {
    nextSteps.push("Optional: run `kimi upgrade` to pick up the latest CLI version.");
  }

  return {
    ready: nodeStatus.available && kimiStatus.available && configStatus.configured && doctorStatus.healthy,
    node: nodeStatus,
    npm: npmStatus,
    kimi: kimiStatus,
    config: configStatus,
    doctor: doctorStatus,
    nextSteps
  };
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const report = buildSetupReport(cwd);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function ensureKimiAvailable(cwd) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Kimi CLI is not installed. ${KIMI_INSTALL_HINT}`);
  }
}

function buildTargetInstructions(target) {
  if (target.mode === "working-tree") {
    return [
      "Review the uncommitted changes in this repository: staged, unstaged, and untracked files.",
      "Collect them with `git status --short --untracked-files=all`, `git diff --cached`, and `git diff`."
    ].join("\n");
  }
  return [
    `Review the changes on the current branch relative to ${target.baseRef}.`,
    `Collect them with \`git diff ${target.baseRef}...HEAD\` and \`git log --oneline ${target.baseRef}..HEAD\`.`
  ].join("\n");
}

function buildReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    TARGET_INSTRUCTIONS: buildTargetInstructions(context.target),
    FOCUS: focusText || "No extra focus provided. Review the full change set.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// `write` narrows candidates to matching sessions: a resumed session keeps the
// agent profile it was created with, so a coder must never resume a read-only
// explorer session (it would silently lose write access) and vice versa.
function findLatestResumableTaskJob(jobs, options = {}) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running" &&
        (options.write === undefined || Boolean(job.write) === options.write)
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

// Unlike codex there is no thread-list fallback: `kimi -c` resumes the newest
// session for the cwd regardless of who created it (possibly the user's own
// interactive session), so only sessions tracked in job records are resumable.
function resolveLatestTrackedTaskSession(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /kimi:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs, { write: options.write });
  return trackedTask ? trackedTask.threadId : null;
}

async function executeReviewRun(request) {
  ensureKimiAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, focusText);
  const statusBefore = captureStatusSnapshot(context.repoRoot);

  const result = await runKimiTurn(context.repoRoot, {
    prompt,
    model: request.model,
    agent: REVIEW_AGENT,
    onProgress: request.onProgress
  });

  const statusAfter = captureStatusSnapshot(context.repoRoot);
  const writeCheck = {
    clean: statusBefore === statusAfter,
    before: statusBefore,
    after: statusAfter
  };
  if (!writeCheck.clean) {
    request.onProgress?.({
      message: "WARNING: the working tree changed during the review run.",
      phase: null
    });
  }

  const rendered = renderReviewResult(result, {
    targetLabel: target.label,
    writeCheck,
    sessionIdAmbiguous: result.sessionIdAmbiguous
  });
  const payload = {
    review: "Review",
    target,
    threadId: result.sessionId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
      inputMode: context.inputMode
    },
    kimi: {
      status: result.status,
      classification: result.classification,
      stderr: result.stderr,
      stdout: result.finalMessage
    },
    writeCheck
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    payload,
    rendered,
    summary: writeCheck.clean
      ? firstMeaningfulLine(result.finalMessage, "Review finished.")
      : "WARNING: review run modified the working tree.",
    jobTitle: "Kimi Review",
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureKimiAvailable(request.cwd);

  let resumeSessionId = null;
  if (request.resumeLast) {
    resumeSessionId = resolveLatestTrackedTaskSession(workspaceRoot, {
      excludeJobId: request.jobId,
      write: Boolean(request.write)
    });
    if (!resumeSessionId) {
      const roleLabel = request.write ? "write-capable (coder)" : "read-only (explorer)";
      throw new Error(
        `No previous ${roleLabel} Kimi session is tracked for this repository. Start a fresh task, or resume manually with \`kimi --session <id>\`.`
      );
    }
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runKimiTurn(workspaceRoot, {
    prompt: request.prompt?.trim() || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : ""),
    model: request.model,
    agent: resumeSessionId ? null : request.write ? null : REVIEW_AGENT,
    resumeSessionId,
    onProgress: request.onProgress
  });

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    write: request.write
  });
  const rendered = renderTaskResult(result, {
    resumed: Boolean(resumeSessionId),
    sessionIdAmbiguous: result.sessionIdAmbiguous
  });
  const payload = {
    status: result.status,
    classification: result.classification,
    threadId: result.sessionId,
    sessionIdSource: result.sessionIdSource,
    rawOutput: result.finalMessage,
    stderr: result.stderr
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(
      result.finalMessage,
      firstMeaningfulLine(result.classification?.detail, `${taskMetadata.title} finished.`)
    ),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, write = false }) {
  const roleTitle = write ? "Kimi Coder Task" : "Kimi Explorer Task";
  const title = resumeLast ? "Kimi Resume" : roleTitle;
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /kimi:status ${payload.jobId} for progress.\n`;
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: jobClass === "review" ? "review" : write ? "coder" : "explorer",
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "kimi-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const job = createCompanionJob({
    prefix: "review",
    kind: "review",
    title: "Kimi Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Review ${target.label}`
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        focusText,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (options.write && options["read-only"]) {
    throw new Error("Choose either --write or --read-only.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    write
  });

  if (options.background) {
    ensureKimiAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = {
      cwd,
      model,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "write", "read-only"]
  });

  if (options.write && options["read-only"]) {
    throw new Error("Choose either --write or --read-only.");
  }
  const writeFilter = options.write ? true : options["read-only"] ? false : undefined;

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs, { write: writeFilter });

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
