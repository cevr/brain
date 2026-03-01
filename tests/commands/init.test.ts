/** @effect-diagnostics effect/strictEffectProvide:skip-file effect/preferSchemaOverJson:skip-file */
import { describe, it, expect } from "effect-bun-test";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { BunServices } from "@effect/platform-bun";
import { wireHooks } from "../../src/commands/init.js";

const TestLayer = BunServices.layer;

const withTempDir = <A, E>(fn: (dir: string) => Effect.Effect<A, E, FileSystem | Path>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    return yield* fn(dir);
  }).pipe(Effect.scoped);

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
});

describe("starter principles", () => {
  it.live("copies starter files to empty principles dir", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;

        // Simulate a starter dir and an empty principles dir
        const starterDir = `${dir}/starter/principles`;
        const vaultDir = `${dir}/vault`;
        const principlesDir = `${vaultDir}/principles`;

        yield* fs.makeDirectory(starterDir, { recursive: true });
        yield* fs.makeDirectory(principlesDir, { recursive: true });

        yield* fs.writeFileString(`${starterDir}/first.md`, "# First Principle\n");
        yield* fs.writeFileString(`${starterDir}/second.md`, "# Second Principle\n");

        // Replicate copyStarterPrinciples logic
        const starterExists = yield* fs.exists(starterDir);
        if (starterExists) {
          const entries = yield* fs.readDirectory(principlesDir);
          if (entries.length === 0) {
            const starterFiles = yield* fs.readDirectory(starterDir);
            for (const file of starterFiles) {
              const content = yield* fs.readFile(`${starterDir}/${file}`);
              yield* fs.writeFile(`${principlesDir}/${file}`, content);
            }
          }
        }

        const copied = yield* fs.readDirectory(principlesDir);
        expect(copied.sort()).toEqual(["first.md", "second.md"]);

        const content = yield* fs.readFileString(`${principlesDir}/first.md`);
        expect(content).toBe("# First Principle\n");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.live("does NOT copy when principles/ is non-empty", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;

        const starterDir = `${dir}/starter/principles`;
        const vaultDir = `${dir}/vault`;
        const principlesDir = `${vaultDir}/principles`;

        yield* fs.makeDirectory(starterDir, { recursive: true });
        yield* fs.makeDirectory(principlesDir, { recursive: true });

        yield* fs.writeFileString(`${starterDir}/starter.md`, "# Starter\n");
        // Pre-existing file in principles
        yield* fs.writeFileString(`${principlesDir}/existing.md`, "# Existing\n");

        // Replicate copyStarterPrinciples logic
        const starterExists = yield* fs.exists(starterDir);
        if (starterExists) {
          const entries = yield* fs.readDirectory(principlesDir);
          if (entries.length === 0) {
            const starterFiles = yield* fs.readDirectory(starterDir);
            for (const file of starterFiles) {
              const content = yield* fs.readFile(`${starterDir}/${file}`);
              yield* fs.writeFile(`${principlesDir}/${file}`, content);
            }
          }
        }

        const files = yield* fs.readDirectory(principlesDir);
        expect(files).toEqual(["existing.md"]);
        expect(files).not.toContain("starter.md");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});
