// The smoke demo: parse the suite, run every case against the fake agent, print the evidence.
// Run from the package root:  bun examples/run.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSuite, runSuite } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const suite = parseSuite(JSON.parse(readFileSync(join(root, "examples/suite.json"), "utf8")));

// The validator seam, schema-library-free: bring Zod/Ajv/Valibot if you have one.
const validate = (artifact) =>
  typeof artifact === "object" && artifact !== null && Array.isArray(artifact.steps)
    ? { ok: true }
    : { ok: false, issues: ["artifact must be an object with a steps array"] };

const report = await runSuite(suite, { cwd: root, validate, sampleTimeoutMs: 30_000 });

for (const c of report.cases) {
  const mark = c.ok ? "ok  " : "FAIL";
  console.log(`${mark} ${c.caseId} (expect: ${c.expect})`);
  for (const sample of c.samples) {
    for (const check of sample.checks ?? []) {
      const verdict = check.passed ? "passed" : "failed";
      console.log(`       ${check.kind} ${verdict}: ${check.detail}`);
    }
    if (sample.timedOut) console.log("       timed out");
  }
}
console.log(`\n${report.counts.ok}/${report.cases.length} cases met their expectation`);
process.exit(report.ok ? 0 : 1);
