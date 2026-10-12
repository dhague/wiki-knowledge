/**
 * The plugin's automatic hook handlers: each reads a Claude Code hook payload as
 * JSON on stdin and writes per-session state under the project's
 * `.claude/wiki-knowledge/sessions/`.
 *
 * Hooks run automatically and unattended and must fail open: `runHook` swallows
 * every failure, recording it in the session's diagnostic trace instead of
 * reporting it, and hooks.json tolerates even the bootstrap failing, so a failure
 * costs one session's side effect rather than blocking the session.
 *
 * The two hooks locate the project differently on purpose. The payload's `cwd` is
 * the project root at SessionStart but has followed the session's `cd`s by
 * PostToolUse, so only SessionStart treats it as the root; PostToolUse resolves
 * through `findSessionsDir` and writes nothing when it cannot.
 */

import fs from "node:fs";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";
import {
  appendHookError,
  findSessionsDir,
  processLookupEnv,
  sessionsDir,
  writeTranscriptPath,
} from "./sessionstate.js";
import type { LookupEnv } from "./sessionstate.js";
import { logPath } from "./toolcallstats.js";

interface SessionStartPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/** Records transcript_path by session_id; a payload missing either field is a
 * silent no-op. */
export function sessionStart(
  payload: unknown,
  lookupEnv: LookupEnv = processLookupEnv,
): void {
  const p = (payload ?? {}) as SessionStartPayload;
  if (!p.session_id || !p.transcript_path) return;
  // Here the payload cwd is the project root, so sessionsDir's fallback is right.
  writeTranscriptPath(
    p.session_id,
    p.transcript_path,
    sessionsDir(p.cwd ?? "", lookupEnv),
  );
}

interface PostToolUsePayload {
  session_id?: string;
  cwd?: string;
  tool_name?: unknown;
  tool_use_id?: unknown;
  prompt_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  duration_ms?: unknown;
}

/** One line of the tool-call log; `unknown` fields log an absent key as an
 * explicit null, keeping the key set stable for toolcallstats. */
interface LoggedCall {
  tool: unknown;
  tool_use_id: unknown;
  prompt_id: unknown;
  agent_id: unknown;
  agent_type: unknown;
  duration_ms: unknown;
}

/** Appends one JSON line per tool call to the session's log, for
 * `enchiridion tool-call-stats`; the payload carries no timestamp, so tool-call
 * count is the recoverable metric. */
export function postToolUse(
  payload: unknown,
  lookupEnv: LookupEnv = processLookupEnv,
): void {
  const p = (payload ?? {}) as PostToolUsePayload;
  if (!p.session_id) return;

  const stateDir = findSessionsDir(p.cwd ?? "", lookupEnv);
  if (stateDir === undefined) return;

  const line = JSON.stringify({
    tool: p.tool_name ?? null,
    tool_use_id: p.tool_use_id ?? null,
    prompt_id: p.prompt_id ?? null,
    agent_id: p.agent_id ?? null,
    agent_type: p.agent_type ?? null,
    duration_ms: p.duration_ms ?? null,
  } satisfies LoggedCall);

  const logFile = logPath(p.session_id, stateDir);
  mkdirSafe(path.dirname(logFile), 0o755);
  fs.appendFileSync(logFile, line + "\n", { mode: 0o644 });
}

/** The events `hook` dispatches, in the order the help lists them; each also
 * names its own trace lines. */
export const HOOK_EVENTS = ["session-start", "post-tool-use"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Runs one hook event and fails open: a payload that will not parse, or a
 * handler that throws, appends a line to the session's diagnostic trace and
 * returns. Nothing reaches stderr and no exit code changes.
 */
export function runHook(
  event: HookEvent,
  readInput: () => string,
  lookupEnv: LookupEnv = processLookupEnv,
): void {
  let sessionID = "";
  let cwd = "";
  try {
    const payload: unknown = JSON.parse(readInput());
    sessionID = payloadField(payload, "session_id");
    cwd = payloadField(payload, "cwd");
    if (event === "session-start") sessionStart(payload, lookupEnv);
    else postToolUse(payload, lookupEnv);
  } catch (err) {
    if (sessionID === "") sessionID = envSessionID(lookupEnv);
    recordHookFailure(event, sessionID, cwd, err, lookupEnv);
  }
}

/** A string field of a parsed payload; an absent or non-string one reads as
 * empty, as the handlers' own casts do. */
function payloadField(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null) return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** The session the host exports to every subprocess it spawns. Claude Code keeps
 * it equal to the payload's session_id, and it is all an unparsable payload
 * leaves behind. */
function envSessionID(lookupEnv: LookupEnv): string {
  return lookupEnv("CLAUDE_CODE_SESSION_ID")[0] ?? "";
}

/** Appends the failure to the session's trace. An unwritable state directory
 * stays silent: the trace has nowhere to live then, so there is no second place
 * to record it. */
function recordHookFailure(
  event: HookEvent,
  sessionID: string,
  cwd: string,
  err: unknown,
  lookupEnv: LookupEnv,
): void {
  // sessionsDir, not findSessionsDir: a failed session-start handler was writing
  // to the fallback path too, and findTranscriptPath reads that path back.
  const stateDir = sessionsDir(cwd, lookupEnv);
  const error = err instanceof Error ? err.message : String(err);
  try {
    appendHookError(sessionID, stateDir, event, error);
  } catch {
    // The trace cannot be written either; fail open regardless.
  }
}
