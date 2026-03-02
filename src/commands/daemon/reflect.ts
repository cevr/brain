import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../../errors/index.js";
import { ClaudeService } from "../../services/Claude.js";
import { ConfigService } from "../../services/Config.js";
import { VaultService } from "../../services/Vault.js";
import { extractConversations } from "../extract.js";
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
const MAX_SESSIONS_PER_BATCH = 5;

interface SessionFile {
  readonly name: string;
  readonly path: string;
  readonly mtime: Date;
  readonly mtimeIso: string;
}

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

      sessions.push({ name: file, path: filePath, mtime, mtimeIso });
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

/** Run the reflect daemon job */
export const runReflect = Effect.fn("runReflect")(function* () {
  const config = yield* ConfigService;
  const vault = yield* VaultService;
  const claude = yield* ClaudeService;
  const fs = yield* FileSystem;
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

        // Extract conversations to a temp dir, then build prompt
        const tmpDir = yield* fs.makeTempDirectory().pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              const d = path.join(brainDir, ".daemon-tmp");
              yield* fs.makeDirectory(d, { recursive: true }).pipe(Effect.catch(() => Effect.void));
              return d;
            }),
          ),
        );

        const inputDir = path.join(tmpDir, "input");
        const outputDir = path.join(tmpDir, "output");
        yield* fs
          .makeDirectory(inputDir, { recursive: true })
          .pipe(Effect.catch(() => Effect.void));

        // Copy session files into temp input dir
        for (const session of group.sessions) {
          const dest = path.join(inputDir, session.name);
          yield* fs.copyFile(session.path, dest).pipe(Effect.catch(() => Effect.void));
        }

        const result = yield* extractConversations(inputDir, outputDir, {
          batches: Math.ceil(group.sessions.length / MAX_SESSIONS_PER_BATCH),
          minSize: 200,
        });

        if (result.conversations.length === 0) {
          yield* Console.error(`  No meaningful conversations found, skipping`);
        } else {
          // Build transcript text from written files
          const transcripts: string[] = [];
          for (const writtenPath of result.writtenPaths) {
            const content = yield* fs
              .readFileString(writtenPath)
              .pipe(Effect.catch(() => Effect.succeed("")));
            if (content.length > 0) transcripts.push(content);
          }

          if (transcripts.length > 0) {
            const text = transcripts.join("\n\n---\n\n");
            const prompt = `Session transcripts from project "${group.projectName}":\n\n${text}\n\n/reflect`;

            yield* claude.invoke(prompt, "sonnet");
            yield* Console.error(`  Reflected on ${result.conversations.length} conversation(s)`);
          }
        }

        // Checkpoint: only mark sessions processed after successful extraction + invocation
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

        // Cleanup temp dir
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
      }).pipe(
        Effect.catch((e) => Console.error(`  Failed to reflect on ${group.projectName}: ${e}`)),
      );
    }

    yield* Console.error("Reflect complete");
  }).pipe(Effect.ensuring(releaseLock(brainDir, "reflect")));
});
