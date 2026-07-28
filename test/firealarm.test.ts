import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../src/runner.js";
import { parseSuite } from "../src/suite.js";

/**
 * The fire alarm: an end-to-end proof, over the real subprocess path, that a known-bad artifact
 * reaches a failing verdict. If every unit test were deleted, this test alone would still catch
 * an engine that stopped failing things. It spawns the example fake agent for real.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const suite = () => parseSuite(JSON.parse(readFileSync(join(root, "examples/suite.json"), "utf8")));

describe("fire alarm (e2e over real subprocesses)", () => {
  test("healthy run passes and both seeded defects are caught", async () => {
    const report = await runSuite(suite(), { cwd: root, sampleTimeoutMs: 30_000 });
    expect(report.cases.map((c) => `${c.caseId}:${c.ok}`)).toEqual([
      "plan-shape:true",
      "control-drop-risks:true",
      "control-no-tests:true",
    ]);
    expect(report.ok).toBe(true);
  }, 60_000);

  test("a seeded defect produces a failing grading verdict with legible evidence", async () => {
    const s = suite();
    const control = s.cases.find((c) => c.caseId === "control-drop-risks");
    if (control === undefined) throw new Error("control case missing from example suite");
    // Run the control's sabotaged command but grade it as a normal case: it MUST fail.
    const { expect: _expect, ...normal } = control;
    const report = await runSuite(
      { ...s, cases: [normal] },
      { cwd: root, sampleTimeoutMs: 30_000 },
    );
    expect(report.ok).toBe(false);
    const detail = report.cases[0]?.samples[0]?.checks?.at(-1)?.detail ?? "";
    expect(detail).toContain("risks");
  }, 60_000);

  test("an agent that prints prose instead of an envelope fails with a structured error", async () => {
    const s = suite();
    const first = s.cases[0];
    if (first === undefined) throw new Error("example suite has no cases");
    const prose = {
      ...s,
      command: ["node", "-e", "console.log('I could not produce a plan, sorry!')"],
      cases: [first],
    };
    const report = await runSuite(prose, { cwd: root, sampleTimeoutMs: 30_000 });
    expect(report.ok).toBe(false);
    expect(report.cases[0]?.samples[0]?.errorCode).toBe("ENVELOPE_PARSE_ERROR");
  }, 60_000);
});
