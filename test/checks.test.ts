import { describe, expect, test } from "bun:test";
import {
  type CandidateOutput,
  type CheckContext,
  checkKinds,
  resolveCheck,
  runChecks,
} from "../src/checks.js";
import type { CheckKind, CheckSpec } from "../src/suite.js";

const concluded = (artifact: unknown): CandidateOutput => ({ ok: true, artifact });
const errored: CandidateOutput = { ok: false, errorCode: "AGENT_EXIT_1" };

/**
 * The canary registry: every check kind MUST have a known-pass and a known-fail fixture. The
 * meta-test below fails when a new check lands without canaries, and each canary fails when a
 * check regresses to always-pass (or always-fail). This is the "who grades the graders" answer:
 * grader regressions break the build, they do not produce green walls in production.
 */
type Canary = { spec: CheckSpec; knownPass: CheckContext; knownFail: CheckContext };
const CANARIES: Record<CheckKind, Canary> = {
  "artifact-valid": {
    spec: { kind: "artifact-valid" },
    knownPass: { candidate: concluded({ goal: "x" }) },
    knownFail: { candidate: errored },
  },
  assertions: {
    spec: { kind: "assertions", assert: [{ path: "goal", op: "exists" }] },
    knownPass: { candidate: concluded({ goal: "x" }) },
    knownFail: { candidate: concluded({ other: "x" }) },
  },
};

describe("canaries", () => {
  test("every registered check ships a known-pass and a known-fail canary", () => {
    expect(Object.keys(CANARIES).sort()).toEqual([...checkKinds()].sort());
  });

  for (const kind of checkKinds()) {
    const canary = CANARIES[kind];
    test(`${kind}: known-pass fixture passes`, () => {
      expect(resolveCheck(kind)(canary.spec, canary.knownPass).passed).toBe(true);
    });
    test(`${kind}: known-fail fixture fails (an always-pass regression dies here)`, () => {
      expect(resolveCheck(kind)(canary.spec, canary.knownFail).passed).toBe(false);
    });
  }
});

describe("artifact-valid", () => {
  test("passes a concluded artifact when no validator is given", () => {
    const result = resolveCheck("artifact-valid")(
      { kind: "artifact-valid" },
      { candidate: concluded({}) },
    );
    expect(result.passed).toBe(true);
  });

  test("fails with the validator's issues when the contract is violated", () => {
    const result = resolveCheck("artifact-valid")(
      { kind: "artifact-valid" },
      {
        candidate: concluded({ steps: "not-an-array" }),
        validate: () => ({ ok: false, issues: ["steps: must be an array"] }),
      },
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("steps: must be an array");
  });

  test("fails a run that never concluded, carrying the error code", () => {
    const result = resolveCheck("artifact-valid")(
      { kind: "artifact-valid" },
      { candidate: errored },
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("AGENT_EXIT_1");
  });
});

describe("assertions: fail-closed path resolution", () => {
  const check = resolveCheck("assertions");
  const assertSpec = (path: string, op: string, value?: unknown): CheckSpec => ({
    kind: "assertions",
    assert: [{ path, op: op as never, ...(value !== undefined ? { value } : {}) }],
  });

  test("a missing path fails closed, never vacuously passes", () => {
    const result = check(assertSpec("risks", "exists"), { candidate: concluded({ steps: [] }) });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("path not found");
  });

  test("inherited prototype members never resolve (constructor, toString)", () => {
    for (const path of ["constructor", "toString", "steps.constructor"]) {
      const result = check(assertSpec(path, "exists"), {
        candidate: concluded({ steps: [1] }),
      });
      expect(result.passed).toBe(false);
    }
  });

  test("an empty path segment never resolves", () => {
    const result = check(assertSpec("a..b", "exists"), {
      candidate: concluded({ a: { "": { b: 1 } } }),
    });
    expect(result.passed).toBe(false);
  });

  test("[*] fans out over array elements; any element satisfying the op passes", () => {
    const artifact = { steps: [{ test: "a" }, { other: 1 }] };
    const result = check(assertSpec("steps[*].test", "exists"), { candidate: concluded(artifact) });
    expect(result.passed).toBe(true);
  });

  test("[*] on a non-array resolves to nothing and fails closed", () => {
    const result = check(assertSpec("steps[*].test", "exists"), {
      candidate: concluded({ steps: "oops" }),
    });
    expect(result.passed).toBe(false);
  });

  test("no artifact means every assertion fails, with the run's error code", () => {
    const result = check(assertSpec("goal", "exists"), { candidate: errored });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("AGENT_EXIT_1");
  });
});

describe("assertions: operators", () => {
  const check = resolveCheck("assertions");
  const run = (artifact: unknown, path: string, op: string, value?: unknown) =>
    check(
      {
        kind: "assertions",
        assert: [{ path, op: op as never, ...(value !== undefined ? { value } : {}) }],
      },
      { candidate: concluded(artifact) },
    ).passed;

  test("equals uses deep strict equality", () => {
    expect(run({ a: { b: [1, 2] } }, "a", "equals", { b: [1, 2] })).toBe(true);
    expect(run({ a: { b: [1, 2] } }, "a", "equals", { b: [2, 1] })).toBe(false);
  });

  test("contains works on strings and arrays", () => {
    expect(run({ msg: "rate limiting" }, "msg", "contains", "limit")).toBe(true);
    expect(run({ tags: ["a", "b"] }, "tags", "contains", "b")).toBe(true);
    expect(run({ tags: ["a", "b"] }, "tags", "contains", "c")).toBe(false);
    expect(run({ n: 42 }, "n", "contains", "4")).toBe(false);
  });

  test("matches applies a bounded regex", () => {
    expect(run({ id: "case-12" }, "id", "matches", "^case-\\d+$")).toBe(true);
    expect(run({ id: "case-xy" }, "id", "matches", "^case-\\d+$")).toBe(false);
  });

  test("matches fails closed on an oversized pattern or an invalid regex", () => {
    expect(run({ id: "x" }, "id", "matches", "a".repeat(201))).toBe(false);
    expect(run({ id: "x" }, "id", "matches", "(unclosed")).toBe(false);
  });

  test("length bounds work on strings and arrays and fail closed on other types", () => {
    expect(run({ steps: [1, 2, 3] }, "steps", "lengthAtLeast", 2)).toBe(true);
    expect(run({ steps: [1] }, "steps", "lengthAtLeast", 2)).toBe(false);
    expect(run({ title: "ab" }, "title", "lengthAtMost", 3)).toBe(true);
    expect(run({ n: 42 }, "n", "lengthAtLeast", 1)).toBe(false);
  });
});

describe("runChecks", () => {
  test("strict AND, short-circuiting on the first failure", () => {
    const { passed, results } = runChecks(
      {
        all: [
          { kind: "assertions", assert: [{ path: "missing", op: "exists" }] },
          { kind: "artifact-valid" },
        ],
      },
      { candidate: concluded({}) },
    );
    expect(passed).toBe(false);
    expect(results).toHaveLength(1);
  });

  test("all green when every check passes, with per-check evidence", () => {
    const { passed, results } = runChecks(
      {
        all: [
          { kind: "artifact-valid" },
          { kind: "assertions", assert: [{ path: "goal", op: "exists" }] },
        ],
      },
      { candidate: concluded({ goal: "x" }) },
    );
    expect(passed).toBe(true);
    expect(results).toHaveLength(2);
  });
});
