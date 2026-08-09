import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "kimi");

function readPluginFile(...segments) {
  return fs.readFileSync(path.join(PLUGIN, ...segments), "utf8");
}

function frontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected YAML frontmatter");
  return match[1];
}

test("plugin manifest and marketplace agree on the plugin name", () => {
  const plugin = JSON.parse(readPluginFile(".claude-plugin", "plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(plugin.name, "kimi");
  assert.equal(marketplace.plugins[0].name, "kimi");
  assert.equal(marketplace.plugins[0].source, "./plugins/kimi");
});

test("review command keeps the review-only contract and background flow", () => {
  const content = readPluginFile("commands", "review.md");
  const meta = frontmatter(content);

  assert.match(meta, /disable-model-invocation: true/);
  assert.match(meta, /AskUserQuestion/);
  assert.match(content, /review-only/);
  assert.match(content, /verbatim/);
  assert.match(content, /\(Recommended\)/);
  assert.match(content, /run_in_background: true/);
  assert.match(content, /Do not call `BashOutput`/);
  assert.match(content, /\/kimi:status/);
  assert.match(content, /! kimi login/);
  assert.match(content, /kimi-companion\.mjs" review "\$ARGUMENTS"/);
});

test("setup command installs conditionally and never runs kimi login", () => {
  const content = readPluginFile("commands", "setup.md");

  assert.match(content, /Install Kimi Code \(Recommended\)/);
  assert.match(content, /npm install -g @moonshot-ai\/kimi-code/);
  assert.match(content, /install\.sh/);
  assert.match(content, /! kimi login/);
  assert.match(content, /never run `kimi login`/i);
});

test("coder command routes through the kimi-coder subagent with write-scoped resume gating", () => {
  const content = readPluginFile("commands", "coder.md");
  const meta = frontmatter(content);

  assert.match(meta, /allowed-tools: .*Agent/);
  assert.match(content, /subagent_type: "kimi:kimi-coder"/);
  assert.match(content, /not a skill/);
  assert.match(content, /task-resume-candidate --write --json/);
  assert.match(content, /Continue current Kimi session/);
  assert.match(content, /Start a new Kimi session/);
  assert.match(content, /\(Recommended\)/);
  assert.match(content, /verbatim/);
  assert.doesNotMatch(content, /--effort/);
});

test("explorer command routes through the kimi-explorer subagent and stays read-only", () => {
  const content = readPluginFile("commands", "explorer.md");
  const meta = frontmatter(content);

  assert.match(meta, /allowed-tools: .*Agent/);
  assert.match(content, /subagent_type: "kimi:kimi-explorer"/);
  assert.match(content, /not a skill/);
  assert.match(content, /task --read-only/);
  assert.match(content, /strictly read-only/);
  assert.match(content, /verbatim/);
  assert.doesNotMatch(content, /--effort/);
});

test("reviewer command routes through the kimi-reviewer subagent and stays review-only", () => {
  const content = readPluginFile("commands", "reviewer.md");
  const meta = frontmatter(content);

  assert.match(meta, /allowed-tools: .*Agent/);
  assert.match(content, /subagent_type: "kimi:kimi-reviewer"/);
  assert.match(content, /not a skill/);
  assert.match(content, /review-only/);
  assert.match(content, /--base <target-branch>/);
  assert.match(content, /verbatim/);
  assert.match(content, /Do not fix any issues/);
});

test("passthrough commands invoke the companion inline", () => {
  for (const [file, subcommand] of [
    ["status.md", "status"],
    ["result.md", "result"],
    ["cancel.md", "cancel"]
  ]) {
    const content = readPluginFile("commands", file);
    const meta = frontmatter(content);
    assert.match(meta, /disable-model-invocation: true/);
    assert.match(meta, /allowed-tools: Bash\(node:\*\)/);
    assert.match(content, new RegExp(`!\`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/kimi-companion\\.mjs" ${subcommand} "\\$ARGUMENTS"\``));
  }
});

test("role agents are thin forwarders with the right helper invocation", () => {
  const coder = readPluginFile("agents", "kimi-coder.md");
  assert.match(frontmatter(coder), /name: kimi-coder/);
  assert.match(frontmatter(coder), /kimi-cli-runtime/);
  assert.match(coder, /exactly one `Bash` call/);
  assert.match(coder, /task --write/);
  assert.match(coder, /return nothing/);
  assert.doesNotMatch(coder, /--effort/);

  const explorer = readPluginFile("agents", "kimi-explorer.md");
  assert.match(frontmatter(explorer), /name: kimi-explorer/);
  assert.match(frontmatter(explorer), /kimi-cli-runtime/);
  assert.match(explorer, /exactly one `Bash` call/);
  assert.match(explorer, /task --read-only/);
  assert.match(explorer, /never `--write`/);
  assert.match(explorer, /return nothing/);

  const reviewer = readPluginFile("agents", "kimi-reviewer.md");
  assert.match(frontmatter(reviewer), /name: kimi-reviewer/);
  assert.match(frontmatter(reviewer), /kimi-cli-runtime/);
  assert.match(reviewer, /exactly one `Bash` call/);
  assert.match(reviewer, /kimi-companion\.mjs" review/);
  assert.match(reviewer, /Never fix, patch/);
  assert.match(reviewer, /return nothing/);
});

test("internal skills are not user-invocable and keep the no-auto-fix rule", () => {
  const runtime = readPluginFile("skills", "kimi-cli-runtime", "SKILL.md");
  assert.match(frontmatter(runtime), /user-invocable: false/);
  assert.match(runtime, /explore/);
  assert.match(runtime, /cannot change its agent profile/);

  const resultHandling = readPluginFile("skills", "kimi-result-handling", "SKILL.md");
  assert.match(frontmatter(resultHandling), /user-invocable: false/);
  assert.match(resultHandling, /CRITICAL: After presenting review findings, STOP\./);
  assert.match(resultHandling, /strictly forbidden/);
});

test("hooks register SessionStart and SessionEnd only", () => {
  const hooks = JSON.parse(readPluginFile("hooks", "hooks.json"));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionEnd", "SessionStart"]);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-lifecycle-hook\.mjs" SessionStart/);
  assert.match(hooks.hooks.SessionEnd[0].hooks[0].command, /session-lifecycle-hook\.mjs" SessionEnd/);
});

test("review prompt carries the read-only contract and output contract placeholders", () => {
  const prompt = readPluginFile("prompts", "review.md");
  assert.match(prompt, /<read_only_contract>/);
  assert.match(prompt, /\{\{TARGET_LABEL\}\}/);
  assert.match(prompt, /\{\{TARGET_INSTRUCTIONS\}\}/);
  assert.match(prompt, /\{\{FOCUS\}\}/);
  assert.match(prompt, /\{\{REVIEW_COLLECTION_GUIDANCE\}\}/);
  assert.match(prompt, /\{\{REVIEW_INPUT\}\}/);
  assert.match(prompt, /`Verdict:`/);
});
