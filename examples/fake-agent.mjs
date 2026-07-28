#!/usr/bin/env node
// A stand-in "agent": deterministic, instant, free. It prints the same JSON envelope a real
// agent CLI would, and it can be sabotaged on purpose (--defect) so control cases have a real
// defect to catch. Swap this for your actual agent command; nothing else changes.

const args = process.argv.slice(2);
const readFlag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const goal = readFlag("--goal") ?? "unspecified goal";
const defect = readFlag("--defect");

const artifact = {
  goal,
  steps: [
    { title: `Write a failing test for: ${goal}`, test: "test/feature.test.ts" },
    { title: "Implement the smallest change that passes", test: "test/feature.test.ts" },
    { title: "Refactor with the bar green", test: "test/feature.test.ts" },
  ],
  risks: ["scope creep past the agreed plan", "hidden coupling to global state"],
};

// Seeded defects, used by `expect: "fail"` control cases.
if (defect === "drop-risks") delete artifact.risks;
if (defect === "no-tests") {
  for (const step of artifact.steps) delete step.test;
}

const envelope = {
  ok: true,
  artifact,
  usage: { inputTokens: 120, outputTokens: 340 },
};

console.log(JSON.stringify(envelope));
