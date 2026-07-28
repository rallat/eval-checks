# eval-checks

> Fail-closed grading for agent evals: canaries, fuses, and control cases. A small TypeScript
> engine and CLI (zero dependencies) that runs your agent as a real subprocess,
> grades the JSON artifact it emits, and is built so that when the *grader* breaks, the build
> breaks. I put the failure modes and the limits here alongside the features, so you can judge
> the argument against real objections.

If you keep one sentence from this README, keep it from here: **an eval harness that can
silently stop failing things is worse than no harness, because it converts absent evidence into
green checkmarks.**

This is a study of evals. I wrote it to understand the problem better, so the engine exists to
make the argument concrete and testable. It is not a product looking for adopters.

## Why this can help you

*Four failure modes the study examines, and the mechanism it puts against each one. The limits
are in [When this is the wrong tool](#when-this-is-the-wrong-tool), and they are part of the
finding, not a disclaimer.*

The question here is not "did my agent pass". It is "would this suite still be able to tell me
if my agent stopped passing". That question is hard to answer by reading your own suite, because
a suite that measures nothing looks exactly like a suite that measures everything. So the answer
is written as code: a working engine, small enough to read end to end, where every discipline is
enforced by a test that fails when the discipline lapses.

| Failure mode | The mechanism against it | What it demonstrates |
|---|---|---|
| The suite is green, and nobody can tell whether it still checks anything. | Every check kind ships a known-pass **and** a known-fail fixture, and a meta-test asserts the canary registry covers the check registry exactly. | A grader that stopped failing things can be made to break the build. |
| Someone renames a field and nothing turns red. | Path resolution fails closed. A missing path, an empty segment, and every inherited prototype member are failed assertions, never skipped ones. | Vacuous passes are a resolver design choice, not an inevitability. |
| A pass rate moves and nobody can say why. | A tripped token fuse aborts the run with an infrastructure error and records **zero** unrun samples as failures. Timeouts are recorded as timeouts. | Infrastructure noise and agent regression can stay separate facts. |
| The eval inherits every credential the CI runner holds. | The subprocess receives PATH, HOME, locale, and proxy/TLS configuration. Nothing else. Credentials are opt-in by name or by prefix. | Closing the injection surface costs one allowlist on day one. |

Three things here are worth taking, in this order: the disciplines, the tests that enforce them,
and the code. The engine is about 1,000 lines, so you can read all of it, and the demo below
runs in one clone and two commands.

## The problem: green walls

*Why "my evals pass" is often a claim about the harness, not the agent.*

Teams shipping LLM agents converge on the same loop: run the agent, capture its structured
output (the artifact), assert things about it, wire the verdict into CI. The assertions are the
easy part. Keeping them meaningful is not, because grading code fails differently from product
code. When product code breaks, users complain. When grading code breaks, dashboards turn green,
and nobody complains about a green dashboard.

Three failure modes produce green walls in practice:

1. **Vacuous passes.** The suite asserts `plan.risks exists`; someone renames `plan` to
   `proposal`. A naive resolver returns `undefined`, the `exists` helper skips missing values,
   and the case passes forever after. The eval now measures nothing and looks identical to one
   that measures everything.
2. **Grader regressions.** A refactor inverts a condition, or an exception handler swallows the
   failure branch. Every case passes. No test notices, because the tests only ever fed the
   checks good artifacts.
3. **Fabricated failures.** The inverse: the run hits a spend limit halfway through and the
   harness records the unrun samples as failed. Your metric now mixes "the agent got worse"
   with "the credit card got declined", and the trend line is noise.

A fourth problem is not about measurement but about reach: the agent under eval usually inherits
the parent environment, including every credential the CI runner holds. An eval that executes
fixture-driven commands is an injection surface. Closing it costs nothing on day one and a
migration later.

This library is a deliberate answer to those four, and the tests are the point: about 600 lines
of them against about 760 lines of engine.

## The five disciplines

*Each one is enforced in code or in the test suite, not in a style guide.*

### 1. Fail closed

A missing path is a failed assertion, never a skipped one. Path resolution (`steps[*].test`)
resolves **own properties only**: `constructor`, `toString`, and the rest of the prototype chain
never resolve, so a crafted or accidental path cannot vacuously pass. An empty path segment never
resolves either. Regex assertions are bounded (200-char patterns, 100 KB inputs), so a
pathological pattern degrades to a failed check instead of a hung run. When in doubt, the engine
votes fail.

### 2. Canary the graders

Every check kind must ship a **known-pass and a known-fail fixture**, and a meta-test asserts
the canary registry covers the check registry exactly. Add a check without canaries: the build
fails. Break a check so it always passes: its known-fail canary fails the build. Above the unit
canaries sits a **fire alarm**: an end-to-end test that spawns a real subprocess with a seeded
defect and proves the run reaches a failing verdict. If every other test were deleted, that one
would still catch an engine that stopped failing things. "Who grades the graders" is not a
philosophy question. It is a test file.

### 3. Fuse, don't fabricate

Real agent evals spend real money, so the driver carries a run-level **token fuse** (default 3M
input+output tokens) plus a per-sample wall-clock timeout. When the fuse trips, the run aborts
with an infrastructure error (`FuseExhaustedError`). It never records the unrun samples as
failures, because budget exhaustion is a fact about your wallet, not about your agent. Timeouts
are recorded as timeouts, distinct from grading failures, for the same reason.

### 4. Spawn with an allowlist

The subprocess gets PATH, HOME, locale, and proxy/TLS configuration. Nothing else. Credentials
are **opt-in by name** (`envAllow: ["ANTHROPIC_API_KEY"]`) or by prefix (`envAllowPrefixes:
["MYAGENT_"]`). The default is that the agent under eval cannot read a secret you did not
knowingly hand it.

### 5. Control cases

A suite that only contains cases expected to pass cannot tell you the grader still works. A
**control case** (`"expect": "fail"`) runs a deliberately sabotaged input, a seeded defect, and
the case is only satisfied when grading catches it. One subtlety the engine owns for you: a
control that times out proves nothing was graded, so a timeout never counts as a caught defect.
Infrastructure noise must never be read as grader vigilance.

## Quickstart

Requires [Bun](https://bun.sh). The library is plain ESM TypeScript; a compiled npm build is
listed under "What would move me" below.

```sh
git clone https://github.com/rallat/eval-checks && cd eval-checks
bun test                              # canaries, fail-closed paths, fuse semantics, the fire alarm
bun src/cli.ts examples/suite.json    # the CLI, on the smoke demo below
```

(`bun link` makes the `eval-checks` command available globally; `bun run example` runs the same
demo through the library API instead of the CLI.)

The demo grades a stand-in agent (`examples/fake-agent.mjs`, a deterministic script that prints
the same envelope a real agent CLI would, and that can be sabotaged with `--defect`):

```
ok   plan-shape (expect: pass)
       artifact-valid passed: concluded artifact satisfies the output contract
       assertions passed: 4 assertion(s) hold
ok   control-drop-risks (expect: fail)
       assertions failed: path not found: risks (a missing path fails closed)
ok   control-no-tests (expect: fail)
       assertions failed: path not found: steps[*].test (a missing path fails closed)

3/3 cases met their expectation
```

Point it at a real agent by editing one line in the suite: the `command`. Anything that prints
the envelope works: a CLI wrapping Claude, a compiled binary, a shell script.

## The suite format

A suite is plain JSON: the agent's argv, plus cases that append args and declare grading.
Parsing is fail-closed too: unknown keys are rejected, and every issue carries a field path an
author (human or LLM) can self-correct against.

```json
{
  "version": "eval-checks.suite/v1",
  "command": ["my-agent", "plan", "--json"],
  "cases": [
    {
      "caseId": "plan-shape",
      "args": ["--goal", "add rate limiting"],
      "grading": {
        "all": [
          { "kind": "artifact-valid" },
          {
            "kind": "assertions",
            "assert": [
              { "path": "steps", "op": "lengthAtLeast", "value": 2 },
              { "path": "steps[*].test", "op": "exists" }
            ]
          }
        ]
      }
    },
    {
      "caseId": "control-drop-risks",
      "args": ["--goal", "add rate limiting", "--defect", "drop-risks"],
      "expect": "fail",
      "grading": {
        "all": [{ "kind": "assertions", "assert": [{ "path": "risks", "op": "exists" }] }]
      }
    }
  ]
}
```

Two check kinds ship today. `artifact-valid` says the run concluded a well-formed artifact, and
optionally validates it against a contract you provide through the schema-library-agnostic
`Validator` seam (wrap Zod, Ajv, Valibot, or a plain function). `assertions` is a strict AND of
dot-path assertions with six operators: `exists`, `equals`, `contains`, `matches`,
`lengthAtLeast`, `lengthAtMost`. `[*]` fans out over array elements with any-element semantics:
one matching element satisfies the op, while an absent path still fails closed.

The envelope convention is one JSON object on stdout:

```json
{ "ok": true, "artifact": { "...": "..." }, "usage": { "inputTokens": 120, "outputTokens": 340 } }
{ "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "..." } }
```

Prose, partial JSON, or an unknown shape become structured driver errors
(`ENVELOPE_PARSE_ERROR`, `ENVELOPE_SHAPE_ERROR`), never passes. A different surface plugs in via
the `ParseEnvelope` seam.

## The CLI

*Operable by a human in a terminal and by an agent in a repair loop, with the same flags.*

```sh
eval-checks <suite.json> [--samples N] [--cwd DIR] [--timeout-ms N] [--token-fuse N]
            [--env-allow KEY,KEY] [--env-allow-prefix P,P] [--json]
```

`--json` prints the full run report (or the structured error) as one JSON object on stdout. The
exit codes are the contract CI branches on, and they keep the harness's failures separate from
the agent's:

| Exit | Meaning |
|---|---|
| 0 | every case met its expectation |
| 1 | execution failure (token fuse, unexpected error): nothing was graded |
| 2 | invalid usage or an invalid suite (field-level issues on stderr) |
| 3 | one or more cases failed their expectation |

An exit 1 must never be recorded as an exit 3: "the harness broke" and "the agent regressed" are
different facts, and the whole point of this library is refusing to blur them.

## API sketch

```ts
import { parseSuite, runSuite } from "eval-checks";

const suite = parseSuite(JSON.parse(await file.text()));
const report = await runSuite(suite, {
  cwd: projectRoot,
  samplesPerCase: 3,
  envAllow: ["ANTHROPIC_API_KEY"],
  validate: (artifact) => myZodSchema.safeParse(artifact).success
    ? { ok: true }
    : { ok: false, issues: ["artifact violates PlanSchema"] },
});
// report.ok, report.cases[i].samples[j].checks: per-check evidence for repair loops and humans
```

Every seam is injectable (`Exec`, `ParseEnvelope`, `Validator`), so the entire driver is
unit-testable without spawning a process, and the one test that does spawn (the fire alarm) is
doing it on purpose.

## When this is the wrong tool

*Read this adversarially. The limits are load-bearing, and I would rather you bounce off them
here than in production.*

- **You need a quality judge.** Deterministic assertions are proxy metrics. They catch contract
  and shape regressions (the artifact lost its risks section, the steps stopped naming tests,
  the CLI started printing prose) cheaply and reproducibly. They cannot tell a good plan from a
  mediocre one with the right shape. For quality you need judged evals (an LLM or a human
  scoring rubrics), and a judge needs its own calibration set. This library is the floor under
  such a system, not a replacement for it.
- **You want a platform.** promptfoo and Inspect are full evaluation platforms with providers,
  dashboards, and communities. This is a small engine with one conviction, sized to be read in
  an afternoon and embedded in your own tooling. If you are choosing a platform, choose one of
  those; if you are building your own harness, steal these disciplines.
- **You need statistics.** `samplesPerCase` exists, but small-N decision rules (when do 3
  samples justify blocking a merge?) are a separate, genuinely hard topic this library does not
  pretend to solve.

The honest core: most eval effort goes into the agent, and almost none into proving the harness
itself still works. These 1,000 lines are the almost-none, made explicit.

## What would move me

*Planned only when a real need hits, staged, in this order. Not speculative surface.*

1. **A compiled npm distribution**, once someone (me included) embeds this outside a
   Bun-native repo.
2. **A `judged` check kind** behind the same canary discipline: a judge check would ship with
   known-good and known-bad calibration fixtures, or it does not ship.
3. **A published JSON Schema for the suite format**, so authoring agents can self-correct
   against it before the parser does.

The payoff in one line: when this suite goes green you know two things, that the agent still
holds its contract, and that the checks themselves are still capable of going red.

## License

MIT
