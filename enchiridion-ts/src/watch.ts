/**
 * The raw/ watcher — event-driven detection, per-file debounce, and a queue.
 * [runWatch] is the long-lived loop `/wiki-watch` launches and polls; one
 * watcher per vault, guarded by a lock file. The queue is one vault-relative
 * path per line (the `.jsonl` extension is a misnomer).
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

/** Tracks the most recent event time per vault-relative path. `clock` is
 * injectable so tests can drive settling. */
export class Debouncer {
  private lastEvent = new Map<string, number>();

  constructor(
    private readonly debounceSeconds: number,
    private readonly clock: () => number = defaultClock(),
  ) {}

  recordEvent(rel: string): void {
    this.lastEvent.set(rel, this.clock());
  }

  /** Returns and forgets files whose debounce window has elapsed. */
  settledFiles(): string[] {
    const now = this.clock();
    const settled: string[] = [];
    for (const [rel, last] of this.lastEvent) {
      if (now - last >= this.debounceSeconds) settled.push(rel);
    }
    for (const rel of settled) this.lastEvent.delete(rel);
    return settled;
  }

  lastEventTime(rel: string): number | undefined {
    return this.lastEvent.get(rel);
  }
}

function defaultClock(): () => number {
  const start = Date.now();
  return () => (Date.now() - start) / 1000;
}

// --- lock file ---------------------------------------------------------------

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

/** The one shape all three lock files carry, so [lockState] reads whichever it is handed. */
function lockPayload(pid: number, startedAt: Date): string {
  return JSON.stringify({ pid, started_at: startedAt.toISOString() });
}

export function removeLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function pastStaleWindow(startedAtMs: number, now: Date): boolean {
  return (now.getTime() - startedAtMs) / 1000 > StaleLockSeconds;
}

/** What a lock file says about its holder — [lockState]'s one liveness rule. */
export type LockState =
  | { kind: "free" }
  /** pid is null for a file caught between the exclusive create and its stamp. */
  | { kind: "held"; pid: number | null }
  | { kind: "dead"; pid: number }
  /** Alive, but its stamp has outlived [StaleLockSeconds]: only a [StalePolicy] can price it. */
  | { kind: "expired"; pid: number }
  /** Exists but decides nothing; the [StalePolicy] answers. */
  | { kind: "unparsable" };

/**
 * What the lock file at lockPath says about its holder — the one liveness rule
 * every lock consults before waiting.
 *
 * An empty file reads as held, not gone: the exclusive create publishes it a
 * syscall before the holder can stamp it, and reading that as gone would hand
 * the lock to two processes. It is judged by its own mtime instead, and only
 * becomes `unparsable` once that has aged out.
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

/** `kill(pid, 0)`: ESRCH means dead, anything else (EPERM) alive-but-not-ours. */
export function defaultPIDAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Staleness's wall clock — not [defaultClock], the debouncer's monotonic seconds. */
function defaultNow(): Date {
  return new Date();
}

/** The seams a lock reads before it waits; tests inject fakes for all of them. */
export interface LockSeams {
  clock?: () => Date;
  pidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
}

/** Fills production defaults into the seams a lock was handed. */
function lockDefaults(seams: LockSeams): Required<LockSeams> {
  return {
    clock: seams.clock ?? defaultNow,
    pidAlive: seams.pidAlive ?? defaultPIDAlive,
    sleep: seams.sleep ?? sleep,
  };
}

/**
 * Tries to acquire the watch lock. A live lock bails with
 * `{acquired: false, stalePID: null}`, untouched; a stale one is replaced and
 * its removed pid returned (null when the file was unparsable). Check, unlink
 * and write run under the companion `.mutex`, so two processes racing a stale
 * takeover can't both pass the staleness check.
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

/** The queue's entries; an absent queue is empty. Split on "\n" — a path may
 * contain other control bytes. */
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

/** Runs fn(currentLines) → newLines under an exclusive lock; writes a `.tmp`
 * sibling and renames, so no reader sees a partial write. */
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

/** Appends rel unless already present. */
export function appendQueue(queuePath: string, rel: string): void {
  withQueueLock(queuePath, (lines) => {
    for (const line of lines) {
      if (line === rel) return lines;
    }
    return [...lines, rel];
  });
}

export function removeFromQueue(queuePath: string, rel: string): void {
  withQueueLock(queuePath, (lines) => lines.filter((l) => l !== rel));
}

// --- eligibility check on settle ----------------------------------------------

/** Enqueues settledRel iff it's in eligibleRels. A settled event doesn't mean
 * "ingest this" — an `.ingestignore` match, or a file whose back-pointer page
 * is already current, settles too. */
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

export function forRoot(root: string): Paths {
  const wk = path.join(root, ".wiki-knowledge");
  return {
    root,
    lock: path.join(wk, "watch.lock"),
    queue: path.join(wk, "watch-queue.jsonl"),
  };
}

/** Maps an event path to a vault-relative path, or null for a directory or a
 * path outside root. */
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
 * What a lock does about a holder it cannot call gone: an unparsable file, or a
 * live pid past [StaleLockSeconds]. `.mutex` reclaims — it guards a
 * check-then-write around the lock file, matching [acquireLock]'s
 * fail-toward-proceeding posture — while `.writelock` fails, because two
 * writers each believing they hold the queue corrupts it. A dead pid is
 * reclaimed under either policy.
 */
export type StalePolicy = "reclaim" | "fail";

/**
 * Runs critical under an exclusive lock on lockPath, created atomically with
 * the `wx` flag and removed on release — the pure-JS stand-in for a blocking
 * flock (ADR-0017). A live holder is waited out, but only for as long as
 * [lockState] gives it credit; what happens to an expired or unparsable lock is
 * stalePolicy, so a `.mutex` stranded by a killed process is taken over rather
 * than spun on.
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

/** Creates lockPath with `wx` and stamps its holder, returning the open fd. The
 * create is the mutual exclusion; between it and the stamp the file is visible
 * empty — which [lockState] reads as held, never as gone. */
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

/** The `"fail"` lock's error: which lock and what [lockState] found wrong, so a
 * person can act. */
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

/** The file-watcher surface [runWatch] drives; chokidar's FSWatcher satisfies
 * it structurally. */
export interface Watcher {
  /** The loop consumes only the "all" event, keyed by (eventName, path). */
  on(event: "all", cb: (eventName: string, p: string) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "ready", cb: () => void): void;
  /** Stops watching; resolves once fully closed. */
  close(): Promise<void>;
}

/** One eligibility sweep per poll tick; returns the vault-relative paths it
 * offers. */
export type Sweep = () => Promise<Set<string>>;

/** Schedules `tick` every `ms`; returns a cancel function. Tests inject a manual
 * driver, so no real sleeps. */
export type Scheduler = (tick: () => void, ms: number) => () => void;

/** SIGINT/SIGTERM are what a person sends; SIGHUP comes from a closing terminal
 * and, unhandled, kills the process mid critical section — stranding a `.mutex`
 * for the next watcher. */
export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

const StopSignals: StopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The injectable seams [runWatch] composes; tests inject fakes for all of
 * them. */
export interface WatchOptions {
  debounceSeconds?: number;
  pollIntervalSeconds?: number;
  makeWatcher?: (rawRoot: string) => Watcher;
  sweep?: Sweep;
  clock?: () => number;
  onSignal?: (signal: StopSignal, cb: () => void) => void;
  offSignal?: (signal: StopSignal, cb: () => void) => void;
  schedule?: Scheduler;
  pid?: number;
  log?: (line: string) => void;
}

/**
 * The long-lived watch loop: the watcher reports raw/ events into the
 * debouncer; each poll tick sweeps settled files for eligibility and enqueues
 * them. Any [StopSignal] stops the loop — logs, cancels the poll, closes the
 * watcher, removes the lock, resolves.
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
