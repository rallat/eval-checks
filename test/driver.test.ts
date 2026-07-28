import { describe, expect, test } from "bun:test";
import {
  allowlistedEnv,
  createDriver,
  type Exec,
  FuseExhaustedError,
  parseDefaultEnvelope,
} from "../src/driver.js";
import type { Grading } from "../src/suite.js";

const GRADE_EXISTS: Grading = {
  all: [{ kind: "assertions", assert: [{ path: "goal", op: "exists" }] }],
};

const envelope = (artifact: unknown, usage?: { inputTokens: number; outputTokens: number }) =>
  JSON.stringify({ ok: true, artifact, ...(usage !== undefined ? { usage } : {}) });

const fakeExec =
  (results: Array<{ exitCode?: number; stdout?: string; timedOut?: boolean }>): Exec =>
  async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("fakeExec exhausted");
    return {
      exitCode: next.exitCode ?? 0,
      stdout: next.stdout ?? "",
      timedOut: next.timedOut ?? false,
    };
  };

describe("parseDefaultEnvelope", () => {
  test("accepts the ok envelope and reports usage", () => {
    const parsed = parseDefaultEnvelope(
      envelope({ goal: "x" }, { inputTokens: 10, outputTokens: 5 }),
      0,
    );
    expect(parsed.candidate.ok).toBe(true);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("non-JSON stdout is a structured parse error, never a pass", () => {
    const parsed = parseDefaultEnvelope("Reading files...\ndone!", 0);
    expect(parsed.candidate).toMatchObject({ ok: false, errorCode: "ENVELOPE_PARSE_ERROR" });
  });

  test("well-formed JSON of the wrong shape is a shape error", () => {
    const parsed = parseDefaultEnvelope(JSON.stringify({ result: "fine" }), 0);
    expect(parsed.candidate).toMatchObject({ ok: false, errorCode: "ENVELOPE_SHAPE_ERROR" });
  });

  test("an ok envelope from a nonzero exit is not trusted", () => {
    const parsed = parseDefaultEnvelope(envelope({ goal: "x" }), 3);
    expect(parsed.candidate).toMatchObject({ ok: false, errorCode: "AGENT_EXIT_3" });
  });

  test("the error envelope's code and message carry through", () => {
    const parsed = parseDefaultEnvelope(
      JSON.stringify({ ok: false, error: { code: "VALIDATION_FAILED", message: "bad spec" } }),
      2,
    );
    expect(parsed.candidate).toMatchObject({
      ok: false,
      errorCode: "VALIDATION_FAILED",
      detail: "bad spec",
    });
  });
});

describe("createDriver", () => {
  test("a concluded artifact is graded by the case's checks", async () => {
    const run = createDriver({
      command: ["fake-agent"],
      exec: fakeExec([{ stdout: envelope({ goal: "x" }) }]),
    });
    const sample = await run(GRADE_EXISTS, []);
    expect(sample.passed).toBe(true);
    expect(sample.checks).toHaveLength(1);
  });

  test("a timeout is a failed sample marked timedOut, with no checks fabricated", async () => {
    const run = createDriver({ command: ["fake-agent"], exec: fakeExec([{ timedOut: true }]) });
    const sample = await run(GRADE_EXISTS, []);
    expect(sample).toMatchObject({ passed: false, timedOut: true });
    expect(sample.checks).toBeUndefined();
  });

  test("an unparseable envelope fails with the structured error code", async () => {
    const run = createDriver({
      command: ["fake-agent"],
      exec: fakeExec([{ stdout: "garbage", exitCode: 0 }]),
    });
    const sample = await run(GRADE_EXISTS, []);
    expect(sample.passed).toBe(false);
    expect(sample.errorCode).toBe("ENVELOPE_PARSE_ERROR");
  });

  test("case args are appended to the suite command", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (argv) => {
      seen.push(argv);
      return { exitCode: 0, stdout: envelope({ goal: "x" }), timedOut: false };
    };
    const run = createDriver({ command: ["fake-agent", "--json"], exec });
    await run(GRADE_EXISTS, ["--goal", "add rate limiting"]);
    expect(seen[0]).toEqual(["fake-agent", "--json", "--goal", "add rate limiting"]);
  });

  test("the token fuse throws FuseExhaustedError instead of fabricating failures", async () => {
    const usage = { inputTokens: 600, outputTokens: 0 };
    const run = createDriver({
      command: ["fake-agent"],
      runTokenFuse: 1000,
      exec: fakeExec([
        { stdout: envelope({ goal: "a" }, usage) },
        { stdout: envelope({ goal: "b" }, usage) },
      ]),
    });
    await run(GRADE_EXISTS, []);
    // 600 tokens spent: below the fuse, the second sample still runs.
    await run(GRADE_EXISTS, []);
    // 1200 spent: the third sample must abort the run, not report a failed sample.
    await expect(run(GRADE_EXISTS, [])).rejects.toThrow(FuseExhaustedError);
  });

  test("the validator seam reaches artifact-valid", async () => {
    const run = createDriver({
      command: ["fake-agent"],
      exec: fakeExec([{ stdout: envelope({ goal: 42 }) }]),
      validate: (artifact) =>
        typeof (artifact as { goal?: unknown }).goal === "string"
          ? { ok: true }
          : { ok: false, issues: ["goal: must be a string"] },
    });
    const sample = await run({ all: [{ kind: "artifact-valid" }] }, []);
    expect(sample.passed).toBe(false);
    expect(sample.checks?.[0]?.detail).toContain("goal: must be a string");
  });
});

describe("allowlistedEnv", () => {
  test("passes system basics through and drops everything else", () => {
    const env = allowlistedEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      AWS_SECRET_ACCESS_KEY: "leak-me",
      DATABASE_URL: "postgres://secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  test("credentials are opt-in by exact name or prefix", () => {
    const env = allowlistedEnv(
      { ANTHROPIC_API_KEY: "k1", MYAGENT_TOKEN: "k2", OTHER_SECRET: "k3" },
      { keys: ["ANTHROPIC_API_KEY"], prefixes: ["MYAGENT_"] },
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: "k1", MYAGENT_TOKEN: "k2" });
  });
});
