import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ConfigService } from "../services/Config.js";
import { BuildInfo } from "../services/BuildInfo.js";
import { ConfigError } from "../errors/index.js";
import { copyDir } from "./init.js";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

interface SkillInfo {
  readonly name: string;
  readonly path: string;
  readonly symlink: string | null;
  readonly outdated: boolean;
}

const resolveSkillsDir = (path: Path, settingsPath: string): string => {
  const envSkillsDir = process.env["BRAIN_SKILLS_DIR"];
  return envSkillsDir !== undefined && envSkillsDir.trim() !== ""
    ? envSkillsDir
    : path.join(path.dirname(settingsPath), "skills");
};

const resolveSourceDir = Effect.fn("resolveSourceDir")(function* (fs: FileSystem, path: Path) {
  const { repoRoot } = yield* BuildInfo;
  const sourceDir = path.join(repoRoot, "skills");
  const exists = yield* fs.exists(sourceDir).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new ConfigError({
          message: `Cannot check skills source: ${e.message}`,
          code: "READ_FAILED",
        }),
    ),
  );
  return exists ? sourceDir : null;
});

const listSkillDirs = Effect.fn("listSkillDirs")(function* (
  fs: FileSystem,
  path: Path,
  dir: string,
) {
  const entries = yield* fs.readDirectory(dir).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new ConfigError({
          message: `Cannot read skills dir: ${e.message}`,
          code: "READ_FAILED",
        }),
    ),
  );
  const dirs: string[] = [];
  for (const entry of entries) {
    const stat = yield* fs.stat(path.join(dir, entry)).pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot stat ${entry}: ${e.message}`,
            code: "READ_FAILED",
          }),
      ),
    );
    if (stat.type === "Directory" || stat.type === "SymbolicLink") {
      dirs.push(entry);
    }
  }
  return dirs.sort();
});

/** Compare two directories recursively — returns true if contents differ */
const dirsHaveDiff: (
  fs: FileSystem,
  path: Path,
  a: string,
  b: string,
) => Effect.Effect<boolean, ConfigError> = Effect.fn("dirsHaveDiff")(function* (
  fs: FileSystem,
  path: Path,
  a: string,
  b: string,
) {
  const aEntries = yield* fs
    .readDirectory(a)
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));
  const bEntries = yield* fs
    .readDirectory(b)
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));

  const aSet = new Set(aEntries);
  const bSet = new Set(bEntries);

  // Different file sets
  if (aSet.size !== bSet.size) return true;
  for (const entry of aSet) {
    if (!bSet.has(entry)) return true;
  }

  // Compare each entry
  for (const entry of aSet) {
    const aPath = path.join(a, entry);
    const bPath = path.join(b, entry);

    const aStat = yield* fs.stat(aPath).pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot stat ${aPath}: ${e.message}`,
            code: "READ_FAILED",
          }),
      ),
    );

    if (aStat.type === "Directory") {
      const subDiff = yield* dirsHaveDiff(fs, path, aPath, bPath);
      if (subDiff) return true;
    } else {
      const aContent = yield* fs
        .readFile(aPath)
        .pipe(Effect.catch(() => Effect.succeed(new Uint8Array(0))));
      const bContent = yield* fs
        .readFile(bPath)
        .pipe(Effect.catch(() => Effect.succeed(new Uint8Array(0))));

      if (aContent.length !== bContent.length) return true;
      for (let i = 0; i < aContent.length; i++) {
        if (aContent[i] !== bContent[i]) return true;
      }
    }
  }

  return false;
});

const skillsList = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription("List installed skills"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const fs = yield* FileSystem;
      const path = yield* Path;

      const settingsPath = yield* config.claudeSettingsPath();
      const targetDir = resolveSkillsDir(path, settingsPath);
      const sourceDir = yield* resolveSourceDir(fs, path);

      const targetExists = yield* fs
        .exists(targetDir)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!targetExists) {
        if (json) {
          // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
          yield* Console.log(JSON.stringify({ skills: [], target: targetDir }));
        } else {
          yield* Console.error(`No skills directory at ${targetDir}`);
        }
        return;
      }

      const skillNames = yield* listSkillDirs(fs, path, targetDir);
      const skills: SkillInfo[] = [];

      for (const name of skillNames) {
        const skillPath = path.join(targetDir, name);

        // Check if symlink
        const lstat = yield* fs.stat(skillPath).pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new ConfigError({
                message: `Cannot stat ${name}: ${e.message}`,
                code: "READ_FAILED",
              }),
          ),
        );
        let symlink: string | null = null;
        if (lstat.type === "SymbolicLink") {
          symlink = yield* fs.readLink(skillPath).pipe(
            Effect.map((p) => p.toString()),
            Effect.catch(() => Effect.succeed(skillPath)),
          );
        }

        // Check outdated: compare installed vs source
        let outdated = false;
        if (sourceDir !== null) {
          const sourcePath = path.join(sourceDir, name);
          const sourceExists = yield* fs
            .exists(sourcePath)
            .pipe(Effect.catch(() => Effect.succeed(false)));
          if (sourceExists) {
            // For symlinks, compare the resolved target vs source
            const compareTarget = symlink ?? skillPath;
            outdated = yield* dirsHaveDiff(fs, path, sourcePath, compareTarget);
          }
        }

        skills.push({ name, path: skillPath, symlink, outdated });
      }

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ skills, target: targetDir }));
      } else {
        for (const skill of skills) {
          const suffix = skill.symlink !== null ? ` → ${skill.symlink}` : "";
          const status = skill.outdated ? " (outdated)" : "";
          yield* Console.log(`${skill.name}${status}${suffix}`);
        }
      }
    }),
  ),
);

const skillsSync = Command.make("sync").pipe(
  Command.withDescription("Sync skills from source to installed location"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const fs = yield* FileSystem;
      const path = yield* Path;

      const settingsPath = yield* config.claudeSettingsPath();
      const targetDir = resolveSkillsDir(path, settingsPath);
      const sourceDir = yield* resolveSourceDir(fs, path);

      if (sourceDir === null) {
        yield* Console.error("No skills source found");
        return;
      }

      const sourceSkills = yield* listSkillDirs(fs, path, sourceDir);

      yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({
              message: `Cannot create skills dir: ${e.message}`,
              code: "WRITE_FAILED",
            }),
        ),
      );

      let synced = 0;

      for (const name of sourceSkills) {
        const sourcePath = path.join(sourceDir, name);
        const targetPath = path.join(targetDir, name);

        const targetExists = yield* fs
          .exists(targetPath)
          .pipe(Effect.catch(() => Effect.succeed(false)));

        if (targetExists) {
          // Check if symlink — don't overwrite symlinks, they're user-managed
          const lstat = yield* fs.stat(targetPath).pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({
                  message: `Cannot stat ${name}: ${e.message}`,
                  code: "READ_FAILED",
                }),
            ),
          );
          if (lstat.type === "SymbolicLink") {
            // For symlinks, sync to the resolved target
            const resolvedTarget = yield* fs.readLink(targetPath).pipe(
              Effect.map((p) => p.toString()),
              Effect.catch(() => Effect.succeed(targetPath)),
            );

            const hasDiff = yield* dirsHaveDiff(fs, path, sourcePath, resolvedTarget);
            if (!hasDiff) {
              continue;
            }
            yield* copyDir(fs, path, sourcePath, resolvedTarget);
            synced++;
            yield* Console.error(`  ${name} → ${resolvedTarget}`);
          } else {
            // Regular directory — check diff
            const hasDiff = yield* dirsHaveDiff(fs, path, sourcePath, targetPath);
            if (!hasDiff) {
              continue;
            }
            yield* copyDir(fs, path, sourcePath, targetPath);
            synced++;
            yield* Console.error(`  ${name}`);
          }
        } else {
          yield* copyDir(fs, path, sourcePath, targetPath);
          synced++;
          yield* Console.error(`  ${name}`);
        }
      }

      if (synced > 0) {
        yield* Console.error(`\nSynced ${synced} skill${synced === 1 ? "" : "s"}`);
      } else {
        yield* Console.error("All skills up to date");
      }
    }),
  ),
);

const skillsRoot = Command.make("skills").pipe(Command.withDescription("Manage installed skills"));

export const skills = skillsRoot.pipe(Command.withSubcommands([skillsList, skillsSync]));
