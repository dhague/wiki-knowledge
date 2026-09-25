/** Unit tests for transcriptcapture: mock env lookups, fixture transcripts, and an
 * injectable export seam — no real fetch and no real `opencode` invocation. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sanitizeSlug,
  transcriptToPage,
  parseClaudeTranscript,
  findTranscriptPath,
  writeCapture,
  normalizeExport,
  captureOpenCodeSession,
  captureSession,
  openCodeSessionIDFromEnv,
  isOpenCodeSessionTracked,
  findOpenCodeSessionsDir,
  ErrTooFewTurns,
  CaptureError,
} from "./transcriptcapture.js";
import { findSessionsDir } from "./sessionstate.js";
import type { Turn } from "./transcriptcapture.js";
import type { LookupEnv } from "./sessionstate.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "transcriptcapture-test-"));
}

/** Build a LookupEnv from a fixed map (missing keys report not-present). */
function env(map: Record<string, string>): LookupEnv {
  return (key: string): [string | undefined, boolean] => {
    const value = map[key];
    return [value, value !== undefined];
  };
}

const NOW = new Date("2026-01-02T03:04:00");

function jsonlLine(type: string, content: unknown): string {
  return JSON.stringify({
    type,
    isMeta: false,
    isSidechain: false,
    message: { role: type, content },
  });
}

function transcriptFixture(): string[] {
  return [
    jsonlLine("user", "Hello there"),
    jsonlLine("assistant", "Hi! How can I help?"),
    jsonlLine("user", "Tell me about pooling."),
    jsonlLine("assistant", "Pooling keeps handles around."),
  ];
}

/** The domain turn shape both host adapters reduce to. */
function turnFixture(): Turn[] {
  return [
    { role: "user", text: "Hello there" },
    { role: "assistant", text: "Hi! How can I help?" },
    { role: "user", text: "Tell me about pooling." },
    { role: "assistant", text: "Pooling keeps handles around." },
  ];
}

// ---------------------------------------------------------------------------
// sanitizeSlug
// ---------------------------------------------------------------------------

test("sanitizeSlug lowercases, collapses, and strips", () => {
  assert.equal(
    sanitizeSlug("  Connection   Pooling  ", 60),
    "connection-pooling",
  );
  assert.equal(
    sanitizeSlug("What is a Wiki? (Deep Dive)", 60),
    "what-is-a-wiki-deep-dive",
  );
});

test("sanitizeSlug folds non-ASCII and drops unicode scripts", () => {
  assert.equal(sanitizeSlug("caf\u00e9 time", 60), "cafe-time");
  assert.equal(sanitizeSlug("\u3053\u3093\u306b\u3061\u306f", 60), "");
});

test("sanitizeSlug returns empty for empty/pure-punctuation input", () => {
  assert.equal(sanitizeSlug("", 60), "");
  assert.equal(sanitizeSlug("!!!", 60), "");
});

test("sanitizeSlug caps on a word boundary when possible", () => {
  assert.equal(sanitizeSlug("aaa-bbb-ccc", 7), "aaa-bbb");
  // No separator inside the window: hard-truncate to the cap.
  assert.equal(sanitizeSlug("aaaaaaaaaaaa bbbbbbbbbbb", 10), "aaaaaaaaaa");
});

test("sanitizeSlug uses a default maxLength when given <= 0", () => {
  assert.equal(sanitizeSlug("a".repeat(120), 0), "a".repeat(60));
});

// ---------------------------------------------------------------------------
// transcriptToPage
// ---------------------------------------------------------------------------

test("transcriptToPage renders user/assistant turns and a deterministic filename", () => {
  const [filename, markdown] = transcriptToPage(
    turnFixture(),
    "Claude Code",
    "sess-abc-123",
    NOW,
    "Connection Pooling",
    "User",
    "Claude",
    2,
  );
  assert.equal(filename, "2026-01-02-0304-connection-pooling-sess.md");
  assert.match(markdown, /^# Session sess-abc-123/);
  assert.match(markdown, /\*\*Saved:\*\* 2026-01-02 03:04 {2}/);
  assert.match(markdown, /## User\n\nHello there/);
  assert.match(markdown, /## Claude\n\nHi! How can I help\?/);
});

test("transcriptToPage reflects the passed host label in the Source line", () => {
  const [, markdown] = transcriptToPage(
    [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
    "OpenCode",
    "s-1",
    NOW,
    "",
    "User",
    "Claude",
    2,
  );
  assert.match(
    markdown,
    /\*\*Source:\*\* OpenCode session transcript \(save-conversation skill, enchiridion repo\)/,
  );
});

test("transcriptToPage degrades an empty slug to the bare date-shortid name", () => {
  const [filename] = transcriptToPage(
    turnFixture(),
    "Claude Code",
    "sess-abc",
    NOW,
    "",
    "User",
    "Claude",
    2,
  );
  assert.equal(filename, "2026-01-02-0304-sess.md");
});

test("transcriptToPage throws ErrTooFewTurns when below minTurns", () => {
  assert.throws(
    () =>
      transcriptToPage(
        [{ role: "user", text: "only one turn" }],
        "Claude Code",
        "s-1",
        NOW,
        "",
        "User",
        "Claude",
        2,
      ),
    (err: unknown) =>
      err instanceof ErrTooFewTurns && err.turns === 1 && err.minTurns === 2,
  );
});

// ---------------------------------------------------------------------------
// parseClaudeTranscript (the Claude Code host adapter)
// ---------------------------------------------------------------------------

test("parseClaudeTranscript maps JSONL lines into user/assistant turns", () => {
  const turns = parseClaudeTranscript(transcriptFixture());
  assert.deepEqual(turns, turnFixture());
});

test("parseClaudeTranscript ignores meta, sidechain, and non user/assistant entries", () => {
  const lines = [
    jsonlLine("user", "hi"),
    JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "hidden" },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: "hidden" },
    }),
    JSON.stringify({
      type: "system",
      message: { role: "system", content: "sys" },
    }),
    jsonlLine("assistant", "hello"),
  ];
  const turns = parseClaudeTranscript(lines);
  assert.deepEqual(turns, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);
});

test("parseClaudeTranscript only counts text blocks, joining multiple with a blank line", () => {
  const lines = [
    jsonlLine("user", "hello"),
    jsonlLine("assistant", [
      { type: "text", text: "one" },
      { type: "tool_use", name: "Read" },
      { type: "text", text: "two" },
    ]),
  ];
  const turns = parseClaudeTranscript(lines);
  assert.deepEqual(turns, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "one\n\ntwo" },
  ]);
});

test("parseClaudeTranscript excludes tool_use and tool_result blocks", () => {
  const lines = [
    jsonlLine("user", "hello"),
    jsonlLine("assistant", [
      { type: "tool_use", name: "Read" },
      { type: "tool_result", content: "file contents" },
      { type: "text", text: "here is the file" },
    ]),
  ];
  const turns = parseClaudeTranscript(lines);
  assert.deepEqual(turns, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "here is the file" },
  ]);
});

test("parseClaudeTranscript skips garbled and empty lines", () => {
  const turns = parseClaudeTranscript([
    jsonlLine("user", "hi"),
    "not json at all",
    "",
    "   ",
    jsonlLine("assistant", "hello"),
  ]);
  assert.deepEqual(turns, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);
});

// ---------------------------------------------------------------------------
// findTranscriptPath
// ---------------------------------------------------------------------------

function claudeEnvAndState(): {
  wikiRoot: string;
  stateDir: string;
  lookupEnv: LookupEnv;
  transcriptPath: string;
} {
  const project = tmp();
  const stateDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  fs.mkdirSync(stateDir, { recursive: true });
  const transcriptPath = path.join(project, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, transcriptFixture().join("\n"));
  fs.writeFileSync(
    path.join(stateDir, "sess-123.json"),
    JSON.stringify({ transcript_path: transcriptPath }),
  );
  const lookupEnv = env({ CLAUDE_CODE_SESSION_ID: "sess-123" });
  return { wikiRoot: project, stateDir, lookupEnv, transcriptPath };
}

test("findTranscriptPath returns the recorded transcript path", () => {
  const { wikiRoot, lookupEnv, transcriptPath } = claudeEnvAndState();
  assert.equal(findTranscriptPath(wikiRoot, lookupEnv), transcriptPath);
});

test("findTranscriptPath throws when CLAUDE_CODE_SESSION_ID is unset", () => {
  assert.throws(
    () => findTranscriptPath("", env({})),
    (err: unknown) =>
      err instanceof CaptureError &&
      /CLAUDE_CODE_SESSION_ID is not set/.test(err.message),
  );
});

test("findTranscriptPath throws when no state directory exists", () => {
  const lookupEnv = env({ CLAUDE_CODE_SESSION_ID: "sess-1" });
  assert.throws(
    () => findTranscriptPath("", lookupEnv),
    (err: unknown) =>
      err instanceof CaptureError &&
      /Could not locate a session state directory/.test(err.message),
  );
});

test("findTranscriptPath throws when the session was never recorded", () => {
  const project = tmp();
  const stateDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  fs.mkdirSync(stateDir, { recursive: true });
  const lookupEnv = env({
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: "unknown",
  });
  assert.throws(
    () => findTranscriptPath("", lookupEnv),
    (err: unknown) =>
      err instanceof CaptureError &&
      /No state recorded for session unknown/.test(err.message),
  );
});

test("findTranscriptPath throws when the recorded transcript is missing", () => {
  const project = tmp();
  const stateDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "sess-9.json"),
    JSON.stringify({ transcript_path: path.join(project, "gone.jsonl") }),
  );
  const lookupEnv = env({
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: "sess-9",
  });
  assert.throws(
    () => findTranscriptPath("", lookupEnv),
    (err: unknown) =>
      err instanceof CaptureError &&
      /Recorded transcript file does not exist/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// writeCapture
// ---------------------------------------------------------------------------

test("writeCapture writes into raw/conversations and returns the vault-relative path", () => {
  const wikiRoot = tmp();
  const rel = writeCapture(
    wikiRoot,
    "2026-01-02-0304-foo-sess.md",
    "content",
    "sess",
  );
  assert.equal(rel, "raw/conversations/2026-01-02-0304-foo-sess.md");
  assert.equal(fs.readFileSync(path.join(wikiRoot, rel), "utf8"), "content");
});

test("writeCapture reuses an existing capture by short id instead of the new filename", () => {
  const wikiRoot = tmp();
  const first = writeCapture(
    wikiRoot,
    "2026-01-02-0304-first-sess.md",
    "old",
    "sess",
  );
  const second = writeCapture(
    wikiRoot,
    "2026-01-03-0506-second-sess.md",
    "new",
    "sess",
  );
  assert.equal(second, "raw/conversations/2026-01-02-0304-first-sess.md");
  assert.equal(fs.readFileSync(path.join(wikiRoot, second), "utf8"), "new");
  assert.ok(
    !first.includes("second"),
    "no second-named file should be created",
  );
  assert.deepEqual(
    fs.readdirSync(path.join(wikiRoot, "raw", "conversations")),
    [path.basename(second)],
    "exactly one raw file for the session",
  );
});

/** An fs error stand-in carrying the `code` a real syscall failure carries. */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test("writeCapture surfaces a listing failure that is not ENOENT (#498)", () => {
  const wikiRoot = tmp();
  const first = writeCapture(
    wikiRoot,
    "2026-01-02-0304-first-sess.md",
    "old",
    "sess",
  );
  const boom = fsError("EACCES", "EACCES: permission denied, scandir 'x'");
  const conversationsDir = path.join(wikiRoot, "raw", "conversations");

  assert.throws(
    () =>
      writeCapture(
        wikiRoot,
        "2026-01-03-0506-second-sess.md",
        "new",
        "sess",
        () => {
          throw boom;
        },
      ),
    (err: unknown) =>
      err instanceof CaptureError &&
      err.message.includes(conversationsDir) &&
      err.message.includes("EACCES") &&
      err.cause === boom,
  );

  // A silent second file would have orphaned the first.
  assert.deepEqual(
    fs.readdirSync(conversationsDir),
    [path.basename(first)],
    "no orphaned second capture",
  );
  assert.equal(fs.readFileSync(path.join(wikiRoot, first), "utf8"), "old");
});

test("writeCapture reads an ENOENT listing failure as no prior capture (#498)", () => {
  const wikiRoot = tmp();
  const rel = writeCapture(
    wikiRoot,
    "2026-01-02-0304-foo-sess.md",
    "content",
    "sess",
    () => {
      throw fsError("ENOENT", "ENOENT: no such file or directory, scandir 'x'");
    },
  );

  assert.equal(rel, "raw/conversations/2026-01-02-0304-foo-sess.md");
  assert.equal(fs.readFileSync(path.join(wikiRoot, rel), "utf8"), "content");
});

test("re-saving a session rewrites its one raw file rather than adding a second", async () => {
  const { wikiRoot, lookupEnv } = claudeEnvAndState();
  const first = await captureSession(
    wikiRoot,
    "Connection Pooling",
    wikiRoot,
    lookupEnv,
    NOW,
  );
  // The name was bound at the first save, so the second must reuse it.
  const second = await captureSession(
    wikiRoot,
    "Something Else Entirely",
    wikiRoot,
    lookupEnv,
    new Date("2026-02-03T04:05:00"),
  );

  assert.equal(second, first, "the re-save rewrites the first file's path");
  const conversationsDir = path.join(wikiRoot, "raw", "conversations");
  assert.deepEqual(
    fs.readdirSync(conversationsDir),
    [path.basename(first)],
    "exactly one raw file for the session",
  );
  assert.match(
    fs.readFileSync(path.join(wikiRoot, second), "utf8"),
    /\*\*Saved:\*\* 2026-02-03 04:05 {2}/,
    "contents are the re-save's",
  );
});

// ---------------------------------------------------------------------------
// normalizeExport (the OpenCode host adapter)
// ---------------------------------------------------------------------------

test("normalizeExport maps an opencode export into user/assistant text turns", () => {
  const doc = JSON.stringify({
    info: { id: "oc-1" },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
          { type: "tool", tool: "Read" },
        ],
      },
      { info: { role: "system" }, parts: [{ type: "text", text: "sys" }] },
    ],
  });
  const turns = normalizeExport(new TextEncoder().encode(doc));
  assert.deepEqual(turns, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "one\n\ntwo" },
  ]);
});

test("normalizeExport throws on invalid JSON and unexpected shapes", () => {
  assert.throws(
    () => normalizeExport(new TextEncoder().encode("not json")),
    (err: unknown) =>
      err instanceof CaptureError && /invalid JSON/.test(err.message),
  );
  assert.throws(
    () => normalizeExport(new TextEncoder().encode("[1,2]")),
    (err: unknown) =>
      err instanceof CaptureError && /unexpected shape/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// captureOpenCodeSession (injectable export seam — no real opencode)
// ---------------------------------------------------------------------------

function openCodeEnvAndState(): {
  project: string;
  lookupEnv: LookupEnv;
  sessionID: string;
} {
  const project = tmp();
  const stateDir = path.join(
    project,
    ".opencode",
    "wiki-knowledge",
    "sessions",
  );
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionID = "oc-abc-999";
  fs.writeFileSync(
    path.join(stateDir, `${sessionID}.json`),
    JSON.stringify({ session_id: sessionID }),
  );
  const lookupEnv = env({ OPENCODE_SESSION_ID: sessionID });
  return { project, lookupEnv, sessionID };
}

test("captureOpenCodeSession writes a capture using the injected export seam", async () => {
  const { lookupEnv, sessionID } = openCodeEnvAndState();
  const doc = JSON.stringify({
    info: { id: sessionID },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "more" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ],
  });
  const exportSeam = async (): Promise<Uint8Array> =>
    new TextEncoder().encode(doc);

  const wikiRoot = tmp();
  const rel = await captureOpenCodeSession(
    wikiRoot,
    "My Session",
    lookupEnv,
    NOW,
    exportSeam,
  );
  assert.match(rel, /^raw\/conversations\/2026-01-02-0304-my-session-oc\.md$/);
  const written = fs.readFileSync(path.join(wikiRoot, rel), "utf8");
  assert.match(written, /^# Session oc-abc-999/);
  assert.match(written, /## Claude\n\nhello/);
});

test("captureOpenCodeSession writes attribution naming OpenCode, not Claude Code", async () => {
  const { lookupEnv, sessionID } = openCodeEnvAndState();
  const doc = JSON.stringify({
    info: { id: sessionID },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ],
  });
  const exportSeam = async (): Promise<Uint8Array> =>
    new TextEncoder().encode(doc);

  const wikiRoot = tmp();
  const rel = await captureOpenCodeSession(
    wikiRoot,
    "",
    lookupEnv,
    NOW,
    exportSeam,
  );
  const written = fs.readFileSync(path.join(wikiRoot, rel), "utf8");
  assert.match(
    written,
    /\*\*Source:\*\* OpenCode session transcript \(save-conversation skill, enchiridion repo\)/,
  );
  assert.ok(!written.includes("Claude Code"));
});

test("captureOpenCodeSession fails when the export seam errors", async () => {
  const { lookupEnv } = openCodeEnvAndState();
  const exportSeam = async (): Promise<Uint8Array> => {
    throw new CaptureError("export exploded");
  };
  await assert.rejects(
    () => captureOpenCodeSession(tmp(), "", lookupEnv, NOW, exportSeam),
    (err: unknown) =>
      err instanceof CaptureError && /export exploded/.test(err.message),
  );
});

test("captureOpenCodeSession captures a session that predates the tracker", async () => {
  // No tracker state at all: `opencode export` still has the transcript, so the
  // capture must succeed anyway.
  const sessionID = "oc-pre-plugin-777";
  const lookupEnv = env({ OPENCODE_SESSION_ID: sessionID });
  const doc = JSON.stringify({
    info: { id: sessionID },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ],
  });
  const exportSeam = async (): Promise<Uint8Array> =>
    new TextEncoder().encode(doc);

  const wikiRoot = tmp();
  const rel = await captureOpenCodeSession(
    wikiRoot,
    "",
    lookupEnv,
    NOW,
    exportSeam,
  );
  assert.match(rel, /-oc\.md$/);
  const written = fs.readFileSync(path.join(wikiRoot, rel), "utf8");
  assert.match(written, /^# Session oc-pre-plugin-777/);
});

test("openCodeSessionIDFromEnv throws when OPENCODE_SESSION_ID is unset", () => {
  assert.throws(
    () => openCodeSessionIDFromEnv(env({})),
    (err: unknown) =>
      err instanceof CaptureError &&
      /OPENCODE_SESSION_ID is not set/.test(err.message),
  );
});

test("openCodeSessionIDFromEnv returns the id whether or not it is tracked", () => {
  const id = openCodeSessionIDFromEnv(env({ OPENCODE_SESSION_ID: "oc-x" }));
  assert.equal(id, "oc-x");
});

test("isOpenCodeSessionTracked is true when the tracker recorded the session", () => {
  const { project, lookupEnv } = openCodeEnvAndState();
  assert.equal(isOpenCodeSessionTracked(project, lookupEnv), true);
});

test("isOpenCodeSessionTracked is false when the session is untracked", () => {
  const { project } = openCodeEnvAndState();
  const other = env({ OPENCODE_SESSION_ID: "oc-other" });
  assert.equal(isOpenCodeSessionTracked(project, other), false);
});

test("isOpenCodeSessionTracked is false when the env var is unset", () => {
  const { project } = openCodeEnvAndState();
  assert.equal(isOpenCodeSessionTracked(project, env({})), false);
});

test("isOpenCodeSessionTracked is false when there is no state directory", () => {
  assert.equal(
    isOpenCodeSessionTracked(tmp(), env({ OPENCODE_SESSION_ID: "oc-x" })),
    false,
  );
});

// ---------------------------------------------------------------------------
// The session root: one rule, per-host layout
// ---------------------------------------------------------------------------

/** A directory that is no project for either host; `home` is injected as $HOME so
 * each walk stops at the boundary instead of escaping into the real filesystem. */
function notAProject(): { home: string; cwd: string } {
  const home = tmp();
  const cwd = path.join(home, "no", "project", "here");
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

test("both host adapters resolve no project when neither marker is present (#493)", () => {
  const { home, cwd } = notAProject();
  const lookupEnv = env({ HOME: home });
  assert.equal(findSessionsDir(cwd, lookupEnv), undefined);
  assert.equal(findOpenCodeSessionsDir(cwd, lookupEnv), undefined);
});

test("findOpenCodeSessionsDir walks up to the nearest .opencode ancestor", () => {
  const project = tmp();
  const nested = path.join(project, "src", "deep");
  fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(
    findOpenCodeSessionsDir(nested, env({})),
    path.join(project, ".opencode", "wiki-knowledge", "sessions"),
  );
});

test("findOpenCodeSessionsDir returns no project rather than falling back to cwd (#493)", () => {
  // With no `.opencode/` above it the answer is "not inside a project", never a
  // cwd-relative guess.
  const { home, cwd } = notAProject();
  assert.equal(findOpenCodeSessionsDir(cwd, env({ HOME: home })), undefined);
});

test("the OpenCode walk stops at the home directory (#493)", () => {
  // `~/.opencode` is global configuration, not a project marker.
  const home = tmp();
  fs.mkdirSync(path.join(home, ".opencode"), { recursive: true });
  const cwd = path.join(home, "scratch");
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(findOpenCodeSessionsDir(cwd, env({ HOME: home })), undefined);
});

test("a project under the home directory still resolves for OpenCode (#485)", () => {
  // A project under $HOME still resolves: its own marker is reached first.
  const home = tmp();
  fs.mkdirSync(path.join(home, ".opencode"), { recursive: true });
  const project = path.join(home, "code", "app");
  fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
  assert.equal(
    findOpenCodeSessionsDir(path.join(project, "src"), env({ HOME: home })),
    path.join(project, ".opencode", "wiki-knowledge", "sessions"),
  );
});

test("the OpenCode adapter has no env override (#493)", () => {
  // OpenCode exports no project-root variable, so a leaked `$CLAUDE_PROJECT_DIR`
  // cannot move this root.
  const { home, cwd } = notAProject();
  const project = tmp();
  fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
  assert.equal(
    findOpenCodeSessionsDir(
      cwd,
      env({ HOME: home, CLAUDE_PROJECT_DIR: project }),
    ),
    undefined,
  );
});

test("each adapter is keyed on its own marker, not the other host's (#493)", () => {
  const home = tmp();
  const lookupEnv = env({ HOME: home });
  const claudeProject = path.join(home, "claude-project");
  fs.mkdirSync(path.join(claudeProject, ".claude"), { recursive: true });
  const openCodeProject = path.join(home, "opencode-project");
  fs.mkdirSync(path.join(openCodeProject, ".opencode"), { recursive: true });

  assert.equal(
    findSessionsDir(claudeProject, lookupEnv),
    path.join(claudeProject, ".claude", "wiki-knowledge", "sessions"),
  );
  assert.equal(findOpenCodeSessionsDir(claudeProject, lookupEnv), undefined);

  assert.equal(
    findOpenCodeSessionsDir(openCodeProject, lookupEnv),
    path.join(openCodeProject, ".opencode", "wiki-knowledge", "sessions"),
  );
  assert.equal(findSessionsDir(openCodeProject, lookupEnv), undefined);
});

test("isOpenCodeSessionTracked reads the tracker state at the project root, not at cwd", () => {
  const { project, lookupEnv } = openCodeEnvAndState();
  const nested = path.join(project, "wiki", "concepts");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(isOpenCodeSessionTracked(nested, lookupEnv), true);
});

test("isOpenCodeSessionTracked answers false with no project, never a cwd guess (#493)", () => {
  const { home, cwd } = notAProject();
  assert.equal(
    isOpenCodeSessionTracked(
      cwd,
      env({ HOME: home, OPENCODE_SESSION_ID: "oc-x" }),
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// captureSession host detection
// ---------------------------------------------------------------------------

test("captureSession throws when no session-id variable is set", async () => {
  await assert.rejects(
    () => captureSession(tmp(), "", "", env({}), NOW),
    (err: unknown) =>
      err instanceof CaptureError &&
      /Neither \$CLAUDE_CODE_SESSION_ID nor \$OPENCODE_SESSION_ID/.test(
        err.message,
      ),
  );
});

test("captureSession uses the Claude Code path when only CLAUDE_CODE_SESSION_ID is set", async () => {
  const { wikiRoot, lookupEnv, transcriptPath } = claudeEnvAndState();
  const rel = await captureSession(
    wikiRoot,
    "Connection Pooling",
    wikiRoot,
    lookupEnv,
    NOW,
  );
  assert.match(
    rel,
    /^raw\/conversations\/2026-01-02-0304-connection-pooling-[\w-]+\.md$/,
  );
  const written = fs.readFileSync(path.join(wikiRoot, rel), "utf8");
  assert.match(written, /## User\n\nHello there/);
  assert.match(written, /## Claude\n\nHi! How can I help\?/);
  void transcriptPath;
});

test("captureSession prefers OpenCode when both ids are set but the tracker recorded it", async () => {
  const { project, lookupEnv: ocEnv, sessionID } = openCodeEnvAndState();
  const { lookupEnv: ccEnv } = claudeEnvAndState();
  const both = (key: string): [string | undefined, boolean] => {
    const fromOc = ocEnv(key);
    if (fromOc[1]) return fromOc;
    return ccEnv(key);
  };
  const doc = JSON.stringify({
    info: { id: sessionID },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ],
  });
  const wikiRoot = tmp();
  const rel = await captureSession(wikiRoot, "", project, both, NOW, async () =>
    new TextEncoder().encode(doc),
  );
  assert.match(rel, /-oc\.md$/);
});

test("captureSession falls back to Claude Code when OpenCode id is untracked", async () => {
  // An untracked OpenCode id never overrides the Claude Code path.
  const { wikiRoot, lookupEnv: ccEnv } = claudeEnvAndState();
  const ocEnv = env({ OPENCODE_SESSION_ID: "oc-untracked" });
  const both = (key: string): [string | undefined, boolean] => {
    const fromCc = ccEnv(key);
    if (fromCc[1]) return fromCc;
    return ocEnv(key);
  };
  const rel = await captureSession(wikiRoot, "", wikiRoot, both, NOW);
  assert.match(rel, /^raw\/conversations\/2026-01-02-0304-transcript\.md$/);
});

test("captureSession dispatches to OpenCode when only OPENCODE_SESSION_ID is set, even untracked", async () => {
  // OpenCode despite no tracker state: the export path must still run.
  const lookupEnv = env({ OPENCODE_SESSION_ID: "oc-nope-123" });
  const doc = JSON.stringify({
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ],
  });
  const wikiRoot = tmp();
  const rel = await captureSession(
    wikiRoot,
    "",
    tmp(),
    lookupEnv,
    NOW,
    async () => new TextEncoder().encode(doc),
  );
  assert.match(rel, /-oc\.md$/);
  const written = fs.readFileSync(path.join(wikiRoot, rel), "utf8");
  assert.match(written, /\*\*Source:\*\* OpenCode session transcript/);
});
