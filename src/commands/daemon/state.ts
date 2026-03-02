import { writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../../errors/index.js";

// --- Schemas ---

const JobState = Schema.Struct({
  lastRun: Schema.optional(Schema.String),
});

const ReflectState = Schema.Struct({
  lastRun: Schema.optional(Schema.String),
  processedSessions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const DaemonStateSchema = Schema.Struct({
  reflect: Schema.optional(ReflectState),
  ruminate: Schema.optional(JobState),
  meditate: Schema.optional(JobState),
});

export type DaemonState = typeof DaemonStateSchema.Type;

const DaemonStateJson = Schema.fromJsonString(DaemonStateSchema);
const decodeDaemonState = Schema.decodeUnknownEffect(DaemonStateJson);
const encodeDaemonState = Schema.encodeEffect(DaemonStateJson);

// --- Constants ---

const SETTLE_MS = 30 * 60 * 1000; // 30 minutes
const STATE_FILE = ".daemon.json";

// --- State IO ---

/** Read daemon state from ~/.brain/.daemon.json, returns default if missing */
export const readState = Effect.fn("readState")(function* (brainDir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const filePath = path.join(brainDir, STATE_FILE);

  const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));

  if (!exists) {
    return { reflect: {}, ruminate: {}, meditate: {} } satisfies DaemonState;
  }

  const text = yield* fs.readFileString(filePath).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot read daemon state: ${e.message}`,
          code: "READ_FAILED",
        }),
    ),
  );

  return yield* decodeDaemonState(text).pipe(
    Effect.catch(() =>
      Effect.succeed({ reflect: {}, ruminate: {}, meditate: {} } satisfies DaemonState),
    ),
  );
});

/** Atomic write of daemon state */
export const writeState = Effect.fn("writeState")(function* (brainDir: string, state: DaemonState) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const filePath = path.join(brainDir, STATE_FILE);
  const tmpPath = `${filePath}.tmp`;

  const text = yield* encodeDaemonState(state).pipe(
    Effect.mapError(
      () =>
        new BrainError({
          message: "Cannot encode daemon state",
          code: "WRITE_FAILED",
        }),
    ),
  );

  yield* fs.writeFileString(tmpPath, text + "\n").pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot write daemon state: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  yield* fs.rename(tmpPath, filePath).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot rename daemon state: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );
});

// --- Locking ---

const lockPath = (brainDir: string, job: string, path: Path) =>
  path.join(brainDir, `.daemon-${job}.lock`);

/** Acquire a lock for a daemon job. Uses exclusive file creation (O_EXCL) to avoid TOCTOU races. */
export const acquireLock = Effect.fn("acquireLock")(function* (brainDir: string, job: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const lock = lockPath(brainDir, job, path);
  const pid = `${process.pid}\n`;

  // Attempt atomic create-or-fail via O_EXCL (wx flag)
  const created = yield* Effect.try({
    try: () => {
      writeFileSync(lock, pid, { flag: "wx" });
      return true as const;
    },
    catch: () => new BrainError({ message: "Lock file exists", code: "LOCKED" }),
  }).pipe(Effect.catch(() => Effect.succeed(false as const)));

  if (created) return;

  // Lock file exists — check if holder is alive
  const content = yield* fs.readFileString(lock).pipe(Effect.catch(() => Effect.succeed("")));
  const holderPid = parseInt(content.trim(), 10);

  if (!Number.isNaN(holderPid) && isProcessAlive(holderPid)) {
    return yield* new BrainError({
      message: `Daemon job "${job}" is already running (PID ${holderPid}). If stale, remove ${lock}`,
      code: "LOCKED",
    });
  }

  // Stale lock — remove and retry once
  yield* fs.remove(lock).pipe(Effect.catch(() => Effect.void));

  yield* Effect.try({
    try: () => {
      writeFileSync(lock, pid, { flag: "wx" });
    },
    catch: () =>
      new BrainError({
        message: `Cannot acquire lock for "${job}" — concurrent process won the race`,
        code: "LOCKED",
      }),
  });
});

/** Release lock for a daemon job */
export const releaseLock = Effect.fn("releaseLock")(function* (brainDir: string, job: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const lock = lockPath(brainDir, job, path);

  yield* fs.remove(lock).pipe(Effect.catch(() => Effect.void));
});

// --- Utilities ---

/** Check if a file's mtime indicates it's settled (no writes for 30+ min) */
export const isSettled = (mtime: Date): boolean => Date.now() - mtime.getTime() > SETTLE_MS;

/**
 * Derive a project name from a Claude projects dir name.
 * Claude uses dashified absolute paths: `-Users-cvr-Developer-personal-brain`
 *
 * The encoding is lossy — dashes serve as both path separators and literal hyphens.
 * We reverse the dashification by trying candidate paths (replacing `-` with `/`)
 * from right to left, checking which exists on disk. The basename of the first
 * match is the project name. Falls back to the last dash-delimited segment.
 */
export const deriveProjectName = Effect.fn("deriveProjectName")(function* (dirName: string) {
  if (dirName.length <= 1) return dirName;

  const fs = yield* FileSystem;
  const p = yield* Path;

  // Decode: `--` = `/.` (dot-prefixed dirs), then `-` = `/`
  const decoded = dirName.replaceAll("--", "/.").replaceAll("-", "/");

  // Check if the fully-decoded path exists — if so, just use basename
  const fullExists = yield* fs.exists(decoded).pipe(Effect.catch(() => Effect.succeed(false)));
  if (fullExists) return p.basename(decoded);

  // Walk dashes right-to-left, trying each split as path separator
  // This finds the longest suffix that's a real directory name
  const dashes: number[] = [];
  for (let i = dirName.length - 1; i >= 0; i--) {
    if (dirName[i] === "-") dashes.push(i);
  }

  for (const idx of dashes) {
    const prefix = dirName.slice(0, idx);
    const candidate = prefix.replaceAll("--", "/.").replaceAll("-", "/");
    const exists = yield* fs.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false)));
    if (exists) {
      // Everything after this dash is the project name
      return dirName.slice(idx + 1);
    }
  }

  // Fallback: last dash-delimited segment
  const parts = dirName.split("-").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? dirName;
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
