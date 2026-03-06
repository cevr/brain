import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BuildInfo } from "../services/BuildInfo.js";
import {
  AgentPlatformService,
  allAgentProviderIds,
  isAgentProviderId,
} from "../services/AgentPlatform.js";
import { BrainError, ConfigError } from "../errors/index.js";
import { copyDir } from "./init.js";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));
const providerFlag = Flag.string("provider").pipe(
  Flag.optional,
  Flag.withDescription("Provider to manage (claude or codex)"),
);
const allProvidersFlag = Flag.boolean("all-providers").pipe(
  Flag.withDescription("Operate on all supported providers"),
);

interface SkillInfo {
  readonly name: string;
  readonly path: string;
  readonly symlink: Option.Option<string>;
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
  return exists ? Option.some(sourceDir) : Option.none<string>();
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

const resolveProviders = (
  platform: AgentPlatformService["Service"],
  provider: Option.Option<string>,
  allProviders: boolean,
) =>
  Effect.gen(function* () {
    if (Option.isSome(provider)) {
      if (!isAgentProviderId(provider.value)) {
        return yield* new BrainError({
          message: `Unknown provider "${provider.value}". Valid: ${allAgentProviderIds.join(", ")}`,
          code: "UNSUPPORTED_PROVIDER",
        });
      }
      return [provider.value] as Array<(typeof allAgentProviderIds)[number]>;
    }

    if (allProviders) return [...allAgentProviderIds];

    return [yield* platform.resolveInteractiveProvider(Option.none())];
  });

const skillsList = Command.make("list", {
  json: jsonFlag,
  provider: providerFlag,
  allProviders: allProvidersFlag,
}).pipe(
  Command.withDescription("List installed skills"),
  Command.withHandler(({ json, provider, allProviders }) =>
    Effect.gen(function* () {
      const platform = yield* AgentPlatformService;
      const fs = yield* FileSystem;
      const path = yield* Path;

      const sourceDir = yield* resolveSourceDir(fs, path);
      const providerIds = yield* resolveProviders(platform, provider, allProviders);
      const results: Array<{ provider: string; target: string; skills: SkillInfo[] }> = [];

      for (const providerId of providerIds) {
        const agent = yield* platform.getProvider(providerId);
        const targetDir = resolveSkillsDir(path, agent.integration.settingsPath);
        const targetExists = yield* fs
          .exists(targetDir)
          .pipe(Effect.catch(() => Effect.succeed(false)));
        if (!targetExists) {
          results.push({ provider: providerId, target: targetDir, skills: [] });
          continue;
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
          let symlink = Option.none<string>();
          if (lstat.type === "SymbolicLink") {
            symlink = yield* fs.readLink(skillPath).pipe(
              Effect.map((p) => Option.some(p.toString())),
              Effect.catch(() => Effect.succeed(Option.some(skillPath))),
            );
          }

          let outdated = false;
          if (Option.isSome(sourceDir)) {
            const sourcePath = path.join(sourceDir.value, name);
            const sourceExists = yield* fs
              .exists(sourcePath)
              .pipe(Effect.catch(() => Effect.succeed(false)));
            if (sourceExists) {
              const compareTarget = Option.getOrElse(symlink, () => skillPath);
              outdated = yield* dirsHaveDiff(fs, path, sourcePath, compareTarget);
            }
          }

          skills.push({ name, path: skillPath, symlink, outdated });
        }

        results.push({ provider: providerId, target: targetDir, skills });
      }

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ providers: results }));
      } else {
        for (const result of results) {
          yield* Console.log(`${result.provider}: ${result.target}`);
          for (const skill of result.skills) {
            const suffix = Option.match(skill.symlink, {
              onNone: () => "",
              onSome: (target) => ` → ${target}`,
            });
            const status = skill.outdated ? " (outdated)" : "";
            yield* Console.log(`${skill.name}${status}${suffix}`);
          }
        }
      }
    }),
  ),
);

const skillsSync = Command.make("sync", {
  provider: providerFlag,
  allProviders: allProvidersFlag,
}).pipe(
  Command.withDescription("Sync skills from source to installed location"),
  Command.withHandler(({ provider, allProviders }) =>
    Effect.gen(function* () {
      const platform = yield* AgentPlatformService;
      const fs = yield* FileSystem;
      const path = yield* Path;
      const sourceDir = yield* resolveSourceDir(fs, path);
      const providerIds = yield* resolveProviders(platform, provider, allProviders);

      if (Option.isNone(sourceDir)) {
        yield* Console.error("No skills source found");
        return;
      }

      const sourceSkills = yield* listSkillDirs(fs, path, sourceDir.value);
      let synced = 0;

      for (const providerId of providerIds) {
        const agent = yield* platform.getProvider(providerId);
        const targetDir = resolveSkillsDir(path, agent.integration.settingsPath);

        yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new ConfigError({
                message: `Cannot create skills dir: ${e.message}`,
                code: "WRITE_FAILED",
              }),
          ),
        );

        for (const name of sourceSkills) {
          const sourcePath = path.join(sourceDir.value, name);
          const targetPath = path.join(targetDir, name);

          const targetExists = yield* fs
            .exists(targetPath)
            .pipe(Effect.catch(() => Effect.succeed(false)));

          if (targetExists) {
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
              yield* Console.error(`  ${providerId}:${name} → ${resolvedTarget}`);
            } else {
              const hasDiff = yield* dirsHaveDiff(fs, path, sourcePath, targetPath);
              if (!hasDiff) {
                continue;
              }
              yield* copyDir(fs, path, sourcePath, targetPath);
              synced++;
              yield* Console.error(`  ${providerId}:${name}`);
            }
          } else {
            yield* copyDir(fs, path, sourcePath, targetPath);
            synced++;
            yield* Console.error(`  ${providerId}:${name}`);
          }
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
