#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunReport } from "./runner.js";
import { runSuite } from "./runner.js";
import { parseSuite, SuiteParseError } from "./suite.js";

/**
 * The eval-checks CLI. Deterministic exit codes are the contract CI and outer agents branch on:
 *
 *   0  every case met its expectation
 *   1  execution failure (token fuse, unexpected error): nothing was graded; an infrastructure
 *      fact, never mixed into the grading signal
 *   2  invalid usage or an invalid suite (field-level issues on stderr)
 *   3  one or more cases failed their expectation
 */

const USAGE = `Usage: eval-checks <suite.json> [options]

Options:
  --samples <n>            samples per case (default 1)
  --cwd <dir>              working directory for the agent subprocess (default: cwd)
  --timeout-ms <n>         per-sample wall-clock timeout in milliseconds
  --token-fuse <n>         run-level input+output token budget
  --env-allow <a,b>        extra environment variable names passed to the agent
  --env-allow-prefix <a,b> extra environment variable prefixes passed to the agent
  --json                   print the run report (or the error) as JSON on stdout
  --help                   show this help

Exit codes: 0 all expectations met | 1 execution failure | 2 invalid usage or suite | 3 cases failed`;

interface CliOptions {
  suitePath: string;
  json: boolean;
  samples?: number;
  cwd?: string;
  timeoutMs?: number;
  tokenFuse?: number;
  envAllow?: string[];
  envAllowPrefixes?: string[];
}

class UsageError extends Error {}

function parseInteger(value: string | undefined, flag: string): number {
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return n;
}

function parseList(value: string | undefined, flag: string): string[] {
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) throw new UsageError(`${flag} requires a non-empty list`);
  return items;
}

export function parseArgs(argv: string[]): CliOptions | "help" {
  const positional: string[] = [];
  const opts: Omit<CliOptions, "suitePath"> = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        return "help";
      case "--json":
        opts.json = true;
        break;
      case "--samples":
        opts.samples = parseInteger(argv[++i], arg);
        break;
      case "--cwd": {
        const dir = argv[++i];
        if (dir === undefined) throw new UsageError("--cwd requires a value");
        opts.cwd = resolve(dir);
        break;
      }
      case "--timeout-ms":
        opts.timeoutMs = parseInteger(argv[++i], arg);
        break;
      case "--token-fuse":
        opts.tokenFuse = parseInteger(argv[++i], arg);
        break;
      case "--env-allow":
        opts.envAllow = parseList(argv[++i], arg);
        break;
      case "--env-allow-prefix":
        opts.envAllowPrefixes = parseList(argv[++i], arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new UsageError(`unknown option: ${arg}`);
        }
        if (arg !== undefined) positional.push(arg);
    }
  }
  const suitePath = positional[0];
  if (suitePath === undefined || positional.length !== 1) {
    throw new UsageError("exactly one <suite.json> argument is required");
  }
  return { suitePath: resolve(suitePath), ...opts };
}

function renderHuman(report: RunReport): string {
  const lines: string[] = [];
  for (const c of report.cases) {
    lines.push(`${c.ok ? "ok  " : "FAIL"} ${c.caseId} (expect: ${c.expect})`);
    for (const sample of c.samples) {
      for (const check of sample.checks ?? []) {
        const verdict = check.passed ? "passed" : "failed";
        lines.push(`       ${check.kind} ${verdict}: ${check.detail}`);
      }
      if (sample.timedOut) lines.push("       timed out");
      else if (sample.errorCode !== undefined && sample.checks === undefined) {
        lines.push(`       ${sample.errorCode}`);
      }
    }
  }
  lines.push("");
  lines.push(`${report.counts.ok}/${report.cases.length} cases met their expectation`);
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  let cli: CliOptions;
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      console.log(USAGE);
      return 0;
    }
    cli = parsed;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  let suite: ReturnType<typeof parseSuite>;
  try {
    suite = parseSuite(JSON.parse(readFileSync(cli.suitePath, "utf8")));
  } catch (error) {
    if (error instanceof SuiteParseError) {
      if (cli.json) {
        console.log(
          JSON.stringify({ ok: false, error: { code: "SUITE_INVALID", issues: error.issues } }),
        );
      } else {
        console.error("invalid suite:");
        for (const issue of error.issues) console.error(`  ${issue.path}: ${issue.message}`);
      }
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (cli.json) {
      console.log(JSON.stringify({ ok: false, error: { code: "SUITE_UNREADABLE", message } }));
    } else {
      console.error(`could not read suite: ${message}`);
    }
    return 2;
  }

  try {
    const report = await runSuite(suite, {
      ...(cli.samples !== undefined ? { samplesPerCase: cli.samples } : {}),
      ...(cli.cwd !== undefined ? { cwd: cli.cwd } : {}),
      ...(cli.timeoutMs !== undefined ? { sampleTimeoutMs: cli.timeoutMs } : {}),
      ...(cli.tokenFuse !== undefined ? { runTokenFuse: cli.tokenFuse } : {}),
      ...(cli.envAllow !== undefined ? { envAllow: cli.envAllow } : {}),
      ...(cli.envAllowPrefixes !== undefined ? { envAllowPrefixes: cli.envAllowPrefixes } : {}),
    });
    if (cli.json) console.log(JSON.stringify(report));
    else console.log(renderHuman(report));
    return report.ok ? 0 : 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cli.json) {
      console.log(JSON.stringify({ ok: false, error: { code: "EXECUTION_FAILED", message } }));
    } else {
      console.error(`execution failed: ${message}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
