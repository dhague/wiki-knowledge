/**
 * Turns a host session transcript into a vault-ready raw markdown file for
 * /save-conversation. Fetching the transcript is the single host-specific seam
 * (one adapter per host: Claude Code JSONL, OpenCode export); everything
 * downstream is shared.
 *
 * The name binds once, at first save: a re-save rewrites the existing file in
 * place rather than renaming, so inbound raw_source links never break.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdirSafe } from "./fsutil.js";
import os from "node:os";
import {
  sessionsDir,
  readTranscriptPath,
  processLookupEnv,
  findProjectSessionsDir,
} from "./sessionstate.js";
import type { HostLayout, LookupEnv } from "./sessionstate.js";

export const SLUG_MAX_LENGTH = 60;

const NON_SLUG_RE = /[^a-z0-9]+/g;

/**
 * Reduces a model-authored free-text phrase to a filesystem-safe kebab-case slug,
 * so it never needs percent-encoding in a link destination. Returns "" when
 * nothing survives, and the caller falls back to the bare `<date>-<short_id>`
 * name.
 */
export function sanitizeSlug(phrase: string, maxLength: number): string {
  const cap = maxLength <= 0 ? SLUG_MAX_LENGTH : maxLength;
  if (phrase === "") return "";

  const folded = phrase.normalize("NFKD");
  let ascii = "";
  for (const ch of folded) {
    if (ch.codePointAt(0)! < 128) ascii += ch;
  }
  const slug = ascii
    .toLowerCase()
    .replace(NON_SLUG_RE, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= cap) return slug;

  // Look one character past the cap: a separator there means the word before it
  // is whole; otherwise fall back to the last boundary inside the window, and to
  // a hard truncation when there is none.
  const window = slug.slice(0, cap + 1);
  let head = "";
  const idx = window.lastIndexOf("-");
  if (idx >= 0) head = window.slice(0, idx);
  if (head === "") head = slug.slice(0, cap);
  return head.replace(/^-+|-+$/g, "");
}

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

/** Two content shapes: a plain string, or a list of blocks of which only `text`
 * blocks count. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const m = block as Record<string, unknown>;
      if (m["type"] !== "text") continue;
      const text = typeof m["text"] === "string" ? m["text"].trim() : "";
      if (text !== "") parts.push(text);
    }
    return parts.join("\n\n");
  }
  return "";
}

/** One (role, text) exchange; the domain shape every host adapter reduces to. */
export interface Turn {
  role: string;
  text: string;
}

/** The Claude Code host adapter: JSONL to (role, text) turns. Only
 * user/assistant messages and `text` blocks count; a garbled line is skipped
 * rather than fatal, so an interrupted transcript still parses as far as it got. */
export function parseClaudeTranscript(jsonlLines: string[]): Turn[] {
  const turns: Turn[] = [];
  for (const rawLine of jsonlLines) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isMeta || entry.isSidechain) continue;
    const text = extractText(entry.message?.content);
    if (text !== "") {
      turns.push({ role: entry.message!.role!, text });
    }
  }
  return turns;
}

/** The too-short-transcript failure; the CLI prints it as a user-facing exit. */
export class ErrTooFewTurns extends Error {
  turns: number;
  minTurns: number;
  constructor(turns: number, minTurns: number) {
    super(
      `Transcript has ${turns} non-empty turn(s); need at least ${minTurns}.`,
    );
    this.turns = turns;
    this.minTurns = minTurns;
  }
}

/**
 * Renders turns into a vault-ready page; returns [filename, markdown]. Pure: no
 * I/O, env or filesystem. hostLabel is the `**Source:**` attribution; slug is
 * sanitized here, and one that sanitizes to nothing degrades to the bare
 * `<date>-<short_id>` name.
 */
export function transcriptToPage(
  turns: Turn[],
  hostLabel: string,
  sessionID: string,
  now: Date,
  slug: string,
  userLabel: string,
  assistantLabel: string,
  minTurns: number,
): [string, string] {
  if (turns.length < minTurns) {
    throw new ErrTooFewTurns(turns.length, minTurns);
  }

  // Short id goes last so a re-save can find the bound file with one
  // '*-<short_id>.md' glob, slug present or not.
  const shortID = sessionID.split("-")[0];
  const safeSlug = sanitizeSlug(slug, SLUG_MAX_LENGTH);
  const middle = safeSlug !== "" ? `${safeSlug}-` : "";
  const filename =
    fmtDate(now, "YYYY-MM-DD-hhmm") + "-" + middle + shortID + ".md";

  const lines: string[] = [
    `# Session ${sessionID}`,
    "",
    `**Saved:** ${fmtDate(now, "YYYY-MM-DD hh:mm")}  `,
    `**Source:** ${hostLabel} session transcript (save-conversation skill, enchiridion repo)`,
    "",
    "---",
    "",
  ];
  for (const t of turns) {
    const label = t.role === "user" ? userLabel : assistantLabel;
    lines.push(`## ${label}`, "", t.text, "");
  }

  return [filename, lines.join("\n")];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtDate(d: Date, template: string): string {
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    hh: pad(d.getHours()),
    mm: pad(d.getMinutes()),
  };
  return template.replace(/YYYY|MM|DD|hh|mm/g, (m) => map[m]);
}

/** A capture failure; its message is user-facing. */
export class CaptureError extends Error {
  constructor(msg: string, options?: { cause?: unknown }) {
    super(msg, options);
    this.name = "CaptureError";
  }
}

/** The transcript path for this session, or a CaptureError naming one of four
 * distinct failures: no session id, no state directory, no entry for the session,
 * or a recorded transcript that is gone. */
export function findTranscriptPath(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): string {
  const [sessionIDRaw, ok] = lookupEnv("CLAUDE_CODE_SESSION_ID");
  const sessionID = sessionIDRaw ?? "";
  if (!ok || sessionID === "") {
    throw new CaptureError(
      "$CLAUDE_CODE_SESSION_ID is not set in this environment.",
    );
  }

  const stateDir = sessionsDir(cwd, lookupEnv);
  let stateStat: fs.Stats;
  try {
    stateStat = fs.statSync(stateDir);
  } catch {
    throw stateDirNotLocated(cwd);
  }
  if (!stateStat.isDirectory()) {
    throw stateDirNotLocated(cwd);
  }

  const transcriptPath = readTranscriptPath(sessionID, stateDir);
  if (transcriptPath === undefined) {
    throw new CaptureError(
      "No state recorded for session " +
        sessionID +
        " under " +
        stateDir +
        ". (If this session was started before the " +
        "SessionStart hook was installed, its transcript was never " +
        "recorded; start a new session and try again.)",
    );
  }

  let trStat: fs.Stats;
  try {
    trStat = fs.statSync(transcriptPath);
  } catch {
    throw new CaptureError(
      "Recorded transcript file does not exist: " + transcriptPath,
    );
  }
  if (trStat.isDirectory()) {
    throw new CaptureError(
      "Recorded transcript file does not exist: " + transcriptPath,
    );
  }

  return transcriptPath;
}

function stateDirNotLocated(cwd: string): CaptureError {
  return new CaptureError(
    "Could not locate a session state directory. Searched " +
      "$CLAUDE_PROJECT_DIR, then walked up from " +
      cwd +
      " as far as the home directory for a '.claude/' ancestor, and did " +
      "not find one. (Has the " +
      "SessionStart hook ever run in this project? Start a new session " +
      "in the project root and try again.)",
  );
}

/** Injectable directory listing, so the readdir-failure paths are testable
 * without depending on filesystem permissions. */
export type DirLister = (dir: string) => string[];

/**
 * Writes the capture into `raw/conversations/`; returns its vault-relative path.
 * One file per session: an earlier capture found by `*-<short_id>.md` is reused
 * verbatim, so no raw file is ever renamed and inbound raw_source links stay
 * valid.
 */
export function writeCapture(
  wikiRoot: string,
  filename: string,
  markdown: string,
  shortID: string,
  listDir?: DirLister,
): string {
  const conversationsDir = path.join(wikiRoot, "raw", "conversations");
  mkdirSafe(conversationsDir);

  const list = listDir ?? ((dir: string) => fs.readdirSync(dir));
  let matches: string[] = [];
  try {
    matches = list(conversationsDir)
      .filter((f) => f.endsWith(`-${shortID}.md`))
      .sort();
  } catch (err) {
    // Only ENOENT means "no prior capture" (the directory is gone); any other
    // listing failure must refuse rather than write a second raw file and orphan
    // the first.
    if (!isENOENT(err)) {
      throw new CaptureError(
        `Could not list ${conversationsDir} to find an existing capture of ` +
          `this session: ${errMsg(err)}. (Refusing to guess which file a ` +
          `re-save should rewrite, because a failed listing read as "no ` +
          `prior capture" writes a second raw file instead, orphaning the ` +
          `first.)`,
        { cause: err },
      );
    }
  }
  let outPath = path.join(conversationsDir, filename);
  if (matches.length > 0) {
    outPath = path.join(conversationsDir, matches[0]);
  }

  fs.writeFileSync(outPath, markdown, { mode: 0o644 });

  return path.relative(wikiRoot, outPath).split(path.sep).join("/");
}

/**
 * Finds, renders and writes this session's transcript; returns its vault-relative
 * path. Raises CaptureError with a user-facing message on any failure.
 *
 * The host is detected here from which session-id variable the environment
 * carries, so everything downstream of the host-specific fetch is shared. Both
 * can be set at once; env cannot say which host is innermost, so OpenCode wins
 * only when its tracker recorded that session id in this project.
 */
export async function captureSession(
  wikiRoot: string,
  slug: string,
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
  now: Date,
  exportSeam?: Exporter,
): Promise<string> {
  const [claudeCodeID] = lookupEnv("CLAUDE_CODE_SESSION_ID");
  const [openCodeID] = lookupEnv("OPENCODE_SESSION_ID");
  if (openCodeID && !claudeCodeID) {
    return captureOpenCodeSession(wikiRoot, slug, lookupEnv, now, exportSeam);
  }
  if (openCodeID) {
    if (isOpenCodeSessionTracked(cwd, lookupEnv)) {
      return captureOpenCodeSession(wikiRoot, slug, lookupEnv, now, exportSeam);
    }
    return captureClaudeCodeSession(wikiRoot, slug, cwd, lookupEnv, now);
  }
  if (claudeCodeID) {
    return captureClaudeCodeSession(wikiRoot, slug, cwd, lookupEnv, now);
  }
  throw new CaptureError(
    "Neither $CLAUDE_CODE_SESSION_ID nor " +
      "$OPENCODE_SESSION_ID is set in this environment, so there is no way to " +
      "tell which session to save. (Claude Code sets the first; OpenCode's " +
      "session-tracker plugin injects the second.)",
  );
}

/** The Claude Code path: the recorded transcript file, no subprocess involved. */
function captureClaudeCodeSession(
  wikiRoot: string,
  slug: string,
  cwd: string,
  lookupEnv: LookupEnv,
  now: Date,
): string {
  const transcriptPath = findTranscriptPath(cwd, lookupEnv);
  const timestamp = now.getTime() === 0 ? new Date() : now;

  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch (err) {
    throw new CaptureError(`Could not read transcript: ${errMsg(err)}`);
  }

  const base = path.basename(transcriptPath);
  const ext = path.extname(transcriptPath);
  const sessionID = ext !== "" ? base.slice(0, -ext.length) : base;
  const turns = parseClaudeTranscript(text.split("\n"));
  let filename: string;
  let markdown: string;
  try {
    [filename, markdown] = transcriptToPage(
      turns,
      "Claude Code",
      sessionID,
      timestamp,
      slug,
      "User",
      "Claude",
      2,
    );
  } catch (err) {
    throw new CaptureError("Not enough conversation to save: " + errMsg(err));
  }

  const shortID = sessionID.split("-")[0];
  return writeCapture(wikiRoot, filename, markdown, shortID);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

// ---------------------------------------------------------------------------
// OpenCode host support
// ---------------------------------------------------------------------------

/** OpenCode's layout; it exports no project-root variable, so the shared rule's
 * env override is skipped. */
const OpenCode: HostLayout = {
  marker: ".opencode",
  projectDirEnv: "",
  stateDir: path.join(".opencode", "wiki-knowledge", "sessions"),
};

/** Where the session-tracker plugin writes this project's state, or undefined
 * with no project (sessionstate's one rule, OpenCode's layout). */
export function findOpenCodeSessionsDir(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): string | undefined {
  return findProjectSessionsDir(cwd, OpenCode, lookupEnv);
}

/** Whether `<id>.json` exists, parses, and names sessionID back; a corrupt file
 * counts as untracked. */
function openCodeSessionIsTracked(
  sessionID: string,
  stateDir: string,
): boolean {
  let data: string;
  try {
    data = fs.readFileSync(path.join(stateDir, `${sessionID}.json`), "utf8");
  } catch {
    return false;
  }
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    return payload["session_id"] === sessionID;
  } catch {
    return false;
  }
}

/** `$OPENCODE_SESSION_ID`, or a CaptureError. `opencode export` returns the
 * transcript whether or not the tracker recorded the session, so tracker state is
 * consulted only as tie-break evidence. */
export function openCodeSessionIDFromEnv(
  lookupEnv: LookupEnv = processLookupEnv,
): string {
  const [sessionIDRaw, ok] = lookupEnv("OPENCODE_SESSION_ID");
  const sessionID = sessionIDRaw ?? "";
  if (!ok || sessionID === "") {
    throw new CaptureError(
      "$OPENCODE_SESSION_ID is not set in this environment. (The " +
        "session-tracker plugin's shell.env hook injects it; is the plugin " +
        "installed and loaded in this project?)",
    );
  }
  return sessionID;
}

/** Whether the tracker recorded this session in this project — tie-break evidence
 * when both host ids are set, not a capture prerequisite. Never throws. */
export function isOpenCodeSessionTracked(
  cwd: string,
  lookupEnv: LookupEnv = processLookupEnv,
): boolean {
  const [sessionIDRaw, ok] = lookupEnv("OPENCODE_SESSION_ID");
  const sessionID = sessionIDRaw ?? "";
  if (!ok || sessionID === "") return false;

  const stateDir = findOpenCodeSessionsDir(cwd, lookupEnv);
  if (stateDir === undefined) return false;
  try {
    if (!fs.statSync(stateDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return openCodeSessionIsTracked(sessionID, stateDir);
}

/** Injectable export fetch, so the pipeline is testable without the `opencode`
 * CLI. */
export type Exporter = (sessionID: string) => Promise<Uint8Array>;

/**
 * Runs `<command> export <sessionID>` and returns its stdout; errors when the CLI
 * is absent from PATH or exits non-zero.
 *
 * `opencode export` truncates its JSON when stdout is a pipe, so stdout goes to a
 * real temp file and is read back from there.
 */
export async function exportTranscript(
  sessionID: string,
  command: string,
): Promise<Uint8Array> {
  let bin = command;
  if (bin === "") bin = "opencode";
  const resolved = findExecutable(bin);
  if (!resolved) {
    throw new CaptureError(`${bin} CLI is required but was not found on PATH`);
  }
  bin = resolved;

  const tmp = path.join(
    os.tmpdir(),
    `opencode-export-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.json`,
  );

  let stderr = "";
  try {
    await runExport(bin, sessionID, tmp, (chunk) => (stderr += chunk));
    return fs.readFileSync(tmp);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function runExport(
  bin: string,
  sessionID: string,
  tmpPath: string,
  onStderr: (chunk: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = fs.openSync(tmpPath, "w");
    } catch (err) {
      reject(
        new CaptureError(
          `Could not create a temp file for the export: ${errMsg(err)}`,
        ),
      );
      return;
    }
    let stderr = "";
    const child = spawn(bin, ["export", sessionID], {
      stdio: ["ignore", fd, "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onStderr(text);
    });
    child.on("error", (err) => {
      fs.closeSync(fd);
      reject(err);
    });
    child.on("close", (code, signal) => {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      if (code !== 0) {
        reject(
          new CaptureError(
            `opencode export failed (${code ?? signal}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

/** Minimal PATH lookup matching `exec.LookPath` semantics. */
function findExecutable(name: string): string | null {
  if (path.isAbsolute(name)) {
    return isExecutableFile(name) ? name : null;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * The OpenCode host adapter: an `opencode export` document to (role, text) turns.
 * The shape is `info` + `messages[{info:{role}, parts[{type:"text"}]}]`; only
 * user/assistant messages and `type: "text"` parts count. Malformed messages and
 * parts are skipped, and only a document that is not a JSON object is an error.
 */
export function normalizeExport(exportDoc: Uint8Array): Turn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(exportDoc));
  } catch {
    throw new CaptureError("opencode export returned invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CaptureError("opencode export returned an unexpected shape");
  }
  const document = parsed as Record<string, unknown>;

  // A wrong-shaped messages key reads as empty, like the per-message decode below.
  const rawMessages = document["messages"];
  const messages = Array.isArray(rawMessages) ? rawMessages : [];

  const turns: Turn[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = raw as Record<string, unknown>;
    const info = message["info"];
    const role =
      typeof info === "object" && info !== null
        ? (info as Record<string, unknown>)["role"]
        : undefined;
    if (role !== "user" && role !== "assistant") continue;
    const parts = message["parts"];
    const partList = Array.isArray(parts) ? parts : [];
    const texts: string[] = [];
    for (const rawPart of partList) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const part = rawPart as Record<string, unknown>;
      if (part["type"] !== "text") continue;
      const text = typeof part["text"] === "string" ? part["text"].trim() : "";
      if (text !== "") texts.push(text);
    }
    if (texts.length > 0) {
      turns.push({ role: role as string, text: texts.join("\n\n") });
    }
  }
  return turns;
}

/**
 * Resolves the OpenCode session, exports and normalizes its transcript, and
 * writes the capture; returns its vault-relative path. No tracker state or
 * project root is needed: the transcript comes from the host and the capture goes
 * into the vault.
 */
export async function captureOpenCodeSession(
  wikiRoot: string,
  slug: string,
  lookupEnv: LookupEnv,
  now: Date,
  exportSeam?: Exporter,
): Promise<string> {
  const sessionID = openCodeSessionIDFromEnv(lookupEnv);
  const timestamp = now.getTime() === 0 ? new Date() : now;
  const fetch =
    exportSeam ?? ((id: string) => exportTranscript(id, "opencode"));

  const document = await fetch(sessionID);
  const turns = normalizeExport(document);

  let filename: string;
  let markdown: string;
  try {
    [filename, markdown] = transcriptToPage(
      turns,
      "OpenCode",
      sessionID,
      timestamp,
      slug,
      "User",
      "Claude",
      2,
    );
  } catch (err) {
    throw new CaptureError("Not enough conversation to save: " + errMsg(err));
  }

  const shortID = sessionID.split("-")[0];
  return writeCapture(wikiRoot, filename, markdown, shortID);
}
