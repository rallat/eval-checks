import { isDeepStrictEqual } from "node:util";
import type { Assertion, CheckKind, CheckSpec, Grading } from "./suite.js";

/** One executed check's verdict. `detail` carries the evidence a repair loop (or human) reads. */
export interface CheckResult {
  kind: string;
  passed: boolean;
  detail: string;
}

/**
 * What the driver collected from one agent run: either a concluded artifact (the agent exited 0
 * with a well-formed envelope) or the structured error code of a run that never concluded
 * (nonzero exit, timeout, unparseable output).
 */
export type CandidateOutput =
  | { ok: true; artifact: unknown }
  | { ok: false; errorCode: string; detail?: string };

/**
 * Schema-library-agnostic validation seam for `artifact-valid`. Wrap whatever you use (Zod, Ajv,
 * Valibot, a hand-rolled function) into this shape; the engine never imports a schema library.
 */
export type Validator = (artifact: unknown) => { ok: true } | { ok: false; issues: string[] };

/** What a check needs to know. Pure data: checks never touch a process or the filesystem. */
export interface CheckContext {
  candidate: CandidateOutput;
  /** The artifact contract, when you have one. Absent: `artifact-valid` degrades to "the run
   * concluded an artifact at all", which is still a real check against crashed or empty runs. */
  validate?: Validator | undefined;
}

/** The single seam every check implements. Pure and synchronous. */
export type Check = (spec: CheckSpec, ctx: CheckContext) => CheckResult;

const artifactValid: Check = (_spec, ctx) => {
  const kind = "artifact-valid";
  if (!ctx.candidate.ok) {
    const extra = ctx.candidate.detail === undefined ? "" : `: ${ctx.candidate.detail}`;
    return {
      kind,
      passed: false,
      detail: `the run never concluded a valid artifact (${ctx.candidate.errorCode}${extra})`,
    };
  }
  if (ctx.validate !== undefined) {
    const verdict = ctx.validate(ctx.candidate.artifact);
    if (!verdict.ok) {
      return {
        kind,
        passed: false,
        detail: `artifact violates the output contract: ${verdict.issues.join("; ")}`,
      };
    }
  }
  return { kind, passed: true, detail: "concluded artifact satisfies the output contract" };
};

/**
 * Bound the regex surface: cap the authored pattern and the tested string. Length caps do NOT
 * prevent every catastrophic-backtracking pattern; patterns are suite content, human-reviewed
 * like code. The caps only keep an accidental pathological input from hanging the eval.
 */
const MAX_PATTERN_LENGTH = 200;
const MAX_MATCH_INPUT_LENGTH = 100_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve a dot-path (`a.b`, `items[*].path`) against a value. `[*]` fans out over array
 * elements. Only **own** properties resolve: inherited prototype members (`toString`,
 * `constructor`, ...) never do, and an empty segment never resolves; both would otherwise let a
 * crafted path vacuously pass. Returns every resolved value; `undefined` resolutions are dropped,
 * so an empty result means the path is absent, which every operator treats as a failure (fail
 * closed, never vacuously pass).
 */
function resolvePath(root: unknown, path: string): unknown[] {
  let values: unknown[] = [root];
  for (const segment of path.split(".")) {
    const wildcard = segment.endsWith("[*]");
    const key = wildcard ? segment.slice(0, -3) : segment;
    values = values.flatMap((v) => {
      let child: unknown;
      if (key === "") {
        // A bare `[*]` wildcards the current value; an empty non-wildcard segment never resolves.
        child = wildcard ? v : undefined;
      } else if (isPlainObject(v) && Object.hasOwn(v, key)) {
        child = v[key];
      } else {
        child = undefined;
      }
      if (!wildcard) return child === undefined ? [] : [child];
      return Array.isArray(child) ? child.filter((e) => e !== undefined) : [];
    });
  }
  return values;
}

function assertionHolds(op: Assertion["op"], resolved: unknown[], expected: unknown): boolean {
  switch (op) {
    case "exists":
      return resolved.length > 0;
    case "equals":
      return resolved.some((v) => isDeepStrictEqual(v, expected));
    case "contains":
      return resolved.some((v) => {
        if (typeof v === "string") return typeof expected === "string" && v.includes(expected);
        if (Array.isArray(v)) return v.some((e) => isDeepStrictEqual(e, expected));
        return false;
      });
    case "matches":
      return resolved.some((v) => {
        if (typeof v !== "string" || typeof expected !== "string") return false;
        if (expected.length > MAX_PATTERN_LENGTH || v.length > MAX_MATCH_INPUT_LENGTH) return false;
        try {
          return new RegExp(expected).test(v);
        } catch {
          return false;
        }
      });
    case "lengthAtLeast":
    case "lengthAtMost":
      return resolved.some((v) => {
        const length = typeof v === "string" ? v.length : Array.isArray(v) ? v.length : undefined;
        if (length === undefined || typeof expected !== "number") return false;
        return op === "lengthAtLeast" ? length >= expected : length <= expected;
      });
  }
}

const assertions: Check = (spec, ctx) => {
  const kind = "assertions";
  if (spec.kind !== "assertions") {
    return { kind, passed: false, detail: `misrouted check spec '${spec.kind}'` };
  }
  if (!ctx.candidate.ok) {
    return {
      kind,
      passed: false,
      detail: `no artifact to assert on (${ctx.candidate.errorCode})`,
    };
  }
  const artifact = ctx.candidate.artifact;
  for (const assertion of spec.assert) {
    const resolved = resolvePath(artifact, assertion.path);
    if (resolved.length === 0) {
      return {
        kind,
        passed: false,
        detail: `path not found: ${assertion.path} (a missing path fails closed)`,
      };
    }
    if (!assertionHolds(assertion.op, resolved, assertion.value)) {
      const expected = assertion.value === undefined ? "" : ` ${JSON.stringify(assertion.value)}`;
      return {
        kind,
        passed: false,
        detail: `assertion failed: ${assertion.path} ${assertion.op}${expected}`,
      };
    }
  }
  return { kind, passed: true, detail: `${spec.assert.length} assertion(s) hold` };
};

/**
 * The check registry, in lockstep with `CHECK_KINDS` (guarded by the registry test, which also
 * requires a known-fail canary per check: a check that regresses to always-pass is caught there,
 * not discovered as a green wall in production).
 */
const CHECKS: Record<CheckKind, Check> = {
  "artifact-valid": artifactValid,
  assertions,
};

export function resolveCheck(kind: CheckKind): Check {
  const check = CHECKS[kind];
  if (check === undefined) throw new Error(`unknown check kind: ${kind}`);
  return check;
}

export function checkKinds(): CheckKind[] {
  return Object.keys(CHECKS) as CheckKind[];
}

/**
 * Run a case's grading: strict AND in authored order, short-circuiting on the first failure so
 * later checks never run against garbage. Returns the executed checks' results (the sample's
 * per-check evidence) plus the combined verdict.
 */
export function runChecks(
  grading: Grading,
  ctx: CheckContext,
): { passed: boolean; results: CheckResult[] } {
  const results: CheckResult[] = [];
  for (const spec of grading.all) {
    const result = resolveCheck(spec.kind)(spec, ctx);
    results.push(result);
    if (!result.passed) return { passed: false, results };
  }
  return { passed: true, results };
}
