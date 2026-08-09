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

test("rescue command routes through the kimi-rescue subagent with resume gating", () => {
  const content = readPluginFile("commands", "rescue.md");
  const meta = frontmatter(content);

  assert.match(meta, /allowed-tools: .*Agent/);
  assert.match(content, /subagent_type: "kimi:kimi-rescue"/);
  assert.match(content, /not a skill/);
  assert.match(content, /task-resume-candidate --json/);
  assert.match(content, /Continue current Kimi session/);
  assert.match(content, /Start a new Kimi session/);
  assert.match(content, /\(Recommended\)/);
  assert.match(content, /verbatim/);
  assert.doesNotMatch(content, /--effort/);
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

test("kimi-rescue agent is a thin forwarder without effort flags", () => {
  const content = readPluginFile("agents", "kimi-rescue.md");
  const meta = frontmatter(content);

  assert.match(meta, /name: kimi-rescue/);
  assert.match(meta, /tools: Bash/);
  assert.match(meta, /kimi-cli-runtime/);
  assert.match(content, /exactly one `Bash` call/);
  assert.match(content, /return nothing/);
  assert.match(content, /--write/);
  assert.match(content, /--resume-last/);
  assert.doesNotMatch(content, /--effort/);
  assert.doesNotMatch(content, /spark/);
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
