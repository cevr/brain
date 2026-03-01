import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { PlatformError } from "effect/PlatformError";
import { ConfigService } from "../services/Config.js";
import { VaultService } from "../services/Vault.js";
import { ConfigError } from "../errors/index.js";

const projectFlag = Flag.boolean("project").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Create a project-scoped vault"),
);
const globalFlag = Flag.boolean("global").pipe(
  Flag.withAlias("g"),
  Flag.withDescription("Namespace project vault under global vault"),
);
const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));
const skipSkillsFlag = Flag.boolean("skip-skills").pipe(
  Flag.withDescription("Skip skill installation"),
);
const forceSkillsFlag = Flag.boolean("force-skills").pipe(
  Flag.withDescription("Overwrite existing skills"),
);

export const init = Command.make("init", {
  project: projectFlag,
  global: globalFlag,
  json: jsonFlag,
  skipSkills: skipSkillsFlag,
  forceSkills: forceSkillsFlag,
}).pipe(
  Command.withDescription("Initialize a brain vault"),
  Command.withHandler(({ project, global, json, skipSkills, forceSkills }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const vault = yield* VaultService;
      const fs = yield* FileSystem;
      const path = yield* Path;

      let vaultPath: string;

      if (project) {
        if (global) {
          const globalPath = yield* config.globalVaultPath();
          const cwd = process.cwd();
          const projectName = path.basename(cwd);
          vaultPath = path.join(globalPath, "projects", projectName);
          const targetExists = yield* fs
            .exists(vaultPath)
            .pipe(
              Effect.mapError(
                (e: PlatformError) =>
                  new ConfigError({ message: `Cannot check project vault: ${e.message}` }),
              ),
            );
          if (targetExists) {
            yield* Console.error(`Warning: project vault already exists at ${vaultPath}`);
          }
        } else {
          const cwd = process.cwd();
          vaultPath = path.join(cwd, "brain");
        }
      } else {
        vaultPath = yield* config.globalVaultPath();
      }

      const created = yield* vault.init(vaultPath);

      // Copy starter principles if principles/ is empty
      yield* copyStarterPrinciples(fs, path, vaultPath);

      const cfgPath = yield* config.configFilePath();
      const cfgExists = yield* fs
        .exists(cfgPath)
        .pipe(
          Effect.mapError(
            (e: PlatformError) => new ConfigError({ message: `Cannot check config: ${e.message}` }),
          ),
        );
      if (!cfgExists) {
        yield* config.saveConfigFile({});
      }

      const settingsPath = yield* config.claudeSettingsPath();
      const hooksChanged = yield* wireHooks(fs, path, settingsPath);

      const skillResult = skipSkills
        ? { installed: [] as string[], conflicts: [] as string[], target: "" }
        : yield* installSkills(fs, path, forceSkills);

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(
          JSON.stringify({
            vault: vaultPath,
            config: cfgPath,
            hooks: settingsPath,
            files: created,
            skills: skillResult,
          }),
        );
      } else {
        if (created.length > 0) {
          yield* Console.error(`Created vault at ${vaultPath}`);
          for (const f of created) {
            yield* Console.error(`  ${f}`);
          }
        }
        if (!cfgExists) {
          yield* Console.error(`Wrote config to ${cfgPath}`);
        }
        if (hooksChanged) {
          yield* Console.error(`Wired hooks into ${settingsPath}`);
        }
        if (skillResult.installed.length > 0) {
          yield* Console.error(`Installed skills to ${skillResult.target}`);
          for (const s of skillResult.installed) {
            yield* Console.error(`  ${s}`);
          }
        }
        const somethingChanged =
          created.length > 0 || !cfgExists || hooksChanged || skillResult.installed.length > 0;
        if (skillResult.conflicts.length > 0 && somethingChanged) {
          yield* Console.error(`Skipped (already exist):`);
          for (const s of skillResult.conflicts) {
            yield* Console.error(`  ${s} — use brain init --force-skills to override`);
          }
        }
      }
    }),
  ),
);

/** @internal */
export const wireHooks = Effect.fn("wireHooks")(function* (
  fs: FileSystem,
  path: Path,
  settingsPath: string,
) {
  const dir = path.dirname(settingsPath);
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({ message: `Cannot create settings dir: ${e.message}` }),
      ),
    );

  const existing = yield* fs
    .readFileString(settingsPath)
    .pipe(
      Effect.catch((e) =>
        e instanceof PlatformError &&
        (e.reason._tag === "NotFound" || e.reason._tag === "BadArgument")
          ? Effect.succeed("{}")
          : Effect.fail(
              new ConfigError({ message: `Cannot read settings: ${(e as PlatformError).message}` }),
            ),
      ),
    );

  const parsed = yield* Effect.try({
    try: () => JSON.parse(existing) as Record<string, unknown>,
    catch: () => new ConfigError({ message: "Cannot parse settings.json" }),
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return yield* new ConfigError({ message: "settings.json is not a JSON object" });
  }

  // Validate hooks is a plain object before using it
  const rawHooks = parsed["hooks"];
  const hooks: Record<string, unknown[]> =
    typeof rawHooks === "object" && rawHooks !== null && !Array.isArray(rawHooks)
      ? (rawHooks as Record<string, unknown[]>)
      : {};

  let changed = false;

  const sessionStartHook = {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: "brain inject" }],
  };

  const postToolUseHook = {
    matcher: "brain/",
    hooks: [{ type: "command", command: "brain reindex" }],
  };

  const sessionStart = (hooks["SessionStart"] ?? []) as Array<{
    matcher?: string;
    hooks?: Array<{ command?: string }>;
  }>;
  const brainInjectIdx = sessionStart.findIndex(
    (h) => h?.hooks?.some((hh) => hh.command === "brain inject") ?? false,
  );
  if (brainInjectIdx === -1) {
    hooks["SessionStart"] = [...sessionStart, sessionStartHook];
    changed = true;
  } else if (sessionStart[brainInjectIdx]?.matcher !== "startup|resume") {
    // Update matcher on existing hook
    sessionStart[brainInjectIdx] = { ...sessionStart[brainInjectIdx], matcher: "startup|resume" };
    hooks["SessionStart"] = sessionStart;
    changed = true;
  }

  const postToolUse = (hooks["PostToolUse"] ?? []) as Array<{
    hooks?: Array<{ command?: string }>;
  }>;
  const hasBrainReindex = postToolUse.some(
    (h) => h?.hooks?.some((hh) => hh.command === "brain reindex") ?? false,
  );
  if (!hasBrainReindex) {
    hooks["PostToolUse"] = [...postToolUse, postToolUseHook];
    changed = true;
  }

  if (changed) {
    parsed["hooks"] = hooks;
    // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
    yield* fs
      .writeFileString(settingsPath, JSON.stringify(parsed, null, 2) + "\n")
      .pipe(
        Effect.mapError(
          (e: PlatformError) => new ConfigError({ message: `Cannot write settings: ${e.message}` }),
        ),
      );
  }

  return changed;
});

const copyStarterPrinciples = Effect.fn("copyStarterPrinciples")(function* (
  fs: FileSystem,
  path: Path,
  vaultPath: string,
) {
  const principlesDir = path.join(vaultPath, "principles");
  const starterDir = path.join(REPO_ROOT, "starter", "principles");

  const isNotFound = (e: unknown): boolean =>
    e instanceof PlatformError && (e.reason._tag === "NotFound" || e.reason._tag === "BadArgument");

  // Check if starter dir exists in the build
  const starterExists = yield* fs.exists(starterDir).pipe(
    Effect.catch((e) =>
      isNotFound(e)
        ? Effect.succeed(false)
        : Effect.fail(
            new ConfigError({
              message: `Cannot check starter dir: ${(e as PlatformError).message}`,
            }),
          ),
    ),
  );
  if (!starterExists) return;

  // Check if vault principles dir is empty
  const entries = yield* fs.readDirectory(principlesDir).pipe(
    Effect.catch((e) =>
      isNotFound(e)
        ? Effect.succeed([] as string[])
        : Effect.fail(
            new ConfigError({
              message: `Cannot read principles dir: ${(e as PlatformError).message}`,
            }),
          ),
    ),
  );
  if (entries.length > 0) return;

  // Copy starter principles
  const starterFiles = yield* fs.readDirectory(starterDir).pipe(
    Effect.catch((e) =>
      isNotFound(e)
        ? Effect.succeed([] as string[])
        : Effect.fail(
            new ConfigError({
              message: `Cannot read starter dir: ${(e as PlatformError).message}`,
            }),
          ),
    ),
  );

  for (const file of starterFiles) {
    const content = yield* fs
      .readFile(path.join(starterDir, file))
      .pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({ message: `Cannot read starter file ${file}: ${e.message}` }),
        ),
      );
    if (content.length > 0) {
      yield* fs
        .writeFile(path.join(principlesDir, file), content)
        .pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new ConfigError({ message: `Cannot write ${file}: ${e.message}` }),
          ),
        );
    }
  }

  // Copy principles.md index
  const indexSrc = path.join(REPO_ROOT, "starter", "principles.md");
  const indexSrcExists = yield* fs.exists(indexSrc).pipe(
    Effect.catch((e) =>
      isNotFound(e)
        ? Effect.succeed(false)
        : Effect.fail(
            new ConfigError({
              message: `Cannot check starter principles.md: ${(e as PlatformError).message}`,
            }),
          ),
    ),
  );
  if (indexSrcExists) {
    const indexContent = yield* fs
      .readFile(indexSrc)
      .pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({ message: `Cannot read starter principles.md: ${e.message}` }),
        ),
      );
    if (indexContent.length > 0) {
      yield* fs
        .writeFile(path.join(vaultPath, "principles.md"), indexContent)
        .pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new ConfigError({ message: `Cannot write principles.md: ${e.message}` }),
          ),
        );
    }
  }
});

const installSkills = Effect.fn("installSkills")(function* (
  fs: FileSystem,
  path: Path,
  force: boolean,
) {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";

  // REPO_ROOT injected at compile time by scripts/build.ts
  const sourceDir = path.join(REPO_ROOT, "skills");

  const sourceExists = yield* fs
    .exists(sourceDir)
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({ message: `Cannot check skills source: ${e.message}` }),
      ),
    );
  if (!sourceExists) {
    return { installed: [], conflicts: [], target: "" };
  }

  // BRAIN_SKILLS_DIR overrides default
  const envSkillsDir = process.env["BRAIN_SKILLS_DIR"];
  const targetDir =
    envSkillsDir !== undefined && envSkillsDir.trim() !== ""
      ? envSkillsDir
      : path.join(home, ".claude", "skills");

  yield* fs
    .makeDirectory(targetDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({ message: `Cannot create skills dir: ${e.message}` }),
      ),
    );

  // List source skills
  const sourceEntries = yield* fs
    .readDirectory(sourceDir)
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({ message: `Cannot read skills source: ${e.message}` }),
      ),
    );

  const installed: string[] = [];
  const conflicts: string[] = [];

  // Filter to directories only (skip .DS_Store, README.md, etc.)
  const skills: string[] = [];
  for (const entry of sourceEntries) {
    const stat = yield* fs
      .stat(path.join(sourceDir, entry))
      .pipe(
        Effect.mapError(
          (e: PlatformError) => new ConfigError({ message: `Cannot stat ${entry}: ${e.message}` }),
        ),
      );
    if (stat.type === "Directory") {
      skills.push(entry);
    }
  }

  for (const skill of skills) {
    const targetSkillDir = path.join(targetDir, skill);
    const exists = yield* fs
      .exists(targetSkillDir)
      .pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({ message: `Cannot check skill ${skill}: ${e.message}` }),
        ),
      );

    if (exists && !force) {
      conflicts.push(skill);
      continue;
    }

    // Copy skill directory recursively (binary-safe)
    yield* copyDir(fs, path, path.join(sourceDir, skill), targetSkillDir);
    installed.push(skill);
  }

  return { installed, conflicts, target: targetDir };
});

const copyDir: (
  fs: FileSystem,
  p: Path,
  src: string,
  dest: string,
) => Effect.Effect<void, ConfigError> = Effect.fn("copyDir")(function* (
  fs: FileSystem,
  p: Path,
  src: string,
  dest: string,
) {
  yield* fs
    .makeDirectory(dest, { recursive: true })
    .pipe(
      Effect.mapError(
        (e: PlatformError) => new ConfigError({ message: `Cannot create ${dest}: ${e.message}` }),
      ),
    );

  const entries = yield* fs
    .readDirectory(src)
    .pipe(
      Effect.mapError(
        (e: PlatformError) => new ConfigError({ message: `Cannot read ${src}: ${e.message}` }),
      ),
    );

  for (const entry of entries) {
    const srcPath = p.join(src, entry);
    const destPath = p.join(dest, entry);

    const stat = yield* fs
      .stat(srcPath)
      .pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({ message: `Cannot stat ${srcPath}: ${e.message}` }),
        ),
      );

    if (stat.type === "Directory") {
      yield* copyDir(fs, p, srcPath, destPath);
    } else {
      // Binary-safe: use readFile/writeFile instead of readFileString/writeFileString
      const content = yield* fs
        .readFile(srcPath)
        .pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new ConfigError({ message: `Cannot read ${srcPath}: ${e.message}` }),
          ),
        );
      yield* fs
        .writeFile(destPath, content)
        .pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new ConfigError({ message: `Cannot write ${destPath}: ${e.message}` }),
          ),
        );
    }
  }
});
