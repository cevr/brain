/** @effect-diagnostics effect/strictEffectProvide:skip-file effect/preferSchemaOverJson:skip-file */
import { describe, it, expect } from "effect-bun-test";
import { Effect, Exit } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { BunServices } from "@effect/platform-bun";
import {
  wireHooks,
  copyStarterPrinciples,
  installSkills,
  copyDir,
} from "../../src/commands/init.js";
import { ConfigError } from "../../src/errors/index.js";
import { BuildInfo } from "../../src/services/BuildInfo.js";
import { withTempDir } from "../helpers/index.js";

const TestLayer = BunServices.layer;

const readSettings = (fs: FileSystem, path: string) =>
  fs.readFileString(path).pipe(Effect.map((s) => JSON.parse(s) as Record<string, unknown>));

describe("wireHooks", () => {
  it.live("adds SessionStart + PostToolUse hooks to empty settings", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const settingsPath = `${dir}/settings.json`;

        const changed = yield* wireHooks(fs, path, settingsPath);

        expect(changed).toBe(true);

        const settings = yield* readSettings(fs, settingsPath);
        const hooks = settings["hooks"] as Record<string, unknown[]>;

        expect(hooks["SessionStart"]).toHaveLength(1);
        expect(hooks["PostToolUse"]).toHaveLength(1);

        const session = hooks["SessionStart"]![0] as {
          matcher: string;
          hooks: Array<{ command: string }>;
        };
        expect(session.matcher).toBe("startup|resume");
        expect(session.hooks[0]!.command).toBe("brain inject");

        const post = hooks["PostToolUse"]![0] as {
          matcher: string;
          hooks: Array<{ command: string }>;
        };
        expect(post.matcher).toBe("brain/");
        expect(post.hooks[0]!.command).toBe("brain reindex");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("preserves existing hooks", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const settingsPath = `${dir}/settings.json`;

        // Pre-existing settings with a custom hook
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            hooks: {
              SessionStart: [{ matcher: ".*", hooks: [{ type: "command", command: "echo hi" }] }],
            },
          }),
        );

        yield* wireHooks(fs, path, settingsPath);

        const settings = yield* readSettings(fs, settingsPath);
        const hooks = settings["hooks"] as Record<string, unknown[]>;

        // Original hook preserved + brain inject added
        expect(hooks["SessionStart"]).toHaveLength(2);
        const first = hooks["SessionStart"]![0] as { hooks: Array<{ command: string }> };
        expect(first.hooks[0]!.command).toBe("echo hi");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("updates matcher on existing brain inject hook", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const settingsPath = `${dir}/settings.json`;

        // Hook exists but with old matcher
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            hooks: {
              SessionStart: [
                { matcher: "old-matcher", hooks: [{ type: "command", command: "brain inject" }] },
              ],
              PostToolUse: [
                { matcher: "brain/", hooks: [{ type: "command", command: "brain reindex" }] },
              ],
            },
          }),
        );

        const changed = yield* wireHooks(fs, path, settingsPath);

        expect(changed).toBe(true);

        const settings = yield* readSettings(fs, settingsPath);
        const hooks = settings["hooks"] as Record<string, unknown[]>;
        const session = hooks["SessionStart"]![0] as { matcher: string };
        expect(session.matcher).toBe("startup|resume");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("is idempotent — no change on second run", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const settingsPath = `${dir}/settings.json`;

        yield* wireHooks(fs, path, settingsPath);
        const secondChanged = yield* wireHooks(fs, path, settingsPath);

        expect(secondChanged).toBe(false);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  for (const [label, content] of [
    ["null", "null"],
    ["array", "[]"],
    ["boolean", "true"],
  ] as const) {
    it.live(`rejects malformed settings.json (${label})`, () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const path = yield* Path;
          const settingsPath = `${dir}/settings.json`;

          yield* fs.writeFileString(settingsPath, content);

          const exit = yield* wireHooks(fs, path, settingsPath).pipe(Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const reasons = exit.cause.reasons as unknown as ReadonlyArray<{ error: unknown }>;
            expect(reasons[0]!.error).toBeInstanceOf(ConfigError);
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  }

  it.live("warns and returns false when hooks is not an object", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const settingsPath = `${dir}/settings.json`;

        // hooks is a string instead of an object
        yield* fs.writeFileString(settingsPath, JSON.stringify({ hooks: "not-an-object" }));

        const changed = yield* wireHooks(fs, path, settingsPath);
        expect(changed).toBe(false);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("treats non-array hook value as empty array", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const settingsPath = `${dir}/settings.json`;

        // SessionStart is a string, not an array — should be treated as empty
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({ hooks: { SessionStart: "not-array" } }),
        );

        const changed = yield* wireHooks(fs, path, settingsPath);
        expect(changed).toBe(true);

        const settings = yield* readSettings(fs, settingsPath);
        const hooks = settings["hooks"] as Record<string, unknown[]>;
        // brain inject was added even though SessionStart was malformed
        expect(hooks["SessionStart"]).toHaveLength(1);
        const session = hooks["SessionStart"]![0] as { hooks: Array<{ command: string }> };
        expect(session.hooks[0]!.command).toBe("brain inject");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});

describe("starter principles", () => {
  it.live("copies starter files to empty principles dir", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        // Set up a fake repo root with starter dir
        const fakeRoot = `${dir}/repo`;
        const starterDir = `${fakeRoot}/starter/principles`;
        const vaultDir = `${dir}/vault`;
        const principlesDir = `${vaultDir}/principles`;

        yield* fs.makeDirectory(starterDir, { recursive: true });
        yield* fs.makeDirectory(principlesDir, { recursive: true });

        yield* fs.writeFileString(`${starterDir}/first.md`, "# First Principle\n");
        yield* fs.writeFileString(`${starterDir}/second.md`, "# Second Principle\n");
        // Also create principles.md index in starter
        yield* fs.writeFileString(`${fakeRoot}/starter/principles.md`, "# Principles Index\n");

        yield* copyStarterPrinciples(fs, path, vaultDir).pipe(
          Effect.provide(BuildInfo.layerTest({ repoRoot: fakeRoot })),
        );

        const copied = yield* fs.readDirectory(principlesDir);
        expect(copied.sort()).toEqual(["first.md", "second.md"]);

        const content = yield* fs.readFileString(`${principlesDir}/first.md`);
        expect(content).toBe("# First Principle\n");

        // principles.md index was also copied
        const indexContent = yield* fs.readFileString(`${vaultDir}/principles.md`);
        expect(indexContent).toBe("# Principles Index\n");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("does NOT copy when principles/ is non-empty", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        const fakeRoot = `${dir}/repo`;
        const starterDir = `${fakeRoot}/starter/principles`;
        const vaultDir = `${dir}/vault`;
        const principlesDir = `${vaultDir}/principles`;

        yield* fs.makeDirectory(starterDir, { recursive: true });
        yield* fs.makeDirectory(principlesDir, { recursive: true });

        yield* fs.writeFileString(`${starterDir}/starter.md`, "# Starter\n");
        // Pre-existing file in principles
        yield* fs.writeFileString(`${principlesDir}/existing.md`, "# Existing\n");

        yield* copyStarterPrinciples(fs, path, vaultDir).pipe(
          Effect.provide(BuildInfo.layerTest({ repoRoot: fakeRoot })),
        );

        const files = yield* fs.readDirectory(principlesDir);
        expect(files).toEqual(["existing.md"]);
        expect(files).not.toContain("starter.md");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});

describe("copyDir", () => {
  it.live("copies files recursively", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        const src = `${dir}/src`;
        const dest = `${dir}/dest`;

        yield* fs.makeDirectory(`${src}/nested`, { recursive: true });
        yield* fs.writeFileString(`${src}/a.txt`, "alpha");
        yield* fs.writeFileString(`${src}/nested/b.txt`, "beta");

        yield* copyDir(fs, path, src, dest);

        const aContent = yield* fs.readFileString(`${dest}/a.txt`);
        expect(aContent).toBe("alpha");

        const bContent = yield* fs.readFileString(`${dest}/nested/b.txt`);
        expect(bContent).toBe("beta");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("overwrites existing files at destination", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        const src = `${dir}/src`;
        const dest = `${dir}/dest`;

        yield* fs.makeDirectory(src, { recursive: true });
        yield* fs.makeDirectory(dest, { recursive: true });
        yield* fs.writeFileString(`${src}/file.txt`, "new content");
        yield* fs.writeFileString(`${dest}/file.txt`, "old content");

        yield* copyDir(fs, path, src, dest);

        const content = yield* fs.readFileString(`${dest}/file.txt`);
        expect(content).toBe("new content");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});

describe("installSkills", () => {
  it.live("copies skill directories from source to target", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        // Set up a fake repo root with a skill
        const fakeRoot = `${dir}/repo`;
        yield* fs.makeDirectory(`${fakeRoot}/skills/brain`, { recursive: true });
        yield* fs.writeFileString(`${fakeRoot}/skills/brain/SKILL.md`, "# Brain Skill\n");

        const settingsPath = `${dir}/claude/settings.json`;
        yield* fs.makeDirectory(`${dir}/claude`, { recursive: true });

        const origSkillsDir = process.env["BRAIN_SKILLS_DIR"];
        const targetDir = `${dir}/skills-target`;
        process.env["BRAIN_SKILLS_DIR"] = targetDir;

        const result = yield* installSkills(fs, path, false, settingsPath).pipe(
          Effect.provide(BuildInfo.layerTest({ repoRoot: fakeRoot })),
          Effect.ensuring(
            Effect.sync(() => {
              if (origSkillsDir === undefined) delete process.env["BRAIN_SKILLS_DIR"];
              else process.env["BRAIN_SKILLS_DIR"] = origSkillsDir;
            }),
          ),
        );

        expect(result.installed).toContain("brain");
        expect(result.conflicts).toHaveLength(0);

        const skillContent = yield* fs.readFileString(`${targetDir}/brain/SKILL.md`);
        expect(skillContent).toBe("# Brain Skill\n");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("detects conflicts and skips without --force", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        const fakeRoot = `${dir}/repo`;
        yield* fs.makeDirectory(`${fakeRoot}/skills/brain`, { recursive: true });
        yield* fs.writeFileString(`${fakeRoot}/skills/brain/SKILL.md`, "# New\n");

        const settingsPath = `${dir}/claude/settings.json`;
        yield* fs.makeDirectory(`${dir}/claude`, { recursive: true });

        const origSkillsDir = process.env["BRAIN_SKILLS_DIR"];
        const targetDir = `${dir}/skills-target`;
        process.env["BRAIN_SKILLS_DIR"] = targetDir;

        // Pre-existing skill
        yield* fs.makeDirectory(`${targetDir}/brain`, { recursive: true });
        yield* fs.writeFileString(`${targetDir}/brain/SKILL.md`, "# Existing\n");

        const result = yield* installSkills(fs, path, false, settingsPath).pipe(
          Effect.provide(BuildInfo.layerTest({ repoRoot: fakeRoot })),
          Effect.ensuring(
            Effect.sync(() => {
              if (origSkillsDir === undefined) delete process.env["BRAIN_SKILLS_DIR"];
              else process.env["BRAIN_SKILLS_DIR"] = origSkillsDir;
            }),
          ),
        );

        expect(result.installed).toHaveLength(0);
        expect(result.conflicts).toContain("brain");

        // Original content preserved
        const content = yield* fs.readFileString(`${targetDir}/brain/SKILL.md`);
        expect(content).toBe("# Existing\n");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("--force-skills overwrites existing", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;

        const fakeRoot = `${dir}/repo`;
        yield* fs.makeDirectory(`${fakeRoot}/skills/brain`, { recursive: true });
        yield* fs.writeFileString(`${fakeRoot}/skills/brain/SKILL.md`, "# Updated\n");

        const settingsPath = `${dir}/claude/settings.json`;
        yield* fs.makeDirectory(`${dir}/claude`, { recursive: true });

        const origSkillsDir = process.env["BRAIN_SKILLS_DIR"];
        const targetDir = `${dir}/skills-target`;
        process.env["BRAIN_SKILLS_DIR"] = targetDir;

        yield* fs.makeDirectory(`${targetDir}/brain`, { recursive: true });
        yield* fs.writeFileString(`${targetDir}/brain/SKILL.md`, "# Old\n");

        const result = yield* installSkills(fs, path, true, settingsPath).pipe(
          Effect.provide(BuildInfo.layerTest({ repoRoot: fakeRoot })),
          Effect.ensuring(
            Effect.sync(() => {
              if (origSkillsDir === undefined) delete process.env["BRAIN_SKILLS_DIR"];
              else process.env["BRAIN_SKILLS_DIR"] = origSkillsDir;
            }),
          ),
        );

        expect(result.installed).toContain("brain");
        expect(result.conflicts).toHaveLength(0);

        const content = yield* fs.readFileString(`${targetDir}/brain/SKILL.md`);
        expect(content).toBe("# Updated\n");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});
