/**
 * Where a session's state lives, and the per-session_id records in it.
 *
 * `findSessionsDir`/`sessionsDir` own the one rule for locating that directory;
 * every writer and reader goes through it so they cannot disagree (#485).
 *
 * The `SessionStart` hook writes a session's transcript_path; the
 * save-conversation skill reads by `$CLAUDE_CODE_SESSION_ID`, so it never
 * guesses which concurrently running session is "current". State lives under
 * the *project's* `.claude/wiki-knowledge/sessions/` (gitignored), not the
 * vault — in query-from-anywhere mode the vault is somewhere else entirely.
 * One JSON file per session_id, so parallel sessions sharing a project don't
 * clobber each other.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";

/** A lookupEnv matching `process.env`'s semantics: (value, wasPresent). */
export type LookupEnv = (key: string) => [string | undefined, boolean];

/** Node's process.env, as a [value, present] pair. */
export function processLookupEnv(key: string): [string | undefined, boolean] {
  const value = process.env[key];
  return [value, value !== undefined];
}

/**
 * The sessions directory of the project cwd belongs to, or undefined when
 * nothing identifies one.
 *
 * Resolution order, highest priority first:
 *
 *  1. `$CLAUDE_PROJECT_DIR` — the project root the session started in, exported
 *     to every hook process. It is bound at session start, so unlike the
 *     payload's cwd it does not move when Claude runs `cd` or enters a
 *     worktree; every hook in a session reads the same answer.
 *  2. The nearest ancestor of cwd containing `.claude/` — writer and reader
 *     must agree on a root even when cwd is a subdirectory.
 *
 * There is deliberately no cwd fallback: an unresolvable root means the caller
 * is not inside a project, and a caller that writes anyway creates a state tree
 * wherever it happened to be standing (#485). Writes go through here; the
 * always-answers form below is for readers and for the session-start hook,
 * whose cwd is the project root by definition.
 *
 * A session-start-resolved directory cached for PostToolUse to reuse was
 * considered and rejected (#485): it would need a store outside the project,
 * findable without already knowing the project root, with its own staleness and
 * unwritable-home failure modes — to reconstruct what the host already hands
 * every hook process in rule 1.
 */
export function findSessionsDir(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): string | undefined {
  const [projectDir, ok] = lookupEnv("CLAUDE_PROJECT_DIR");
  if (ok && projectDir) return sessionsUnder(projectDir);
  const ancestor = dotClaudeAncestor(cwd, lookupEnv);
  return ancestor === undefined ? undefined : sessionsUnder(ancestor);
}

/**
 * The sessions directory for this project, falling back to a cwd-relative path
 * when no project is identifiable, so a path is always returned. It may not
 * exist yet.
 */
export function sessionsDir(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): string {
  return findSessionsDir(cwd, lookupEnv) ?? sessionsUnder(startDir(cwd));
}

function sessionsUnder(base: string): string {
  return path.join(base, ".claude", "wiki-knowledge", "sessions");
}

/** An empty cwd means "here": the process's own directory. */
function startDir(cwd: string): string {
  return cwd === "" ? process.cwd() : cwd;
}

/**
 * The nearest ancestor of cwd — cwd included — holding a `.claude/` directory,
 * or undefined when there is none.
 *
 * The walk stops at the user's home directory rather than passing through it:
 * `~/.claude` is Claude Code's *global config*, not a marker for a project, so
 * a tool call that ran under $HOME but outside any project would otherwise
 * resolve there and write plugin state into the global config (#485). A project
 * under $HOME is unaffected — its own `.claude/` is reached first.
 */
function dotClaudeAncestor(
  cwd: string,
  lookupEnv: LookupEnv,
): string | undefined {
  let dir = startDir(cwd);
  for (;;) {
    if (isHomeDir(dir, lookupEnv)) return undefined;
    try {
      if (fs.statSync(path.join(dir, ".claude")).isDirectory()) return dir;
    } catch {
      // not present — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether dir is the user's home directory. $HOME is consulted first, so
 * tests can place the boundary; `os.homedir()` is the fallback. */
function isHomeDir(dir: string, lookupEnv: LookupEnv): boolean {
  const [home, ok] = lookupEnv("HOME");
  const homeDir = ok && home ? home : os.homedir();
  return homeDir !== "" && path.resolve(dir) === path.resolve(homeDir);
}

function statePath(sessionID: string, stateDir: string): string {
  return path.join(stateDir, `${sessionID}.json`);
}

/** Records transcriptPath for sessionID, creating the state directory as needed. */
export function writeTranscriptPath(
  sessionID: string,
  transcriptPath: string,
  stateDir: string,
): void {
  const file = statePath(sessionID, stateDir);
  mkdirSafe(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ transcript_path: transcriptPath }), {
    mode: 0o644,
  });
}

/**
 * The recorded transcript path for sessionID, or undefined when no state
 * exists or it is unparsable.
 */
export function readTranscriptPath(
  sessionID: string,
  stateDir: string,
): string | undefined {
  let data: string;
  try {
    data = fs.readFileSync(statePath(sessionID, stateDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    const transcriptPath = payload["transcript_path"];
    return typeof transcriptPath === "string" ? transcriptPath : undefined;
  } catch {
    return undefined;
  }
}
