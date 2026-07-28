/**
 * The suite format: a plain-JSON description of an agent command and the cases to grade it on.
 * Parsing is fail-closed like everything else here: unknown keys are rejected, and every issue
 * carries the field path an author (human or agent) can self-correct against.
 */

/** Assertion operators for the `assertions` check. `[*]` in a path means "any element". */
export const ASSERTION_OPS = [
  "exists",
  "equals",
  "contains",
  "matches",
  "lengthAtLeast",
  "lengthAtMost",
] as const;
export type AssertionOp = (typeof ASSERTION_OPS)[number];

/** One dot-path assertion over the concluded artifact (e.g. `steps[*].test`). */
export interface Assertion {
  path: string;
  op: AssertionOp;
  value?: unknown;
}

/**
 * The check kinds the engine knows. Kept in lockstep with the check registry in `checks.ts`,
 * and every kind must ship known-pass and known-fail canary fixtures in the test suite: a check
 * that regresses to always-pass fails the build, not the postmortem.
 */
export const CHECK_KINDS = ["artifact-valid", "assertions"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export type CheckSpec = { kind: "artifact-valid" } | { kind: "assertions"; assert: Assertion[] };

/** A case's grading: strict AND of checks, executed in authored order, short-circuiting. */
export interface Grading {
  all: CheckSpec[];
}

export const SUITE_VERSION = "eval-checks.suite/v1";

export interface SuiteCase {
  caseId: string;
  description?: string;
  /** Extra argv appended to the suite's command for this case. */
  args?: string[];
  /**
   * "pass" (the default): grading must pass. "fail": a control case, e.g. a seeded defect the
   * grading MUST catch. Controls are what tell you the grader still grades.
   */
  expect?: "pass" | "fail";
  grading: Grading;
}

export interface Suite {
  version: typeof SUITE_VERSION;
  /** argv of the agent under evaluation; each case's `args` are appended verbatim. */
  command: string[];
  cases: SuiteCase[];
}

/** One field-level parse issue: `path` locates it, `message` says how to fix it. */
export interface SuiteIssue {
  path: string;
  message: string;
}

export class SuiteParseError extends Error {
  readonly issues: SuiteIssue[];

  constructor(issues: SuiteIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "SuiteParseError";
    this.issues = issues;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: SuiteIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}.${key}`, message: "unknown key (unknown keys fail closed)" });
    }
  }
}

function parseStringArray(
  value: unknown,
  path: string,
  issues: SuiteIssue[],
  opts: { minLength: number },
): string[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of strings" });
    return [];
  }
  if (value.length < opts.minLength) {
    issues.push({ path, message: `must have at least ${opts.minLength} element(s)` });
  }
  const out: string[] = [];
  for (const [i, element] of value.entries()) {
    if (typeof element === "string") out.push(element);
    else issues.push({ path: `${path}[${i}]`, message: "must be a string" });
  }
  return out;
}

function parseAssertion(value: unknown, path: string, issues: SuiteIssue[]): Assertion {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "must be an object { path, op, value? }" });
    return { path: "", op: "exists" };
  }
  rejectUnknownKeys(value, ["path", "op", "value"], path, issues);
  if (typeof value.path !== "string" || value.path.length === 0) {
    issues.push({ path: `${path}.path`, message: "must be a non-empty string" });
  }
  if (!ASSERTION_OPS.includes(value.op as AssertionOp)) {
    issues.push({ path: `${path}.op`, message: `must be one of: ${ASSERTION_OPS.join(", ")}` });
  }
  return {
    path: typeof value.path === "string" ? value.path : "",
    op: ASSERTION_OPS.includes(value.op as AssertionOp) ? (value.op as AssertionOp) : "exists",
    ...(Object.hasOwn(value, "value") ? { value: value.value } : {}),
  };
}

function parseCheckSpec(value: unknown, path: string, issues: SuiteIssue[]): CheckSpec {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "must be an object with a `kind`" });
    return { kind: "artifact-valid" };
  }
  const kind = value.kind;
  if (kind === "artifact-valid") {
    rejectUnknownKeys(value, ["kind"], path, issues);
    return { kind };
  }
  if (kind === "assertions") {
    rejectUnknownKeys(value, ["kind", "assert"], path, issues);
    if (!Array.isArray(value.assert) || value.assert.length === 0) {
      issues.push({ path: `${path}.assert`, message: "must be a non-empty array of assertions" });
      return { kind, assert: [] };
    }
    return {
      kind,
      assert: value.assert.map((a, i) => parseAssertion(a, `${path}.assert[${i}]`, issues)),
    };
  }
  issues.push({ path: `${path}.kind`, message: `must be one of: ${CHECK_KINDS.join(", ")}` });
  return { kind: "artifact-valid" };
}

function parseCase(value: unknown, path: string, issues: SuiteIssue[]): SuiteCase {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "must be an object { caseId, grading, ... }" });
    return { caseId: "", grading: { all: [] } };
  }
  rejectUnknownKeys(value, ["caseId", "description", "args", "expect", "grading"], path, issues);
  if (typeof value.caseId !== "string" || value.caseId.length === 0) {
    issues.push({ path: `${path}.caseId`, message: "must be a non-empty string" });
  }
  if (Object.hasOwn(value, "description") && typeof value.description !== "string") {
    issues.push({ path: `${path}.description`, message: "must be a string" });
  }
  if (Object.hasOwn(value, "expect") && value.expect !== "pass" && value.expect !== "fail") {
    issues.push({ path: `${path}.expect`, message: 'must be "pass" or "fail"' });
  }
  const args = Object.hasOwn(value, "args")
    ? parseStringArray(value.args, `${path}.args`, issues, { minLength: 0 })
    : undefined;
  let grading: Grading = { all: [] };
  if (!isPlainObject(value.grading)) {
    issues.push({ path: `${path}.grading`, message: "must be an object { all: [checks] }" });
  } else {
    rejectUnknownKeys(value.grading, ["all"], `${path}.grading`, issues);
    if (!Array.isArray(value.grading.all) || value.grading.all.length === 0) {
      issues.push({ path: `${path}.grading.all`, message: "must be a non-empty array of checks" });
    } else {
      grading = {
        all: value.grading.all.map((c, i) =>
          parseCheckSpec(c, `${path}.grading.all[${i}]`, issues),
        ),
      };
    }
  }
  return {
    caseId: typeof value.caseId === "string" ? value.caseId : "",
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(value.expect === "fail" ? { expect: "fail" as const } : {}),
    grading,
  };
}

/** Parse and validate a suite value (e.g. `JSON.parse` of a suite file). Throws `SuiteParseError`
 * carrying every field-level issue at once, so an author fixes one round-trip, not one key. */
export function parseSuite(value: unknown): Suite {
  const issues: SuiteIssue[] = [];
  if (!isPlainObject(value)) {
    throw new SuiteParseError([{ path: "(root)", message: "suite must be a JSON object" }]);
  }
  rejectUnknownKeys(value, ["version", "command", "cases"], "(root)", issues);
  if (value.version !== SUITE_VERSION) {
    issues.push({ path: "version", message: `must be "${SUITE_VERSION}"` });
  }
  const command = parseStringArray(value.command, "command", issues, { minLength: 1 });
  let cases: SuiteCase[] = [];
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    issues.push({ path: "cases", message: "must be a non-empty array of cases" });
  } else {
    cases = value.cases.map((c, i) => parseCase(c, `cases[${i}]`, issues));
    const seen = new Set<string>();
    for (const [i, c] of cases.entries()) {
      if (c.caseId.length > 0 && seen.has(c.caseId)) {
        issues.push({ path: `cases[${i}].caseId`, message: `duplicate caseId "${c.caseId}"` });
      }
      seen.add(c.caseId);
    }
  }
  if (issues.length > 0) throw new SuiteParseError(issues);
  return { version: SUITE_VERSION, command, cases };
}
