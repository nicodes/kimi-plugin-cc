import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderTaskResult } from "../plugins/kimi/scripts/lib/render.mjs";

test("renderReviewResult passes the final message through verbatim", () => {
  const rendered = renderReviewResult(
    { status: 0, finalMessage: "Verdict: approve\n\nSummary: Looks good." },
    { targetLabel: "working tree diff", writeCheck: { clean: true } }
  );

  assert.match(rendered, /# Kimi Review/);
  assert.match(rendered, /Target: working tree diff/);
  assert.match(rendered, /Verdict: approve/);
  assert.doesNotMatch(rendered, /WARNING/);
});

test("renderReviewResult prepends the write-check warning on drift", () => {
  const rendered = renderReviewResult(
    { status: 0, finalMessage: "Verdict: approve" },
    {
      targetLabel: "working tree diff",
      writeCheck: { clean: false, before: "", after: "?? rogue.txt" }
    }
  );

  assert.match(rendered, /WARNING: the review run modified the working tree/);
  assert.match(rendered, /rogue\.txt/);
  assert.ok(rendered.indexOf("WARNING") < rendered.indexOf("Verdict: approve"));
});

test("renderReviewResult renders failures with classification and stderr", () => {
  const rendered = renderReviewResult(
    {
      status: 1,
      finalMessage: "",
      classification: { kind: "auth", detail: "Type `! kimi login` to sign in, then retry." },
      stderr: "error: 401 unauthorized"
    },
    { targetLabel: "working tree diff", writeCheck: { clean: true } }
  );

  assert.match(rendered, /Kimi review failed/);
  assert.match(rendered, /! kimi login/);
  assert.match(rendered, /401 unauthorized/);
});

test("renderTaskResult notes resumed sessions and ambiguous session ids", () => {
  const rendered = renderTaskResult(
    { status: 0, finalMessage: "Done.", sessionId: "session_9" },
    { resumed: true, sessionIdAmbiguous: true }
  );

  assert.match(rendered, /Done\./);
  assert.match(rendered, /write capability follows the original session/);
  assert.match(rendered, /session_9 was inferred from the session index/);
});

test("renderStoredJobResult appends the kimi resume hint", () => {
  const rendered = renderStoredJobResult(
    { id: "task-1", status: "completed", threadId: "session_4" },
    { rendered: "All done.", threadId: "session_4" }
  );

  assert.match(rendered, /All done\./);
  assert.match(rendered, /Kimi session ID: session_4/);
  assert.match(rendered, /Resume in Kimi: kimi --session session_4/);
});
