import { describe, expect, test } from "bun:test";
import { parseSuite, SUITE_VERSION, SuiteParseError } from "../src/suite.js";

const minimal = () => ({
  version: SUITE_VERSION,
  command: ["fake-agent"],
  cases: [
    {
      caseId: "smoke",
      grading: { all: [{ kind: "artifact-valid" }] },
    },
  ],
});

function issuesOf(value: unknown): string[] {
  try {
    parseSuite(value);
    return [];
  } catch (error) {
    if (error instanceof SuiteParseError) return error.issues.map((i) => i.path);
    throw error;
  }
}

describe("parseSuite", () => {
  test("accepts a minimal suite", () => {
    const suite = parseSuite(minimal());
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]?.expect).toBeUndefined();
  });

  test("accepts control cases and per-case args", () => {
    const value = minimal();
    value.cases.push({
      caseId: "control",
      args: ["--defect", "drop-risks"],
      expect: "fail",
      grading: { all: [{ kind: "assertions", assert: [{ path: "risks", op: "exists" }] }] },
    } as never);
    const suite = parseSuite(value);
    expect(suite.cases[1]?.expect).toBe("fail");
    expect(suite.cases[1]?.args).toEqual(["--defect", "drop-risks"]);
  });

  test("unknown keys fail closed at every level", () => {
    const value = { ...minimal(), extra: true } as Record<string, unknown>;
    (value.cases as Record<string, unknown>[])[0] = {
      ...(value.cases as Record<string, unknown>[])[0],
      sneaky: 1,
    };
    const paths = issuesOf(value);
    expect(paths).toContain("(root).extra");
    expect(paths).toContain("cases[0].sneaky");
  });

  test("reports every field-level issue at once, with paths", () => {
    const paths = issuesOf({
      version: "wrong/v9",
      command: [],
      cases: [{ caseId: "", grading: { all: [] } }],
    });
    expect(paths).toEqual(
      expect.arrayContaining(["version", "command", "cases[0].caseId", "cases[0].grading.all"]),
    );
  });

  test("rejects unknown check kinds and ops with the allowed set named", () => {
    const value = {
      version: SUITE_VERSION,
      command: ["fake-agent"],
      cases: [
        {
          caseId: "smoke",
          grading: {
            all: [
              { kind: "llm-judge" },
              { kind: "assertions", assert: [{ path: "a", op: "isCool" }] },
            ],
          },
        },
      ],
    };
    const paths = issuesOf(value);
    expect(paths).toContain("cases[0].grading.all[0].kind");
    expect(paths).toContain("cases[0].grading.all[1].assert[0].op");
  });

  test("rejects duplicate caseIds", () => {
    const value = minimal();
    value.cases.push({ caseId: "smoke", grading: { all: [{ kind: "artifact-valid" }] } });
    expect(issuesOf(value)).toContain("cases[1].caseId");
  });
});
