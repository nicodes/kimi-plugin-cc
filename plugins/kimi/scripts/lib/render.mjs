function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatKimiResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `kimi --session ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Kimi Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/kimi:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/kimi:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Kimi session ID: ${job.threadId}`);
  }
  const resumeCommand = formatKimiResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Kimi: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /kimi:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /kimi:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /kimi:review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Kimi Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- kimi: ${report.kimi.detail}`,
    `- config: ${report.config.detail}`,
    `- doctor: ${report.doctor.detail}`,
    ""
  ];

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function appendWriteCheckWarning(lines, writeCheck) {
  if (!writeCheck || writeCheck.clean !== false) {
    return;
  }
  lines.push(
    "> **WARNING: the review run modified the working tree.**",
    "> Kimi reviews are expected to be read-only. Inspect `git status` and `git diff` before trusting this review or keeping the changes.",
    ""
  );
  if (writeCheck.before !== undefined || writeCheck.after !== undefined) {
    lines.push("Working tree status before the review:", "```text", writeCheck.before || "(clean)", "```", "");
    lines.push("Working tree status after the review:", "```text", writeCheck.after || "(clean)", "```", "");
  }
}

export function renderReviewResult(result, meta) {
  const lines = [`# Kimi Review`, "", `Target: ${meta.targetLabel}`, ""];

  appendWriteCheckWarning(lines, meta.writeCheck);

  if (result.status === 0 && result.finalMessage) {
    lines.push(result.finalMessage.trimEnd());
  } else {
    lines.push("Kimi review failed.");
    if (result.classification?.detail) {
      lines.push("", result.classification.detail);
    }
    if (result.stderr?.trim()) {
      lines.push("", "stderr:", "", "```text", result.stderr.trim(), "```");
    }
  }

  if (meta.sessionIdAmbiguous && result.sessionId) {
    lines.push(
      "",
      `(Session id ${result.sessionId} was inferred from the session index; verify with \`kimi --session ${result.sessionId}\` before trusting resume.)`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(result, meta = {}) {
  if (result.status === 0 && result.finalMessage) {
    const lines = [result.finalMessage.trimEnd()];
    if (meta.resumed) {
      lines.push(
        "",
        "(Resumed session: write capability follows the original session's agent profile.)"
      );
    }
    if (meta.sessionIdAmbiguous && result.sessionId) {
      lines.push(
        "",
        `(Session id ${result.sessionId} was inferred from the session index; verify with \`kimi --session ${result.sessionId}\` before trusting resume.)`
      );
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const lines = ["Kimi task failed."];
  if (result.classification?.detail) {
    lines.push("", result.classification.detail);
  }
  if (result.stderr?.trim()) {
    lines.push("", "stderr:", "", "```text", result.stderr.trim(), "```");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusReport(report) {
  const lines = ["# Kimi Status", ""];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Kimi Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `kimi --session ${threadId}` : null;

  const rendered = storedJob?.rendered;
  if (rendered) {
    const output = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nKimi session ID: ${threadId}\nResume in Kimi: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Kimi Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Kimi session ID: ${threadId}`);
    lines.push(`Resume in Kimi: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Kimi Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/kimi:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
