import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITE_VERSION } from "../src/suite.js";

/** e2e over the real CLI entry, spawned exactly the way a user runs it. */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const runCli = (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    execFile(
      "bun",
      [join(root, "src/cli.ts"), ...args],
      { cwd: root, timeout: 60_000 },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

const tempSuite = (suite: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "eval-checks-"));
  const path = join(dir, "suite.json");
  writeFileSync(path, JSON.stringify(suite));
  return path;
};

describe("eval-checks CLI", () => {
  test("exit 0 with per-check evidence when every case meets its expectation", async () => {
    const result = await runCli(["examples/suite.json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3/3 cases met their expectation");
    expect(result.stdout).toContain("a missing path fails closed");
  }, 60_000);

  test("--json prints the machine-readable run report", async () => {
    const result = await runCli(["examples/suite.json", "--json"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ ok: 3, failed: 0 });
  }, 60_000);

  test("exit 3 when a case fails its expectation", async () => {
    const path = tempSuite({
      version: SUITE_VERSION,
      command: ["node", join(root, "examples/fake-agent.mjs")],
      cases: [
        {
          caseId: "wants-a-missing-path",
          grading: { all: [{ kind: "assertions", assert: [{ path: "nope", op: "exists" }] }] },
        },
      ],
    });
    const result = await runCli([path]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("FAIL wants-a-missing-path");
  }, 60_000);

  test("exit 2 with field-level issues for an invalid suite", async () => {
    const path = tempSuite({ version: "wrong/v9", command: [], cases: [] });
    const result = await runCli([path]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("version");
    expect(result.stderr).toContain("command");
  }, 60_000);

  test("exit 2 as JSON when --json is set and the suite is invalid", async () => {
    const path = tempSuite({ version: "wrong/v9", command: [], cases: [] });
    const result = await runCli([path, "--json"]);
    expect(result.exitCode).toBe(2);
    const out = JSON.parse(result.stdout);
    expect(out.error.code).toBe("SUITE_INVALID");
    expect(out.error.issues.length).toBeGreaterThan(0);
  }, 60_000);

  test("exit 2 on bad usage, with the usage text", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("exactly one <suite.json> argument is required");
    expect(result.stderr).toContain("Exit codes");
  }, 60_000);

  test("--help exits 0", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: eval-checks");
  }, 60_000);
});
