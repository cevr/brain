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
          const targetExists = yield* fs.exists(vaultPath).pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({
                  message: `Cannot check project vault: ${e.message}`,
                  code: "READ_FAILED",
                }),
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
      const cfgExists = yield* fs.exists(cfgPath).pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({
              message: `Cannot check config: ${e.message}`,
              code: "READ_FAILED",
            }),
        ),
      );
      if (!cfgExists) {
        yield* config.saveConfigFile({});
      }

      const settingsPath = yield* config.claudeSettingsPath();
      const hooksChanged = yield* wireHooks(fs, path, settingsPath);

      const skillResult = skipSkills
        ? { installed: [] as string[], conflicts: [] as string[], target: "" }
        : yield* installSkills(fs, path, forceSkills, settingsPath);

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
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new ConfigError({
          message: `Cannot create settings dir: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  const existing = yield* fs.readFileString(settingsPath).pipe(
    Effect.catch((e) =>
      e instanceof PlatformError &&
      (e.reason._tag === "NotFound" || e.reason._tag === "BadArgument")
        ? Effect.succeed("{}")
        : Effect.fail(
            new ConfigError({
              message: `Cannot read settings: ${(e as PlatformError).message}`,
              code: "READ_FAILED",
            }),
          ),
    ),
  );

  const parsed = yield* Effect.try({
    try: () => JSON.parse(existing) as Record<string, unknown>,
    catch: () => new ConfigError({ message: "Cannot parse settings.json", code: "PARSE_FAILED" }),
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return yield* new ConfigError({
      message: "settings.json is not a JSON object",
      code: "PARSE_FAILED",
    });
  }

  // Validate hooks is a plain object before using it
  const rawHooks = parsed["hooks"];
  if (
    rawHooks !== undefined &&
    (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks))
  ) {
    yield* Console.error("Warning: settings.json hooks is not an object — skipping hook wiring");
    return false;
  }
  const hooks: Record<string, unknown> =
    typeof rawHooks === "object" && rawHooks !== null && !Array.isArray(rawHooks)
      ? (rawHooks as Record<string, unknown>)
      : {};

  const getHookArray = (key: string): unknown[] => {
    const val = hooks[key];
    return Array.isArray(val) ? val : [];
  };

  let changed = false;

  const sessionStartHook = {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: "brain inject" }],
  };

  const postToolUseHook = {
    matcher: "brain/",
    hooks: [{ type: "command", command: "brain reindex" }],
  };

  const sessionStart = getHookArray("SessionStart") as Array<{
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

  const postToolUse = getHookArray("PostToolUse") as Array<{
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
    yield* fs.writeFileString(settingsPath, JSON.stringify(parsed, null, 2) + "\n").pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot write settings: ${e.message}`,
            code: "WRITE_FAILED",
          }),
      ),
    );
  }

  return changed;
});

/** @internal */
export const copyStarterPrinciples = Effect.fn("copyStarterPrinciples")(function* (
  fs: FileSystem,
  path: Path,
  vaultPath: string,
  repoRoot?: string,
) {
  const root = repoRoot ?? REPO_ROOT;
  const principlesDir = path.join(vaultPath, "principles");
  const starterDir = path.join(root, "starter", "principles");

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
              code: "READ_FAILED",
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
              code: "READ_FAILED",
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
              code: "READ_FAILED",
            }),
          ),
    ),
  );

  for (const file of starterFiles) {
    const content = yield* fs.readFile(path.join(starterDir, file)).pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot read starter file ${file}: ${e.message}`,
            code: "READ_FAILED",
          }),
      ),
    );
    if (content.length > 0) {
      yield* fs.writeFile(path.join(principlesDir, file), content).pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({
              message: `Cannot write ${file}: ${e.message}`,
              code: "WRITE_FAILED",
            }),
        ),
      );
    }
  }

  // Copy principles.md index
  const indexSrc = path.join(root, "starter", "principles.md");
  const indexSrcExists = yield* fs.exists(indexSrc).pipe(
    Effect.catch((e) =>
      isNotFound(e)
        ? Effect.succeed(false)
        : Effect.fail(
            new ConfigError({
              message: `Cannot check starter principles.md: ${(e as PlatformError).message}`,
              code: "READ_FAILED",
            }),
          ),
    ),
  );
  if (indexSrcExists) {
    const indexContent = yield* fs.readFile(indexSrc).pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot read starter principles.md: ${e.message}`,
            code: "READ_FAILED",
          }),
      ),
    );
    if (indexContent.length > 0) {
      yield* fs.writeFile(path.join(vaultPath, "principles.md"), indexContent).pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({
              message: `Cannot write principles.md: ${e.message}`,
              code: "WRITE_FAILED",
            }),
        ),
      );
    }
  }
});

const installSkills = Effect.fn("installSkills")(function* (
  fs: FileSystem,
  path: Path,
  force: boolean,
  settingsPath: string,
) {
  // REPO_ROOT injected at compile time by scripts/build.ts
  const sourceDir = path.join(REPO_ROOT, "skills");

  const sourceExists = yield* fs.exists(sourceDir).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new ConfigError({
          message: `Cannot check skills source: ${e.message}`,
          code: "READ_FAILED",
        }),
    ),
  );
  if (!sourceExists) {
    return { installed: [], conflicts: [], target: "" };
  }

  // BRAIN_SKILLS_DIR overrides default; derive ~/.claude from settings path
  const envSkillsDir = process.env["BRAIN_SKILLS_DIR"];
  const targetDir =
    envSkillsDir !== undefined && envSkillsDir.trim() !== ""
      ? envSkillsDir
      : path.join(path.dirname(settingsPath), "skills");

  yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new ConfigError({
          message: `Cannot create skills dir: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  // List source skills
  const sourceEntries = yield* fs.readDirectory(sourceDir).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new ConfigError({
          message: `Cannot read skills source: ${e.message}`,
          code: "READ_FAILED",
        }),
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
          (e: PlatformError) =>
            new ConfigError({ message: `Cannot stat ${entry}: ${e.message}`, code: "READ_FAILED" }),
        ),
      );
    if (stat.type === "Directory") {
      skills.push(entry);
    }
  }

  for (const skill of skills) {
    const targetSkillDir = path.join(targetDir, skill);
    const exists = yield* fs.exists(targetSkillDir).pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot check skill ${skill}: ${e.message}`,
            code: "READ_FAILED",
          }),
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
        (e: PlatformError) =>
          new ConfigError({ message: `Cannot create ${dest}: ${e.message}`, code: "WRITE_FAILED" }),
      ),
    );

  const entries = yield* fs
    .readDirectory(src)
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({ message: `Cannot read ${src}: ${e.message}`, code: "READ_FAILED" }),
      ),
    );

  for (const entry of entries) {
    const srcPath = p.join(src, entry);
    const destPath = p.join(dest, entry);

    const stat = yield* fs.stat(srcPath).pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new ConfigError({
            message: `Cannot stat ${srcPath}: ${e.message}`,
            code: "READ_FAILED",
          }),
      ),
    );

    if (stat.type === "Directory") {
      yield* copyDir(fs, p, srcPath, destPath);
    } else {
      // Binary-safe: use readFile/writeFile instead of readFileString/writeFileString
      const content = yield* fs.readFile(srcPath).pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({
              message: `Cannot read ${srcPath}: ${e.message}`,
              code: "READ_FAILED",
            }),
        ),
      );
      yield* fs.writeFile(destPath, content).pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new ConfigError({
              message: `Cannot write ${destPath}: ${e.message}`,
              code: "WRITE_FAILED",
            }),
        ),
      );
    }
  }
});
