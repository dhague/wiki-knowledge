/**
 * In-process `run()` tests against the esbuild-bundled `dist/cli.cjs`: importing
 * the bundle must be inert and `run(argv)` captures output without touching the
 * host. Skips (never fails) when the bundle is absent — `npm run build` first.
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

const skipReason = fs.existsSync(distCli)
  ? false
  : "dist/cli.cjs not built — run `npm run build` first";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Snapshot the host's pre-import state. The require below runs at module scope,
// and an import that killed the host would never reach a test.
const exitCodeBeforeImport = process.exitCode;
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;
const realConsoleLog = console.log;
const realConsoleError = console.error;

let run: (argv: string[]) => Promise<RunResult>;
if (!skipReason) {
  const require = createRequire(import.meta.url);
  ({ run } = require(distCli) as {
    run: (argv: string[]) => Promise<RunResult>;
  });
}

/** A committed vault with one searchable page. */
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

test(
  "importing the bundle is inert: host survives, exitCode unset",
  { skip: skipReason },
  () => {
    // Merely reaching this test proves the import didn't process.exit the host.
    assert.equal(process.exitCode, exitCodeBeforeImport);
  },
);

test(
  "run([]): bare invocation prints usage to stdout, exitCode 0",
  { skip: skipReason },
  async () => {
    const result = await run([]);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    // The help path never sets it — unset (or 0) is the "not left set" bar.
    assert.ok(
      process.exitCode == null || process.exitCode === 0,
      "host exitCode left set",
    );
    assert.equal(process.stdout.write, realStdoutWrite);
    assert.equal(process.stderr.write, realStderrWrite);
    assert.equal(console.log, realConsoleLog);
    assert.equal(console.error, realConsoleError);
  },
);

test(
  "run(['--help']): help to stdout, exitCode 0",
  { skip: skipReason },
  async () => {
    const result = await run(["--help"]);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.exitCode, 0);
  },
);

test(
  "run(['place', ...]): computes a vault-relative path in-process",
  { skip: skipReason },
  async () => {
    const result = await run(["place", "concept", "Connection Pooling"]);
    assert.equal(result.stdout.trim(), "wiki/concepts/connection-pooling.md");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
  },
);

test(
  "run(['place', 'nonsense', 'X']): error to stderr, exitCode non-zero, host exitCode untouched",
  { skip: skipReason },
  async () => {
    const result = await run(["place", "nonsense", "X"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unknown kind/);
    // The failure is reported in the result, never left on the host process.
    assert.ok(
      process.exitCode == null || process.exitCode === 0,
      "host exitCode left set",
    );
  },
);

test(
  "after runs: streams restored to the real ones, host can still write",
  { skip: skipReason },
  async () => {
    await run(["place", "concept", "Restored Streams"]);
    assert.equal(process.stdout.write, realStdoutWrite);
    assert.equal(process.stderr.write, realStderrWrite);
    assert.equal(console.log, realConsoleLog);
    assert.equal(console.error, realConsoleError);
    assert.ok(
      process.exitCode == null || process.exitCode === 0,
      "host exitCode left set",
    );
    // Writing now reaches the real stream, not a captured array.
    assert.equal(process.stdout.write(""), true);
  },
);

test(
  "run(['search', ...]): FTS hits return in-process (wasm loads)",
  { skip: skipReason },
  async () => {
    const root = await buildCommittedVault();
    const prevWikiRoot = process.env.WIKI_ROOT;
    process.env.WIKI_ROOT = root;
    try {
      const result = await run(["search", "bm25", "--limit", "2"]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /wiki\/concepts\/bm25-ranking\.md/);
      assert.equal(process.exitCode, 0);
      assert.equal(process.stdout.write, realStdoutWrite);
      assert.equal(process.stderr.write, realStderrWrite);
      assert.equal(console.log, realConsoleLog);
      assert.equal(console.error, realConsoleError);
    } finally {
      if (prevWikiRoot === undefined) delete process.env.WIKI_ROOT;
      else process.env.WIKI_ROOT = prevWikiRoot;
    }
  },
);

test(
  "run(['save-session']): reads OPENCODE_SESSION_ID from process.env (not 'neither ID' error)",
  { skip: skipReason },
  async () => {
    const prevSessionID = process.env.OPENCODE_SESSION_ID;
    const prevClaudeID = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.OPENCODE_SESSION_ID = "test-opencode-session-id";
    // This suite may itself run inside a Claude Code session that sets
    // CLAUDE_CODE_SESSION_ID; unset it so only the OpenCode path runs.
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      const result = await run(["save-session", "--slug", "test-session"]);
      // The "neither ID" error would mean the env var was invisible.
      assert.notEqual(result.exitCode, 0);
      assert.ok(
        !result.stderr.includes("Neither $CLAUDE_CODE_SESSION_ID"),
        `Expected OPENCODE_SESSION_ID to be read; got: ${result.stderr.trim()}`,
      );
      // Downstream of the ID being read: tracker diagnostics or a missing CLI.
      assert.match(
        result.stderr,
        /OPENCODE_SESSION_ID|session-tracker|opencode CLI/,
      );
    } finally {
      if (prevSessionID === undefined) delete process.env.OPENCODE_SESSION_ID;
      else process.env.OPENCODE_SESSION_ID = prevSessionID;
      if (prevClaudeID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prevClaudeID;
    }
  },
);
