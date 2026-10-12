/** hooks tests — the session-start and post-tool-use handlers, failing open. Each
 * test drives an injected LookupEnv rather than mutating the real one. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionStart, postToolUse, runHook } from "./hooks.js";
import {
  sessionsDir,
  readTranscriptPath,
  readHookErrors,
} from "./sessionstate.js";
import type { LookupEnv, TraceEntry } from "./sessionstate.js";

/** Build a LookupEnv from a fixed map (missing keys report not-present). */
function env(map: Record<string, string>): LookupEnv {
  return (key: string): [string | undefined, boolean] => {
    const value = map[key];
    return [value, value !== undefined];
  };
}

/** Where the hooks should have written for `project`. */
function sessionsDirFor(project: string): string {
  return sessionsDir("", env({ CLAUDE_PROJECT_DIR: project }));
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-hooks-"));
}

/** A project no hook has touched: no `.claude` in it, with `home` injected as
 * $HOME so a walk-up stops there. */
function freshProject(): {
  home: string;
  project: string;
  contentDir: string;
} {
  const home = tmp();
  const project = path.join(home, "project");
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });
  return { home, project, contentDir };
}

// --- SessionStart ------------------------------------------------------------

test("sessionStart records transcript path under $CLAUDE_PROJECT_DIR", () => {
  const project = tmp();
  sessionStart(
    {
      session_id: "abc123",
      transcript_path: "/x/abc123.jsonl",
      cwd: "/somewhere/else",
    },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  assert.equal(
    readTranscriptPath("abc123", sessionsDirFor(project)),
    "/x/abc123.jsonl",
  );
});

test("sessionStart falls back to the payload cwd", () => {
  // At session start the payload cwd is the project root, unlike in postToolUse.
  const { home, project } = freshProject();
  sessionStart(
    {
      session_id: "abc123",
      transcript_path: "/x/abc123.jsonl",
      cwd: project,
    },
    env({ HOME: home }),
  );
  assert.equal(
    readTranscriptPath("abc123", sessionsDirFor(project)),
    "/x/abc123.jsonl",
  );
});

test("sessionStart incomplete payload is a silent no-op", () => {
  for (const payload of [
    { transcript_path: "/x/abc123.jsonl", cwd: tmp() },
    { session_id: "abc123", cwd: tmp() },
  ]) {
    sessionStart(payload, env({}));
    const root = payload.cwd as string;
    assert.ok(
      !fs.existsSync(sessionsDirFor(root)),
      "sessions dir was created; want no state written",
    );
  }
});

// --- PostToolUse -------------------------------------------------------------

function logLines(
  project: string,
  sessionID: string,
): Array<Record<string, unknown>> {
  const data = fs.readFileSync(
    path.join(sessionsDirFor(project), `${sessionID}-tool-calls.jsonl`),
    "utf8",
  );
  return data
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("postToolUse appends one JSON line under the project", () => {
  const project = tmp();
  postToolUse(
    {
      session_id: "abc123",
      cwd: project,
      tool_name: "Bash",
      tool_use_id: "tu_1",
      prompt_id: "pr_1",
      duration_ms: 42,
    },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  const events = logLines(project, "abc123");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    tool: "Bash",
    tool_use_id: "tu_1",
    prompt_id: "pr_1",
    agent_id: null,
    agent_type: null,
    duration_ms: 42,
  });
});

test("postToolUse second call appends rather than overwrites", () => {
  const project = tmp();
  const lookupEnv = env({ CLAUDE_PROJECT_DIR: project });
  postToolUse(
    { session_id: "abc123", cwd: project, tool_name: "Bash" },
    lookupEnv,
  );
  postToolUse(
    { session_id: "abc123", cwd: project, tool_name: "Read" },
    lookupEnv,
  );
  const events = logLines(project, "abc123");
  assert.equal(events.length, 2);
  assert.equal(events[0].tool, "Bash");
  assert.equal(events[1].tool, "Read");
});

test("postToolUse records subagent fields", () => {
  const project = tmp();
  postToolUse(
    {
      session_id: "abc123",
      cwd: project,
      tool_name: "Read",
      agent_id: "agent_1",
      agent_type: "general-purpose",
    },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  const event = logLines(project, "abc123")[0];
  assert.equal(event.agent_id, "agent_1");
  assert.equal(event.agent_type, "general-purpose");
});

test("postToolUse missing session id is a silent no-op", () => {
  const project = tmp();
  postToolUse(
    { tool_name: "Bash", cwd: project },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  assert.ok(
    !fs.existsSync(sessionsDirFor(project)),
    "sessions dir was created; want no log written",
  );
});

// --- The payload cwd follows the session, so it is not the root -------------

test("postToolUse ignores the payload cwd (#485)", () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });

  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    env({ CLAUDE_PROJECT_DIR: project }),
  );

  assert.equal(logLines(project, "abc123").length, 1);
  assert.ok(
    !fs.existsSync(path.join(contentDir, ".claude")),
    "session state was scattered into a content directory",
  );
});

test("postToolUse walks up from the payload cwd when the env var is unset", () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });

  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    env({}),
  );

  assert.equal(logLines(project, "abc123").length, 1);
  assert.ok(!fs.existsSync(path.join(contentDir, ".claude")));
});

test("postToolUse writes nothing when no project is identifiable (#485)", () => {
  const { home, project, contentDir } = freshProject();
  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    env({ HOME: home }),
  );
  assert.ok(
    !fs.existsSync(path.join(project, ".claude")),
    "a state tree was created in a directory that is not a project root",
  );
});

test("sessionStart and postToolUse agree on one directory (#485)", () => {
  const { home, project, contentDir } = freshProject();
  const lookupEnv = env({ HOME: home });

  sessionStart(
    { session_id: "abc123", transcript_path: "/x/abc123.jsonl", cwd: project },
    lookupEnv,
  );
  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    lookupEnv,
  );

  const dir = sessionsDirFor(project);
  assert.equal(readTranscriptPath("abc123", dir), "/x/abc123.jsonl");
  assert.equal(
    fs.readFileSync(path.join(dir, "abc123-tool-calls.jsonl"), "utf8").trim()
      .length > 0,
    true,
  );
  assert.deepEqual(fs.readdirSync(path.dirname(contentDir)), ["concepts"]);
});

// --- runHook: the one fail-open wrapper both events go through --------------

/** The trace lines recorded for sessionID under `project`. */
function traceEntries(project: string, sessionID: string): TraceEntry[] {
  return readHookErrors(sessionID, sessionsDirFor(project));
}

test("runHook records an unparsable payload against the exported session id", () => {
  const project = tmp();
  const lookupEnv = env({
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: "sess-env",
  });

  assert.doesNotThrow(() =>
    runHook("session-start", () => "not json", lookupEnv),
  );

  const entries = traceEntries(project, "sess-env");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "session-start");
  assert.match(entries[0].error, /JSON/);
});

test("runHook leaves an unattributable failure in one session-less trace", () => {
  const project = tmp();
  runHook(
    "post-tool-use",
    () => "not json",
    env({ CLAUDE_PROJECT_DIR: project }),
  );

  const entries = traceEntries(project, "");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "post-tool-use");
});

test("runHook records a session-start handler throw, naming event and cause", () => {
  const project = tmp();
  // A directory where the transcript record belongs: the handler's write fails
  // while the trace's own file stays writable.
  fs.mkdirSync(path.join(sessionsDirFor(project), "sess-1.json"), {
    recursive: true,
  });
  // The payload's session_id outranks the exported one.
  const lookupEnv = env({
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: "sess-env",
  });

  runHook(
    "session-start",
    () =>
      JSON.stringify({
        session_id: "sess-1",
        transcript_path: "/x/t.jsonl",
        cwd: project,
      }),
    lookupEnv,
  );

  assert.deepEqual(traceEntries(project, "sess-env"), []);
  const entries = traceEntries(project, "sess-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "session-start");
  assert.match(entries[0].error, /EISDIR|illegal operation|is a directory/i);
});

test("runHook records a post-tool-use handler throw the same way", () => {
  const project = tmp();
  fs.mkdirSync(path.join(sessionsDirFor(project), "sess-2-tool-calls.jsonl"), {
    recursive: true,
  });

  runHook(
    "post-tool-use",
    () =>
      JSON.stringify({ session_id: "sess-2", cwd: project, tool_name: "Bash" }),
    env({ CLAUDE_PROJECT_DIR: project }),
  );

  const entries = traceEntries(project, "sess-2");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "post-tool-use");
  assert.match(entries[0].error, /EISDIR|illegal operation|is a directory/i);
});

test("runHook appends repeated failures rather than overwriting", () => {
  const project = tmp();
  const lookupEnv = env({
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: "sess-3",
  });

  runHook("session-start", () => "not json", lookupEnv);
  runHook("post-tool-use", () => "still not json", lookupEnv);

  const entries = traceEntries(project, "sess-3");
  assert.deepEqual(
    entries.map((entry) => entry.event),
    ["session-start", "post-tool-use"],
  );
});

test("runHook writes no trace when the state directory cannot be written", () => {
  // The trace's own directory is what failed, so there is nowhere to record
  // it; the hook still fails open.
  const home = tmp();
  const project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, ".claude"), "a file, not a directory");
  const lookupEnv = env({ HOME: home });

  assert.doesNotThrow(() =>
    runHook(
      "session-start",
      () =>
        JSON.stringify({
          session_id: "sess-4",
          transcript_path: "/x/t.jsonl",
          cwd: project,
        }),
      lookupEnv,
    ),
  );

  assert.ok(!fs.existsSync(sessionsDirFor(project)));
});

test("runHook dispatches a good payload and leaves no trace", () => {
  const project = tmp();
  const lookupEnv = env({ CLAUDE_PROJECT_DIR: project });

  runHook(
    "session-start",
    () =>
      JSON.stringify({
        session_id: "sess-5",
        transcript_path: "/x/t.jsonl",
        cwd: project,
      }),
    lookupEnv,
  );
  runHook(
    "post-tool-use",
    () =>
      JSON.stringify({ session_id: "sess-5", cwd: project, tool_name: "Bash" }),
    lookupEnv,
  );

  const dir = sessionsDirFor(project);
  assert.equal(readTranscriptPath("sess-5", dir), "/x/t.jsonl");
  assert.equal(
    fs.readFileSync(path.join(dir, "sess-5-tool-calls.jsonl"), "utf8").trim()
      .length > 0,
    true,
  );
  assert.deepEqual(traceEntries(project, "sess-5"), []);
});
