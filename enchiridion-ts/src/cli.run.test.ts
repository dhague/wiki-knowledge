/**
 * `run()` tests against the esbuild-bundled `dist/cli.cjs`: importing the
 * bundle must be inert, and `run(argv, sink)` must write only to the sink it is
 * given. Skips (never fails) when the bundle is absent — `npm run build` first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "isomorphic-git";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(__dirname, "..", "dist", "cli.cjs");

// `run()` reads this process's environment; an exported root override would
// redirect cases whose env means "no vault root set".
delete process.env.VAULT;
delete process.env.WIKI_ROOT;

const skipReason = fs.existsSync(distCli)
  ? false
  : "dist/cli.cjs not built — run `npm run build` first";

interface OutputSink {
  out(chunk: string): void;
  err(chunk: string): void;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type Run = (argv: string[], sink: OutputSink) => Promise<RunResult>;

/** A sink that records every chunk, so a case can assert where the bytes went. */
function captureSink(): {
  sink: OutputSink;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    sink: { out: (chunk) => out.push(chunk), err: (chunk) => err.push(chunk) },
    out,
    err,
  };
}

// Snapshot the host's pre-import state. The require below runs at module scope,
// and an import that killed the host would never reach a test.
const exitCodeBeforeImport = process.exitCode;
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;
const realConsoleLog = console.log;
const realConsoleError = console.error;

let run: Run;
if (!skipReason) {
  const require = createRequire(import.meta.url);
  ({ run } = require(distCli) as { run: Run });
}

/** run() must leave the host's streams and console exactly as it found them. */
function hostStreamsUntouched(): void {
  assert.equal(process.stdout.write, realStdoutWrite);
  assert.equal(process.stderr.write, realStderrWrite);
  assert.equal(console.log, realConsoleLog);
  assert.equal(console.error, realConsoleError);
}

/** A committed vault with two searchable pages. */
async function buildCommittedVault(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-run-vault-"));
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  await git.init({ fs, dir: root });
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write(
    "wiki/concepts/bm25-ranking.md",
    "---\ntitle: BM25 Ranking\nsummary: BM25 scores a document against a query by term frequency and inverse document frequency.\ntags:\n  - search\nvolatility: stable\nsource_date: 2026-01-01\n---\n\nBM25 is the lexical ranking function the wiki's FTS5 index scores hits with.\n",
  );
  write(
    "wiki/concepts/sourdough-starter.md",
    "---\ntitle: Feeding a Sourdough Starter\nsummary: Daily flour-and-water feeding keeps a starter active.\ntags:\n  - baking\nvolatility: stable\nsource_date: 2026-01-02\n---\n\nA sourdough starter needs equal parts flour and water once a day, kept warm.\n",
  );
  await git.add({ fs, dir: root, filepath: "." });
  await git.commit({
    fs,
    dir: root,
    message: "fixtures",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });
  return root;
}

/** Run once with env layered over the process's own, restoring it after. An
 * undefined value unsets the variable for the run. */
async function runEnv(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { sink } = captureSink();
    return await run(argv, sink);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test(
  "importing the bundle is inert: host survives, streams and exitCode untouched",
  { skip: skipReason },
  () => {
    // Merely reaching this test proves the import didn't process.exit the host.
    assert.equal(process.exitCode, exitCodeBeforeImport);
    hostStreamsUntouched();
  },
);

test(
  "run([]): bare invocation writes usage through the given sink, exitCode 0",
  { skip: skipReason },
  async () => {
    const { sink, out, err } = captureSink();
    const result = await run([], sink);
    assert.match(out.join(""), /Usage:/);
    assert.equal(result.stdout, out.join(""), "the result is the sink's bytes");
    assert.equal(result.stderr, err.join(""), "stderr reached the sink too");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(process.stdout.write, realStdoutWrite);
    assert.equal(process.stderr.write, realStderrWrite);
    assert.equal(console.log, realConsoleLog);
    assert.equal(console.error, realConsoleError);
    // The help path never sets it — unset (or 0) is the "not left set" bar.
    assert.ok(
      process.exitCode == null || process.exitCode === 0,
      "host exitCode left set",
    );
  },
);

test(
  "run(['place', ...]): computes a vault-relative path in-process",
  { skip: skipReason },
  async () => {
    const { sink, out } = captureSink();
    const result = await run(["place", "concept", "Connection Pooling"], sink);
    assert.equal(out.join("").trim(), "wiki/concepts/connection-pooling.md");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
  },
);

test(
  "run(): the in-process exit code carries the same class as the process entry point",
  { skip: skipReason },
  async () => {
    // Bad invocation, including a parse refusal on a *subcommand* — which
    // without the whole-tree exit override would process.exit(1) and kill this
    // host rather than return.
    for (const argv of [
      ["place", "nonsense", "X"],
      ["place"],
      ["totally-bogus-command"],
    ]) {
      const result = await runEnv(argv, {});
      assert.equal(result.exitCode, 2, `${argv.join(" ")}: ${result.stderr}`);
    }

    // Bad environment: a well-formed invocation naming a page that is not
    // there. `read-page` resolves the root, so point it at an empty one.
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "enchiridion-run-root-"),
    );
    const result = await runEnv(["read-page", "wiki/concepts/missing.md"], {
      VAULT: root,
    });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /page not found/);

    assert.equal((await runEnv(["--version"], {})).exitCode, 0);
    assert.ok(
      process.exitCode == null || process.exitCode === 0,
      "host exitCode left set",
    );
    hostStreamsUntouched();
  },
);

test(
  "run(['search', ...]): FTS hits return in-process (wasm loads)",
  { skip: skipReason },
  async () => {
    const root = await buildCommittedVault();
    const result = await runEnv(["search", "bm25", "--limit", "2"], {
      VAULT: root,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /wiki\/concepts\/bm25-ranking\.md/);
    hostStreamsUntouched();
  },
);

test(
  "run(['save-session']): reads OPENCODE_SESSION_ID from process.env (not 'neither ID' error)",
  { skip: skipReason },
  async () => {
    // This suite may itself run inside a Claude Code session that sets
    // CLAUDE_CODE_SESSION_ID; unset it so only the OpenCode path runs.
    const result = await runEnv(["save-session", "--slug", "test-session"], {
      OPENCODE_SESSION_ID: "test-opencode-session-id",
      CLAUDE_CODE_SESSION_ID: undefined,
    });
    // The "neither ID" error would mean the env var was invisible.
    assert.notEqual(result.exitCode, 0);
    assert.ok(
      !result.stderr.includes("Neither $CLAUDE_CODE_SESSION_ID"),
      `Expected OPENCODE_SESSION_ID to be read; got: ${result.stderr.trim()}`,
    );
    // Any failure past the host-ID check: tracker diagnostics, a missing CLI,
    // or an `export` that failed for whatever reason the local machine has.
    assert.match(result.stderr, /opencode|session-tracker/i);
  },
);
