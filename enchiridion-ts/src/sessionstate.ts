/**
 * Where a session's state lives, and the per-session_id records in it.
 *
 * One rule locates a host's session-state directory, and every writer and reader
 * goes through it so they cannot disagree; each host supplies only its own layout
 * (HostLayout). State is one JSON file per session_id under the project's
 * `.claude/wiki-knowledge/sessions/`, not the vault — in query-from-anywhere mode
 * the vault is elsewhere.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";

/** A lookupEnv matching `process.env`'s semantics: (value, wasPresent). */
export type LookupEnv = (key: string) => [string | undefined, boolean];

export function processLookupEnv(key: string): [string | undefined, boolean] {
  const value = process.env[key];
  return [value, value !== undefined];
}

/** One host's session-state layout — the only things that differ between hosts. */
export interface HostLayout {
  /** The directory whose presence marks an ancestor as a project root for this
   * host: `.claude/`, `.opencode/`. */
  marker: string;
  /** The environment variable by which the host exports the project root, or
   * "" when it exports none. */
  projectDirEnv: string;
  /** Where under its project root this host keeps session state. */
  stateDir: string;
}

const ClaudeCode: HostLayout = {
  marker: ".claude",
  projectDirEnv: "CLAUDE_PROJECT_DIR",
  stateDir: path.join(".claude", "wiki-knowledge", "sessions"),
};

/**
 * The project root a host's session state belongs to, or undefined when nothing
 * identifies one — the one rule, for every host.
 *
 * Resolution order:
 *
 *  1. The host's own env override, when it exports one (`$CLAUDE_PROJECT_DIR`).
 *     It is bound at session start, so unlike the payload's cwd it does not move
 *     when a session `cd`s; every hook reads the same answer.
 *  2. The nearest ancestor of cwd — cwd included — holding the host's marker
 *     directory.
 *  3. Nothing. The walk stops at `$HOME` rather than passing through it, and
 *     there is deliberately no cwd fallback: a caller that writes anyway creates
 *     a state tree wherever it happened to be standing.
 *
 * The vault root resolves by a deliberately different order, ending in a cwd
 * fallback rather than a `$HOME` stop (ADR-0004, ADR-0025).
 */
export function findProjectRoot(
  cwd: string,
  layout: HostLayout,
  lookupEnv: LookupEnv,
): string | undefined {
  if (layout.projectDirEnv !== "") {
    const [projectDir, ok] = lookupEnv(layout.projectDirEnv);
    if (ok && projectDir) return projectDir;
  }
  return markerAncestor(cwd, layout.marker, lookupEnv);
}

/** Writer-facing: the project's sessions directory, or undefined with no project. */
export function findProjectSessionsDir(
  cwd: string,
  layout: HostLayout,
  lookupEnv: LookupEnv,
): string | undefined {
  const root = findProjectRoot(cwd, layout, lookupEnv);
  return root === undefined ? undefined : sessionsUnder(root, layout);
}

/** Reader-facing: as above, but falls back to a cwd-relative path so a path is
 * always returned. It may not exist yet. */
export function projectSessionsDir(
  cwd: string,
  layout: HostLayout,
  lookupEnv: LookupEnv,
): string {
  return (
    findProjectSessionsDir(cwd, layout, lookupEnv) ??
    sessionsUnder(startDir(cwd), layout)
  );
}

/** Claude Code's sessions directory, or undefined with no project. */
export function findSessionsDir(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): string | undefined {
  return findProjectSessionsDir(cwd, ClaudeCode, lookupEnv);
}

/** Claude Code's sessions directory; always returns a path, which may not exist yet. */
export function sessionsDir(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): string {
  return projectSessionsDir(cwd, ClaudeCode, lookupEnv);
}

function sessionsUnder(base: string, layout: HostLayout): string {
  return path.join(base, layout.stateDir);
}

/** An empty cwd means "here": the process's own directory. */
function startDir(cwd: string): string {
  return cwd === "" ? process.cwd() : cwd;
}

/**
 * The nearest ancestor of cwd — cwd included — holding a `marker` directory, or
 * undefined when there is none.
 *
 * The walk stops at `$HOME` rather than passing through it: `~/.claude` and
 * `~/.opencode` are a host's global configuration, not project markers. A project
 * under `$HOME` is unaffected — its own marker is reached first.
 */
function markerAncestor(
  cwd: string,
  marker: string,
  lookupEnv: LookupEnv,
): string | undefined {
  let dir = startDir(cwd);
  for (;;) {
    if (isHomeDir(dir, lookupEnv)) return undefined;
    try {
      if (fs.statSync(path.join(dir, marker)).isDirectory()) return dir;
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

/** The recorded transcript path for sessionID, or undefined when no state exists
 * or it is unparsable. */
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
