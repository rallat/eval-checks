import { execFile } from "node:child_process";
import { type CandidateOutput, type CheckResult, runChecks, type Validator } from "./checks.js";
import type { Grading } from "./suite.js";

/**
 * The live driver: produce one graded sample by spawning the agent under evaluation as a real
 * subprocess (the exact surface your users run), parsing the JSON envelope it prints, and running
 * the case's checks against the concluded artifact.
 *
 * Bounded at two levels: a per-sample wall-clock timeout SIGKILLs a wedged agent (a failed,
 * `timedOut` sample), and a run-level token fuse aborts the whole run once cumulative spend
 * crosses it. Exhaustion throws `FuseExhaustedError`: budget exhaustion is an infrastructure
 * problem and must surface as one, never as fabricated sample failures that poison the metric.
 */

/** What one subprocess execution returned. `timedOut` means the driver killed it. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

/** The subprocess seam, injected so every driver branch is unit-testable without spawning. */
export type Exec = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number; env: Record<string, string> },
) => Promise<ExecResult>;

/** Engine default per-sample wall-clock bound. */
export const DEFAULT_SAMPLE_TIMEOUT_MS = 10 * 60_000;

/** Engine default run-level token fuse (input + output tokens summed across samples). */
export const DEFAULT_RUN_TOKEN_FUSE = 3_000_000;

/**
 * Environment allowlist for the agent subprocess: enough to execute (PATH, HOME, locale), reach
 * the network through a proxy, and trust its certificates. Nothing else, and in particular no
 * credentials by default: an agent that can run fixture-driven shell commands must never read
 * unrelated secrets from an inherited environment. Grant credentials by name via `envAllow` /
 * `envAllowPrefixes` (e.g. `["ANTHROPIC_API_KEY"]`). Cheap to enforce now, painful to retrofit.
 */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export function allowlistedEnv(
  env: Record<string, string | undefined>,
  extra: { keys?: string[]; prefixes?: string[] } = {},
): Record<string, string> {
  const keys = new Set([...ENV_ALLOWLIST, ...(extra.keys ?? [])]);
  const prefixes = extra.prefixes ?? [];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (keys.has(key) || prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

/** Model spend reported by the agent's envelope, when it reports one. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What envelope parsing concluded: a candidate for grading, plus usage when reported. */
export interface ParsedEnvelope {
  candidate: CandidateOutput;
  usage?: TokenUsage | undefined;
}

/** The envelope seam: how the agent's stdout becomes a gradable candidate. */
export type ParseEnvelope = (stdout: string, exitCode: number) => ParsedEnvelope;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function usageFrom(value: unknown): TokenUsage | undefined {
  if (!isPlainObject(value)) return undefined;
  const { inputTokens, outputTokens } = value;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  return { inputTokens, outputTokens };
}

/**
 * The default envelope convention: the agent prints exactly one JSON object to stdout, either
 * `{ "ok": true, "artifact": ..., "usage"?: { "inputTokens", "outputTokens" } }` or
 * `{ "ok": false, "error": { "code": string, "message"?: string } }`. Anything else is a
 * structured driver error (`ENVELOPE_PARSE_ERROR` / `ENVELOPE_SHAPE_ERROR`), never a pass.
 * Agents with a different surface plug in their own `ParseEnvelope`.
 */
export const parseDefaultEnvelope: ParseEnvelope = (stdout, exitCode) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      candidate: {
        ok: false,
        errorCode: "ENVELOPE_PARSE_ERROR",
        detail: `agent exited ${exitCode} without a parseable JSON envelope`,
      },
    };
  }
  if (isPlainObject(parsed) && parsed.ok === true && Object.hasOwn(parsed, "artifact")) {
    const usage = usageFrom(parsed.usage);
    if (exitCode !== 0) {
      return {
        candidate: { ok: false, errorCode: `AGENT_EXIT_${exitCode}` },
        ...(usage !== undefined ? { usage } : {}),
      };
    }
    return {
      candidate: { ok: true, artifact: parsed.artifact },
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (isPlainObject(parsed) && parsed.ok === false && isPlainObject(parsed.error)) {
    const code = typeof parsed.error.code === "string" ? parsed.error.code : "AGENT_ERROR";
    const message = typeof parsed.error.message === "string" ? parsed.error.message : undefined;
    return {
      candidate: {
        ok: false,
        errorCode: code,
        ...(message !== undefined ? { detail: message } : {}),
      },
    };
  }
  return {
    candidate: {
      ok: false,
      errorCode: "ENVELOPE_SHAPE_ERROR",
      detail: `agent exited ${exitCode} with an unrecognized envelope shape`,
    },
  };
};

/** The default subprocess implementation, backed by `node:child_process.execFile`. */
export const spawnProcess: Exec = (argv, opts) =>
  new Promise((resolvePromise) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      resolvePromise({ exitCode: 1, stdout: "", timedOut: false });
      return;
    }
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        env: opts.env,
      },
      (error, stdout) => {
        // Node sets `killed` for both the timeout kill and a maxBuffer overflow; only the former
        // is a timeout. An over-chatty subprocess is an envelope failure, not a hang.
        const maxBufferExceeded =
          error !== null && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const killed = error !== null && "killed" in error && error.killed === true;
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({
          exitCode: code,
          stdout: stdout ?? "",
          timedOut: killed && !maxBufferExceeded,
        });
      },
    );
  });

/** One graded sample. `passed` is the grading verdict; the rest is evidence. */
export interface SampleResult {
  passed: boolean;
  checks?: CheckResult[];
  timedOut?: boolean;
  errorCode?: string;
  usage?: TokenUsage;
  durationMs: number;
}

/** Thrown when the run-level token fuse trips. Catch it as an execution failure (your CI's
 * "infrastructure red"), and never record it as sample failures. */
export class FuseExhaustedError extends Error {
  constructor(spent: number, fuse: number) {
    super(
      `run token fuse exhausted (${spent} >= ${fuse} input+output tokens); ` +
        "aborting instead of fabricating failures",
    );
    this.name = "FuseExhaustedError";
  }
}

export interface DriverOptions {
  /** argv of the agent under evaluation; each sample appends the case's `args`. */
  command: string[];
  /** Working directory for the subprocess. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Artifact contract for `artifact-valid`, when you have one. */
  validate?: Validator;
  parseEnvelope?: ParseEnvelope;
  exec?: Exec;
  sampleTimeoutMs?: number;
  runTokenFuse?: number;
  /** Extra environment variable names to pass through to the agent (e.g. an API key). */
  envAllow?: string[];
  /** Extra environment variable prefixes to pass through (e.g. `"MYAGENT_"`). */
  envAllowPrefixes?: string[];
}

export type RunSample = (grading: Grading, caseArgs: string[]) => Promise<SampleResult>;

/**
 * Build the sample runner for one eval run. The returned function is stateful in exactly one way:
 * the token fuse accumulates across samples and throws `FuseExhaustedError` once crossed.
 */
export function createDriver(opts: DriverOptions): RunSample {
  const exec = opts.exec ?? spawnProcess;
  const parseEnvelope = opts.parseEnvelope ?? parseDefaultEnvelope;
  const timeoutMs = opts.sampleTimeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS;
  const fuse = opts.runTokenFuse ?? DEFAULT_RUN_TOKEN_FUSE;
  const cwd = opts.cwd ?? process.cwd();
  const env = allowlistedEnv(process.env, {
    ...(opts.envAllow !== undefined ? { keys: opts.envAllow } : {}),
    ...(opts.envAllowPrefixes !== undefined ? { prefixes: opts.envAllowPrefixes } : {}),
  });
  let tokensSpent = 0;

  return async (grading, caseArgs) => {
    if (tokensSpent >= fuse) throw new FuseExhaustedError(tokensSpent, fuse);

    const startMs = Date.now();
    const result = await exec([...opts.command, ...caseArgs], { cwd, timeoutMs, env });
    if (result.timedOut) {
      return { passed: false, timedOut: true, durationMs: Date.now() - startMs };
    }

    const { candidate, usage } = parseEnvelope(result.stdout, result.exitCode);
    // Accuracy note: error envelopes usually carry no usage, so spend that ends in a failed run
    // never debits the fuse. Total spend stays bounded by the per-sample timeout times the number
    // of samples, but the fuse undercounts on failing runs.
    if (usage !== undefined) tokensSpent += usage.inputTokens + usage.outputTokens;

    const { passed, results } = runChecks(grading, { candidate, validate: opts.validate });
    return {
      passed,
      checks: results,
      durationMs: Date.now() - startMs,
      ...(candidate.ok ? {} : { errorCode: candidate.errorCode }),
      ...(usage !== undefined ? { usage } : {}),
    };
  };
}
