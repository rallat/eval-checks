import { createDriver, type DriverOptions, type SampleResult } from "./driver.js";
import type { Suite, SuiteCase } from "./suite.js";

/**
 * The run loop: every case, `samplesPerCase` samples each, sequentially (an eval that spawns real
 * agents is bounded by tokens and wall clock, not by CPU; sequential keeps spend legible).
 */

export interface CaseReport {
  caseId: string;
  expect: "pass" | "fail";
  samples: SampleResult[];
  /** Whether the case met its expectation (see `caseOk` for the exact rule). */
  ok: boolean;
}

export interface RunReport {
  ok: boolean;
  cases: CaseReport[];
  counts: { ok: number; failed: number };
}

export interface RunOptions extends Omit<DriverOptions, "command"> {
  /** Samples per case. Defaults to 1 (a smoke run). */
  samplesPerCase?: number;
}

/**
 * A case meets its expectation when every sample does. For an `expect: "pass"` case a sample must
 * pass its grading. For an `expect: "fail"` control case (a seeded defect the grader must catch)
 * a sample must FAIL its grading, and a timeout never counts: a control that timed out proves
 * nothing was graded, not that the defect was caught. Infrastructure noise must never be read as
 * grader vigilance.
 */
export function caseOk(c: SuiteCase, samples: SampleResult[]): boolean {
  const expect = c.expect ?? "pass";
  if (expect === "pass") return samples.every((s) => s.passed);
  return samples.every((s) => s.timedOut !== true && !s.passed);
}

export async function runSuite(suite: Suite, opts: RunOptions = {}): Promise<RunReport> {
  const { samplesPerCase, ...driverOptions } = opts;
  const runSample = createDriver({ ...driverOptions, command: suite.command });
  const n = samplesPerCase ?? 1;
  const cases: CaseReport[] = [];
  for (const c of suite.cases) {
    const samples: SampleResult[] = [];
    for (let i = 0; i < n; i++) {
      samples.push(await runSample(c.grading, c.args ?? []));
    }
    cases.push({ caseId: c.caseId, expect: c.expect ?? "pass", samples, ok: caseOk(c, samples) });
  }
  const okCount = cases.filter((c) => c.ok).length;
  return {
    ok: okCount === cases.length,
    cases,
    counts: { ok: okCount, failed: cases.length - okCount },
  };
}
