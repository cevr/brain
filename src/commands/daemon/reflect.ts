import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../../errors/index.js";
import { ClaudeService } from "../../services/Claude.js";
import { ConfigService } from "../../services/Config.js";
import { VaultService } from "../../services/Vault.js";
import {
  acquireLock,
  deriveProjectName,
  isSettled,
  readState,
  releaseLock,
  requireHome,
  writeState,
  type DaemonState,
} from "./state.js";

const CLAUDE_PROJECTS_DIR = ".claude/projects";
const MAX_TOTAL_LINES = 2000;

interface SessionFile {
  readonly name: string;
  readonly path: string;
  readonly mtime: Date;
  readonly mtimeIso: string;
  readonly lineCount: number;
}

/** Count newlines in a file (line count approximation) */
const countLines = Effect.fn("countLines")(function* (filePath: string) {
  const fs = yield* FileSystem;
  const content = yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed("")));
  if (content.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  // Add 1 if file doesn't end with newline (last line without trailing \n)
  return content[content.length - 1] === "\n" ? count : count + 1;
});

/** @internal */
export const scanSessions = Effect.fn("scanSessions")(function* (state: DaemonState) {
  const fs = yield* FileSystem;
  const path = yield* Path;

  const home = yield* requireHome();
  const projectsDir = path.join(home, CLAUDE_PROJECTS_DIR);

  const exists = yield* fs.exists(projectsDir).pipe(Effect.catch(() => Effect.succeed(false)));
  if (!exists) return [];

  const projectDirs = yield* fs.readDirectory(projectsDir).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot read projects dir: ${e.message}`,
          code: "READ_FAILED",
        }),
    ),
  );

  const processed = state.reflect?.processedSessions ?? {};

  const groups: Array<{
    readonly dirName: string;
    readonly projectName: string;
    readonly sessions: SessionFile[];
  }> = [];

  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsDir, dirName);
    const stat = yield* fs.stat(dirPath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat === null || stat.type !== "Directory") continue;

    const files = yield* fs
      .readDirectory(dirPath)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    const sessions: SessionFile[] = [];

    for (const file of jsonlFiles) {
      const filePath = path.join(dirPath, file);
      const fileStat = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
      if (fileStat === null || fileStat.type !== "File") continue;

      const mtime = fileStat.mtime ?? new Date(0);
      if (!isSettled(mtime)) continue;

      const mtimeIso = mtime.toISOString();
      const key = `${dirName}/${file}`;
      const recorded = processed[key];

      // Skip if already processed with same mtime
      if (recorded === mtimeIso) continue;

      const lineCount = yield* countLines(filePath);
      if (lineCount === 0) continue;

      sessions.push({ name: file, path: filePath, mtime, mtimeIso, lineCount });
    }

    if (sessions.length > 0) {
      const projectName = yield* deriveProjectName(dirName);
      groups.push({
        dirName,
        projectName,
        sessions,
      });
    }
  }

  return groups;
});

/**
 * Build file-path prompt for Claude. Lists session JSONL files with line ranges
 * so Claude can Read them directly. Caps total lines at MAX_TOTAL_LINES.
 */
const buildFilePathPrompt = (projectName: string, sessions: readonly SessionFile[]): string => {
  // Distribute line budget across sessions, newest first
  const sorted = [...sessions].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  let remaining = MAX_TOTAL_LINES;
  const entries: string[] = [];

  for (const session of sorted) {
    if (remaining <= 0) break;
    const lines = Math.min(session.lineCount, remaining);
    // Read from the end (most recent messages) if truncated
    const offset = session.lineCount > lines ? session.lineCount - lines + 1 : 1;
    entries.push(`${session.path} (lines ${String(offset)}-${String(offset + lines - 1)})`);
    remaining -= lines;
  }

  return `Session files for project "${projectName}":\n\n${entries.join("\n")}\n\n/reflect`;
};

/** Run the reflect daemon job */
export const runReflect = Effect.fn("runReflect")(function* () {
  const config = yield* ConfigService;
  const vault = yield* VaultService;
  const claude = yield* ClaudeService;
  const path = yield* Path;

  const brainDir = yield* config.globalVaultPath();
  yield* acquireLock(brainDir, "reflect");

  yield* Effect.gen(function* () {
    let state = yield* readState(brainDir);
    const groups = yield* scanSessions(state);

    if (groups.length === 0) {
      yield* Console.error("No new sessions to reflect on");
      return;
    }

    for (const group of groups) {
      yield* Effect.gen(function* () {
        yield* Console.error(
          `Reflecting on ${group.sessions.length} session(s) from ${group.projectName}...`,
        );

        // Ensure project dir exists in vault
        const projectDir = path.join(brainDir, "projects", group.projectName);
        yield* vault.init(projectDir, { minimal: true }).pipe(Effect.catch(() => Effect.void));

        // Build prompt with file paths — Claude reads them via its Read tool
        const prompt = buildFilePathPrompt(group.projectName, group.sessions);

        yield* claude.invoke(prompt, "sonnet");
        yield* Console.error(`  Reflected on ${group.sessions.length} session(s)`);

        // Checkpoint: mark sessions processed after successful invocation
        const processedSessions = { ...(state.reflect?.processedSessions ?? {}) };
        for (const session of group.sessions) {
          processedSessions[`${group.dirName}/${session.name}`] = session.mtimeIso;
        }
        state = {
          ...state,
          reflect: {
            lastRun: new Date().toISOString(),
            processedSessions,
          },
        };
        yield* writeState(brainDir, state);
      }).pipe(
        Effect.catch((e) => Console.error(`  Failed to reflect on ${group.projectName}: ${e}`)),
      );
    }

    yield* Console.error("Reflect complete");
  }).pipe(Effect.ensuring(releaseLock(brainDir, "reflect")));
});
