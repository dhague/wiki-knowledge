/**
 * The raw/ watcher — event-driven detection + debounce + queue.
 *
 * The `/wiki-watch` skill orchestrates; this is the half it launches in the
 * background and polls. Four pieces:
 *
 *   - [runWatch] — the long-lived loop that owns the watcher, the debouncer,
 *     the per-poll-tick sweep, and the queue, with the file-watcher, the
 *     sweep, and the clock injectable so the loop's timing is testable
 *     without chokidar, real signals, or real sleeps. The CLI shrinks to
 *     lock handling and one call to it.
 *   - [Debouncer] — per-file debounce, pure (injectable clock, no threads, no
 *     filesystem) so the timing is testable without real sleeps.
 *   - The lock file at `.wiki-knowledge/watch.lock` — one watcher per vault,
 *     with stale-lock recovery for a hard-killed predecessor.
 *   - The queue file at `.wiki-knowledge/watch-queue.jsonl` — one
 *     vault-relative path per line (despite the extension, not JSON). A
 *     wake-up signal and nothing more: SKILL.md re-checks the sweep when it
 *     needs the reason.
 *
 * Mutual exclusion over the lock/queue files uses an exclusive-create lock
 * file (`.mutex` / `.writelock` created with the `wx` flag, removed on
 * release). The module is pure-JS only (ADR-0017 — a native flock addon
 * would break Bun, the OpenCode runtime), and the atomic `wx` create gives
 * the same cross-process mutual exclusion a blocking flock provides. Both
 * consult one liveness rule ([lockState]) before they wait, so the two cannot
 * drift apart on what "nobody owns this" means, and differ only in what they
 * do with a lock that rule cannot call gone — the `.mutex` reclaims it, the
 * `.writelock` stops and says why (see [StalePolicy]).
 */

import fs from "node:fs";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";
import { watch as watchRaw } from "chokidar";
import { scan as scanEligible } from "./ingestscan.js";

/** The per-file settle window. */
export const DefaultDebounceSeconds = 30;

/** How long a live-PID lock is trusted before it counts as stale. */
export const StaleLockSeconds = 600;

/** How often the main loop checks for settled files. */
export const DefaultPollIntervalSeconds = 5;

/**
 * Debouncer tracks the most recent event time per vault-relative file path.
 * clock defaults to a monotonic seconds source, injectable so tests can drive
 * settling with fake timestamps.
 */
export class Debouncer {
  private lastEvent = new Map<string, number>();

  constructor(
    private readonly debounceSeconds: number,
    private readonly clock: () => number = defaultClock(),
  ) {}

  /** Notes an event for rel at the current clock time. */
  recordEvent(rel: string): void {
    this.lastEvent.set(rel, this.clock());
  }

  /** Returns, and stops tracking, every file whose debounce window has
   * elapsed. */
  settledFiles(): string[] {
    const now = this.clock();
    const settled: string[] = [];
    for (const [rel, last] of this.lastEvent) {
      if (now - last >= this.debounceSeconds) settled.push(rel);
    }
    for (const rel of settled) this.lastEvent.delete(rel);
    return settled;
  }

  /** Returns the recorded event time for rel, for tests that want to assert
   * what the handler recorded. */
  lastEventTime(rel: string): number | undefined {
    return this.lastEvent.get(rel);
  }
}

function defaultClock(): () => number {
  const start = Date.now();
  return () => (Date.now() - start) / 1000;
}

// --- lock file ---------------------------------------------------------------

/** Writes lockPath with the given (or current) PID and timestamp. */
export function writeLock(
  lockPath: string,
  pid: number,
  startedAt?: Date,
): void {
  mkdirSafe(path.dirname(lockPath), 0o755);
  if (!pid) pid = process.pid;
  const started = startedAt ? startedAt : new Date();
  fs.writeFileSync(lockPath, lockPayload(pid, started), { mode: 0o644 });
}

/** The payload a lock file carries: the holder's pid, and when it took the
 * lock. One shape for all three lock files — the watcher's own lock, and the
 * `.mutex`/`.writelock` companions — so [lockState] reads whichever it is
 * handed. */
function lockPayload(pid: number, startedAt: Date): string {
  return JSON.stringify({ pid, started_at: startedAt.toISOString() });
}

/** Unlinks lockPath; a no-op when absent. */
export function removeLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** True when a lock stamped at startedAtMs has outlived [StaleLockSeconds]. */
function pastStaleWindow(startedAtMs: number, now: Date): boolean {
  return (now.getTime() - startedAtMs) / 1000 > StaleLockSeconds;
}

/** What a lock file says about the process that owns it — the return of
 * [lockState], the module's one liveness rule. */
export type LockState =
  /** No lock file: nothing to wait for. */
  | { kind: "free" }
  /** A live holder stamped inside [StaleLockSeconds]: wait for it. pid is null
   * for a file caught between the exclusive create and the holder's stamp. */
  | { kind: "held"; pid: number | null }
  /** The holder is provably gone — its recorded pid is not alive. */
  | { kind: "dead"; pid: number }
  /** The holder's pid is alive, but its stamp has outlived [StaleLockSeconds]:
   * a real holder that may be stuck, which only a [StalePolicy] can price. */
  | { kind: "expired"; pid: number }
  /** The file exists but decides nothing: unreadable, stranded in the create
   * window, or not a lock payload. Also the policy's to answer. */
  | { kind: "unparsable" };

/**
 * The one liveness rule: what the lock file at lockPath says about its holder.
 * Every lock consults it before waiting, so none of them can drift on what
 * "nobody owns this" means.
 *
 * Four signals, in descending order of how much they prove: a pid that is not
 * alive (governed by either policy), a pid that is alive with a stamp inside
 * [StaleLockSeconds] (held), a pid that is alive with a stamp outside it
 * (expired), and a file that says nothing at all (unparsable).
 *
 * An empty file is not "says nothing" on the way in: the exclusive create
 * publishes the file a syscall before its holder can stamp it, so an empty
 * file is a holder mid-acquire while it is fresh — reading that as gone would
 * hand the lock to two processes at once. It is read off its own mtime instead,
 * and only counts as unparsable once that has aged out, so a file stranded in
 * the window still comes to a decision rather than waiting forever.
 */
export function lockState(
  lockPath: string,
  now: Date,
  pidAlive: (pid: number) => boolean,
): LockState {
  let info: fs.Stats;
  try {
    info = fs.statSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "free" };
    }
    return { kind: "unparsable" };
  }
  let data: string;
  try {
    data = fs.readFileSync(lockPath, "utf8");
  } catch {
    return { kind: "unparsable" };
  }
  if (data === "") {
    return pastStaleWindow(info.mtime.getTime(), now)
      ? { kind: "unparsable" }
      : { kind: "held", pid: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "unparsable" };
  }
  if (typeof raw !== "object" || raw === null) return { kind: "unparsable" };
  const payload = raw as { pid?: number; started_at?: string };
  const startedAt = Date.parse(payload.started_at ?? "");
  if (Number.isNaN(startedAt)) return { kind: "unparsable" };
  const pid = payload.pid ?? 0;
  if (!pidAlive(pid)) return { kind: "dead", pid };
  if (pastStaleWindow(startedAt, now)) return { kind: "expired", pid };
  return { kind: "held", pid };
}

/** Probes whether pid names a live process via `kill(pid, 0)`: ESRCH means
 * dead, EPERM means alive-but-not-ours. The production answer [lockState]
 * judges holders with, unless a caller injects its own. */
export function defaultPIDAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The wall clock staleness is judged at. Not [defaultClock] — that one is the
 * debouncer's monotonic seconds. */
function defaultNow(): Date {
  return new Date();
}

/** The seams a lock reads before it waits. Every field defaults to the
 * production implementation; tests inject fakes for all of them. */
export interface LockSeams {
  /** Current time, called once per attempt so a wait can outlive the moment it
   * began (default: the real clock). */
  clock?: () => Date;
  /** Probes whether a holder is alive (default: [defaultPIDAlive]). */
  pidAlive?: (pid: number) => boolean;
  /** Waits ms between attempts (default: [LockRetryMillis]). */
  sleep?: (ms: number) => void;
}

/** Resolves the seams a lock was handed, filling in the production defaults —
 * the one place the module says who answers "is that holder still there?". */
function lockDefaults(seams: LockSeams): Required<LockSeams> {
  return {
    clock: seams.clock ?? defaultNow,
    pidAlive: seams.pidAlive ?? defaultPIDAlive,
    sleep: seams.sleep ?? sleep,
  };
}

/**
 * Tries to acquire the watch lock. Returns { acquired, stalePID }.
 *
 * A live lock (PID alive, within [StaleLockSeconds]) means another watcher is
 * running: { acquired: false, stalePID: null }, lock untouched. A stale one is
 * removed and replaced; the removed lock's PID is returned (null when the lock
 * file was unparsable), so the caller can log the takeover. Check, unlink and
 * write all happen under a companion `.mutex` file held exclusively, so two
 * processes racing a stale takeover can't both pass the staleness check before
 * either writes — and that `.mutex` is reclaimed rather than stopped on, so a
 * watcher killed while holding it strands neither it nor its successor (see
 * [withExclusiveLock]).
 */
export function acquireLock(
  lockPath: string,
  seams: LockSeams = {},
): { acquired: boolean; stalePID: number | null } {
  const { clock, pidAlive } = lockDefaults(seams);
  const result: { acquired: boolean; stalePID: number | null } = {
    acquired: false,
    stalePID: null,
  };
  withExclusiveLock(
    lockPath + ".mutex",
    () => {
      const now = clock();
      const state = lockState(lockPath, now, pidAlive);
      if (state.kind === "held") {
        result.acquired = false;
        return;
      }
      if (state.kind !== "free") removeLock(lockPath);
      writeLock(lockPath, 0, now);
      result.acquired = true;
      result.stalePID =
        state.kind === "dead" || state.kind === "expired" ? state.pid : null;
    },
    "reclaim",
    seams,
  );
  return result;
}

// --- queue file --------------------------------------------------------------

/** Returns the queue's entries. An absent queue is empty.
 *
 * Split on "\n", never anything fancier — a path can legitimately contain
 * other control bytes. */
export function readQueue(queuePath: string): string[] {
  let data: string;
  try {
    data = fs.readFileSync(queuePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const line of data.split("\n")) {
    if (line !== "") out.push(line);
  }
  return out;
}

/**
 * Runs fn(currentLines) -> newLines under an exclusive lock.
 *
 * The lock serializes concurrent writers so a read-modify-write can't lose an
 * update; writing to a `.tmp` sibling and renaming means a concurrent reader
 * never sees a partial write. */
function withQueueLock(
  queuePath: string,
  fn: (lines: string[]) => string[],
): void {
  mkdirSafe(path.dirname(queuePath), 0o755);
  const writelockPath = queuePath + ".writelock";
  withExclusiveLock(
    writelockPath,
    () => {
      const newLines = fn(readQueue(queuePath));
      let body = "";
      for (const line of newLines) body += line + "\n";
      const tmpPath = queuePath + ".tmp";
      fs.writeFileSync(tmpPath, body, { mode: 0o644 });
      fs.renameSync(tmpPath, queuePath);
    },
    // "fail", never "reclaim": two writers each believing they hold the queue
    // corrupts it. See [StalePolicy].
    "fail",
  );
}

/** Appends rel to the queue, unless it's already there (idempotent). */
export function appendQueue(queuePath: string, rel: string): void {
  withQueueLock(queuePath, (lines) => {
    for (const line of lines) {
      if (line === rel) return lines;
    }
    return [...lines, rel];
  });
}

/** Removes every occurrence of rel from the queue. */
export function removeFromQueue(queuePath: string, rel: string): void {
  withQueueLock(queuePath, (lines) => lines.filter((l) => l !== rel));
}

// --- eligibility check on settle ----------------------------------------------

/** Enqueues settledRel iff it's in eligibleRels.
 *
 * A settled event doesn't mean "ingest this" — an `.ingestignore` match, or a
 * file whose back-pointer page is already current, settles too. eligibleRels
 * comes from one sweep per poll tick, not per file, so eligibility matches the
 * manual sweep exactly. */
export function checkAndEnqueue(
  eligibleRels: Set<string>,
  settledRel: string,
  queuePath: string,
): boolean {
  if (!eligibleRels.has(settledRel)) return false;
  appendQueue(queuePath, settledRel);
  return true;
}

// --- watch paths --------------------------------------------------------------

/** The set of files one watcher run touches. */
export interface Paths {
  root: string;
  lock: string;
  queue: string;
}

/** Returns the watch paths for a vault root. */
export function forRoot(root: string): Paths {
  const wk = path.join(root, ".wiki-knowledge");
  return {
    root,
    lock: path.join(wk, "watch.lock"),
    queue: path.join(wk, "watch-queue.jsonl"),
  };
}

/** Maps one filesystem event path to a vault-relative path, or null when the
 * event should be ignored: a directory, or a path outside root. */
export function relForEvent(root: string, abs: string): string | null {
  let info: fs.Stats;
  try {
    info = fs.statSync(abs);
  } catch {
    return null;
  }
  if (info.isDirectory()) return null;
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep)) return null;
  return toSlash(rel);
}

// --- exclusive-create lock file (ADR-0017: pure JS, no native addons) ---------

/** How long an exclusive lock waits between attempts. */
const LockRetryMillis = 5;

/**
 * What a lock does about a holder it cannot call gone: a file that says nothing
 * usable, or a pid that is alive but whose stamp has outlived
 * [StaleLockSeconds].
 *
 * Not a knob to set per call site on a whim — it is what the two locks
 * genuinely differ by. `.mutex` guards a check-then-write around the lock file,
 * so reclaiming matches the fail-toward-proceeding posture [acquireLock]
 * already takes toward a lock file it cannot parse. `.writelock` guards queue
 * integrity, where two writers each believing they hold it is worse than
 * stopping, so it stops and says what was wrong.
 *
 * A dead pid is provably gone, and is reclaimed under either policy.
 */
export type StalePolicy = "reclaim" | "fail";

/**
 * Runs critical under an exclusive lock on lockPath, created atomically with
 * the `wx` flag, stamped with its holder, and removed on release.
 *
 * Replaces a blocking flock: an atomic exclusive create gives the same
 * cross-process mutual exclusion without a native addon (ADR-0017). A holder
 * is waited out, but only for as long as [lockState] gives it credit: a lock
 * whose stamp has outlived [StaleLockSeconds] is not waited on forever — what
 * happens then is stalePolicy (see [StalePolicy]), so a `.mutex` stranded by a
 * killed process is taken over rather than spun on, and the spin is bounded in
 * either case.
 *
 * Reclaiming unlinks and retries the exclusive create in this same loop: no
 * recursion, and nothing half-made, since either the one `wx` call took the
 * lock or it never existed.
 */
export function withExclusiveLock(
  lockPath: string,
  critical: () => void,
  stalePolicy: StalePolicy,
  seams: LockSeams = {},
): void {
  const { clock, pidAlive, sleep: wait } = lockDefaults(seams);
  mkdirSafe(path.dirname(lockPath), 0o755);
  let fd: number;
  for (;;) {
    try {
      fd = createLockFile(lockPath, clock());
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const state = lockState(lockPath, clock(), pidAlive);
    if (state.kind === "held") {
      wait(LockRetryMillis);
      continue;
    }
    if (state.kind === "free") continue; // released between the two calls
    if (state.kind !== "dead" && stalePolicy === "fail") {
      throw lockStuckError(lockPath, state);
    }
    removeLock(lockPath);
  }
  let criticalErr: unknown = null;
  try {
    critical();
  } catch (err) {
    criticalErr = err;
  } finally {
    fs.closeSync(fd);
    try {
      removeLock(lockPath);
    } catch (err) {
      if (criticalErr === null) criticalErr = err;
    }
  }
  if (criticalErr !== null) throw criticalErr;
}

/** Creates lockPath exclusively and stamps its holder into it, returning the
 * open fd; throws the EEXIST of an already-held lock.
 *
 * The exclusive create *is* the mutual exclusion; the stamp is what [lockState]
 * reads later to tell a live holder from a stranded one. They are two calls, so
 * for the width of one syscall a holder is visible as an empty file — which
 * [lockState] reads as held, never as gone. */
function createLockFile(lockPath: string, now: Date): number {
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeSync(fd, lockPayload(process.pid, now));
  } catch (err) {
    // A lock file that says nothing is worse than none: drop what we made.
    fs.closeSync(fd);
    removeLock(lockPath);
    throw err;
  }
  return fd;
}

/** The error a `"fail"` lock stops with: which lock, and what [lockState] found
 * wrong with it, so a person can act — these files sit in a vault's
 * `.wiki-knowledge/`, which is not somewhere anyone thinks to look. */
function lockStuckError(lockPath: string, state: LockState): Error {
  if (state.kind === "unparsable") {
    return new Error(
      `lock ${lockPath} says nothing about its holder (unreadable, or not a ` +
        `lock payload); if no other process is writing to this vault, remove it`,
    );
  }
  const pid = state.kind === "expired" ? ` by pid ${state.pid}` : "";
  return new Error(
    `lock ${lockPath} is held${pid}, that pid is still alive, and the lock ` +
      `has outlived ${StaleLockSeconds}s; if that process is no longer ` +
      `writing to this vault, remove it`,
  );
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function toSlash(p: string): string {
  return p.split(path.sep).join("/");
}

// --- the watch loop -----------------------------------------------------------

/** The minimal file-watcher surface [runWatch] drives. Chokidar's FSWatcher
 * satisfies it structurally. */
export interface Watcher {
  /** Registers a filesystem-event handler. The loop consumes only the "all"
   * event, keyed by (eventName, path). */
  on(event: "all", cb: (eventName: string, p: string) => void): void;
  /** Registers the log-and-keep-watching error handler. */
  on(event: "error", cb: (err: unknown) => void): void;
  /** Registers the ready handler, which fires the "watching …" banner. */
  on(event: "ready", cb: () => void): void;
  /** Stops watching; resolves once fully closed. */
  close(): Promise<void>;
}

/** One eligibility sweep, run per poll tick when files have settled. Returns
 * the vault-relative paths the sweep offers. */
export type Sweep = () => Promise<Set<string>>;

/** Schedules `tick` every `ms`; the returned function cancels it. The default
 * uses setInterval/clearInterval; tests inject a scheduler that stores the
 * tick for manual driving, so no real sleeps are needed. */
export type Scheduler = (tick: () => void, ms: number) => () => void;

/** The signals a watch run stops on. SIGINT and SIGTERM are what a person
 * sends the foreground command; SIGHUP is what closing the terminal sends, and
 * unhandled it kills the process wherever it stands — mid critical section,
 * stranding a `.mutex` for the next watcher. */
export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** Every [StopSignal], so the loop registers and drops them in one pass. */
const StopSignals: StopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The injectable seams [runWatch] composes. Every field defaults to the
 * production implementation; tests inject fakes for all of them. */
export interface WatchOptions {
  /** Per-file settle window, seconds (default [DefaultDebounceSeconds]). */
  debounceSeconds?: number;
  /** How often to check for settled files, seconds (default
   * [DefaultPollIntervalSeconds]). */
  pollIntervalSeconds?: number;
  /** Creates the file watcher over the raw/ root (default: chokidar). */
  makeWatcher?: (rawRoot: string) => Watcher;
  /** One eligibility sweep per poll tick (default: the real ingest-scan over
   * paths.root, matching the manual sweep exactly). */
  sweep?: Sweep;
  /** Monotonic-seconds clock for the debouncer (default: real time). */
  clock?: () => number;
  /** Registers a stop-signal handler, one per [StopSignal] (default:
   * process.on). */
  onSignal?: (signal: StopSignal, cb: () => void) => void;
  /** Removes a stop-signal handler (default: process.removeListener). */
  offSignal?: (signal: StopSignal, cb: () => void) => void;
  /** Schedules the per-poll-tick sweep (default: setInterval). */
  schedule?: Scheduler;
  /** The pid printed in the "watching …" banner (default: process.pid). */
  pid?: number;
  /** Emits the loop's user-facing lines (default: console.log). */
  log?: (line: string) => void;
}

/**
 * runWatch runs the long-lived watch loop: a file watcher over root/raw/
 * records events into the debouncer; on each poll tick settled files are
 * swept for eligibility and enqueued. Any [StopSignal] — SIGINT and SIGTERM
 * from a person, SIGHUP from a closing terminal — logs "watcher stopped",
 * cancels the poll, closes the watcher, removes the lock, and resolves the
 * returned promise.
 *
 * Creates root/raw/ if missing. The watcher, sweep, clock, signal handling,
 * scheduler, and log are injectable, so the loop is testable with no
 * chokidar, no real signals, and no real sleeps.
 */
export function runWatch(
  paths: Paths,
  options: WatchOptions = {},
): Promise<void> {
  const debounceSeconds = options.debounceSeconds ?? DefaultDebounceSeconds;
  const pollIntervalSeconds =
    options.pollIntervalSeconds ?? DefaultPollIntervalSeconds;
  const rawRoot = path.join(paths.root, "raw");
  mkdirSafe(rawRoot, 0o755);

  const watcher = (options.makeWatcher ?? defaultWatcher)(rawRoot);
  const debouncer = new Debouncer(
    debounceSeconds,
    options.clock ?? defaultClock(),
  );
  const sweep = options.sweep ?? defaultSweep(paths.root);
  const schedule = options.schedule ?? defaultSchedule;
  const onSignal = options.onSignal ?? defaultOnSignal;
  const offSignal = options.offSignal ?? defaultOffSignal;
  const log = options.log ?? console.log;
  const pid = options.pid ?? process.pid;

  return new Promise<void>((resolve) => {
    let cancel = (): void => {};
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      log("watcher stopped");
      cancel();
      for (const signal of StopSignals) offSignal(signal, stop);
      void watcher.close();
      removeLock(paths.lock);
      resolve();
    };
    for (const signal of StopSignals) onSignal(signal, stop);

    watcher.on("all", (_eventName: string, p: string) => {
      const rel = relForEvent(paths.root, p);
      if (rel !== null) debouncer.recordEvent(rel);
    });
    watcher.on("error", (_err: unknown) => {
      // Log-and-keep-watching; a transient read error isn't fatal.
    });
    watcher.on("ready", () => {
      log(`watching ${rawRoot} (debounce=${debounceSeconds}s, pid=${pid})`);
    });

    cancel = schedule(() => {
      const settled = debouncer.settledFiles();
      if (settled.length === 0) return;
      sweep()
        .then((eligible) => {
          for (const rel of settled) {
            const queued = checkAndEnqueue(eligible, rel, paths.queue);
            if (queued) log(`queued ${rel}`);
          }
        })
        .catch((err) => {
          log(`error scanning raw/: ${(err as Error).message}`);
        });
    }, pollIntervalSeconds * 1000);
  });
}

function defaultWatcher(rawRoot: string): Watcher {
  return watchRaw(rawRoot, { ignoreInitial: true });
}

function defaultSweep(root: string): Sweep {
  return async (): Promise<Set<string>> => {
    const result = await scanEligible(root, "", null);
    return new Set(result.eligible.map((c) => c.rawRel));
  };
}

function defaultSchedule(tick: () => void, ms: number): () => void {
  const id = setInterval(tick, ms);
  return () => clearInterval(id);
}

function defaultOnSignal(signal: StopSignal, cb: () => void): void {
  process.on(signal, cb);
}

function defaultOffSignal(signal: StopSignal, cb: () => void): void {
  process.removeListener(signal, cb);
}
