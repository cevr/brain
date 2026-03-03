/** @effect-diagnostics effect/strictEffectProvide:skip-file effect/preferSchemaOverJson:skip-file */
import { describe, it, expect } from "effect-bun-test";
import { Effect, Layer, Option, Ref } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { BunServices } from "@effect/platform-bun";
import { utimesSync } from "node:fs";
import { withTempDir } from "../../helpers/index.js";
import { scanSessions, runReflect } from "../../../src/commands/daemon/reflect.js";
import { readState, type DaemonState } from "../../../src/commands/daemon/state.js";
import { BrainError } from "../../../src/errors/index.js";
import { ClaudeService, type ClaudeInvocation } from "../../../src/services/Claude.js";
import { ConfigService } from "../../../src/services/Config.js";
import { VaultService } from "../../../src/services/Vault.js";

const TestLayer = BunServices.layer;

// Dashify: `/foo/bar` → `-foo-bar`, `/.hidden` → `--hidden`
const dashify = (p: string) => p.replaceAll("/.", "--").replaceAll("/", "-");

// Build a Claude-style dashified dir name from a temp dir + project name.
// deriveProjectName will find `parentDir` as an existing prefix → returns `projectName`.
const fakeDirName = (parentDir: string, projectName: string) =>
  `${dashify(parentDir)}-${projectName}`;

// Helper: create a JSONL file with lines
const writeJsonl = (fs: FileSystem, filePath: string, lines: Record<string, unknown>[]) =>
  fs.writeFileString(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const userMsg = (content: string) => ({
  type: "user",
  message: { content },
});

const assistantMsg = (content: string) => ({
  type: "assistant",
  message: { content },
});

// Build a fake ~/.claude/projects/<dirName>/ with JSONL files
const setupProjectSessions = Effect.fn("setupProjectSessions")(function* (
  homeDir: string,
  dirName: string,
  sessions: Array<{ name: string; mtime: Date; messages: Record<string, unknown>[] }>,
) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const projectDir = path.join(homeDir, ".claude", "projects", dirName);
  yield* fs.makeDirectory(projectDir, { recursive: true });

  for (const session of sessions) {
    const filePath = path.join(projectDir, session.name);
    yield* writeJsonl(fs, filePath, session.messages);
    utimesSync(filePath, session.mtime, session.mtime);
  }
});

const oldDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago — settled
const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago — not settled

const bigMessages = [
  userMsg("User message that is definitely long enough to pass the content length filter check"),
  assistantMsg("Assistant reply that is definitely long enough to pass the content length filter"),
  { type: "padding", message: { content: "x".repeat(500) } },
];

const makeConfigLayer = (dir: string, brainDir: string) =>
  Layer.succeed(ConfigService, {
    globalVaultPath: () => Effect.succeed(brainDir),
    projectVaultPath: () => Effect.succeed(Option.none()),
    activeVaultPath: () => Effect.succeed(brainDir),
    currentProjectName: () => Effect.succeed(Option.none()),
    configFilePath: () => Effect.succeed(`${dir}/config.json`),
    claudeSettingsPath: () => Effect.succeed(`${dir}/settings.json`),
    loadConfigFile: () => Effect.succeed({}),
    saveConfigFile: () => Effect.void,
  });

const makeTestLayers = (
  dir: string,
  brainDir: string,
  invocations: Ref.Ref<Array<ClaudeInvocation>>,
) =>
  Layer.mergeAll(
    makeConfigLayer(dir, brainDir),
    VaultService.layer,
    ClaudeService.layerTest(invocations),
  ).pipe(Layer.provideMerge(BunServices.layer));

describe("daemon reflect", () => {
  describe("scanSessions", () => {
    it.live("finds settled, unprocessed sessions", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;
            const dn = fakeDirName(dir, "project-alpha");

            yield* setupProjectSessions(dir, dn, [
              { name: "session1.jsonl", mtime: oldDate, messages: bigMessages },
              { name: "session2.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const groups = yield* scanSessions({ reflect: {}, ruminate: {}, meditate: {} });

            expect(groups).toHaveLength(1);
            expect(groups[0]?.projectName).toBe("project-alpha");
            expect(groups[0]?.sessions).toHaveLength(2);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("skips active sessions (mtime < 30 min)", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;
            const dn = fakeDirName(dir, "project-beta");

            yield* setupProjectSessions(dir, dn, [
              { name: "active.jsonl", mtime: recentDate, messages: bigMessages },
              { name: "settled.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const groups = yield* scanSessions({ reflect: {}, ruminate: {}, meditate: {} });

            expect(groups).toHaveLength(1);
            expect(groups[0]?.sessions).toHaveLength(1);
            expect(groups[0]?.sessions[0]?.name).toBe("settled.jsonl");
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("skips already-processed sessions with same mtime", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;
            const dn = fakeDirName(dir, "project-gamma");

            yield* setupProjectSessions(dir, dn, [
              { name: "done.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const state: DaemonState = {
              reflect: {
                processedSessions: {
                  [`${dn}/done.jsonl`]: oldDate.toISOString(),
                },
              },
              ruminate: {},
              meditate: {},
            };

            const groups = yield* scanSessions(state);
            expect(groups).toHaveLength(0);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("re-processes sessions when mtime changed", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;
            const dn = fakeDirName(dir, "project-delta");

            yield* setupProjectSessions(dir, dn, [
              { name: "changed.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const state: DaemonState = {
              reflect: {
                processedSessions: {
                  [`${dn}/changed.jsonl`]: "2024-01-01T00:00:00.000Z",
                },
              },
              ruminate: {},
              meditate: {},
            };

            const groups = yield* scanSessions(state);
            expect(groups).toHaveLength(1);
            expect(groups[0]?.sessions).toHaveLength(1);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("returns empty when no projects dir exists", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;
            // Don't create .claude/projects/
            const groups = yield* scanSessions({ reflect: {}, ruminate: {}, meditate: {} });
            expect(groups).toHaveLength(0);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("groups sessions by project", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;

            yield* setupProjectSessions(dir, fakeDirName(dir, "project-one"), [
              { name: "s1.jsonl", mtime: oldDate, messages: bigMessages },
            ]);
            yield* setupProjectSessions(dir, fakeDirName(dir, "project-two"), [
              { name: "s2.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const groups = yield* scanSessions({ reflect: {}, ruminate: {}, meditate: {} });
            expect(groups).toHaveLength(2);

            const names = groups.map((g) => g.projectName).sort();
            expect(names).toEqual(["project-one", "project-two"]);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("runReflect", () => {
    it.live("invokes claude with file paths and checkpoints state", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;
            const dn = fakeDirName(dir, "myproject");

            const brainDir = `${dir}/.brain`;
            const fs = yield* FileSystem;
            yield* fs.makeDirectory(`${brainDir}/projects`, { recursive: true });
            yield* fs.writeFileString(`${brainDir}/index.md`, "# Brain\n");

            yield* setupProjectSessions(dir, dn, [
              { name: "conv.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const invocations = yield* Ref.make<Array<ClaudeInvocation>>([]);
            const layers = makeTestLayers(dir, brainDir, invocations);

            yield* runReflect().pipe(Effect.provide(layers));

            const calls = yield* Ref.get(invocations);
            expect(calls.length).toBeGreaterThanOrEqual(1);
            expect(calls[0]?.model).toBe("sonnet");
            expect(calls[0]?.prompt).toContain("/reflect");
            expect(calls[0]?.prompt).toContain(".jsonl");
            expect(calls[0]?.prompt).toContain("Session files for project");

            const state = yield* readState(brainDir).pipe(Effect.provide(layers));
            expect(state.reflect?.lastRun).toBeDefined();
            expect(state.reflect?.processedSessions?.[`${dn}/conv.jsonl`]).toBeDefined();
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("is idempotent — skips already-processed sessions", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;

            const brainDir = `${dir}/.brain`;
            const fs = yield* FileSystem;
            yield* fs.makeDirectory(`${brainDir}/projects`, { recursive: true });
            yield* fs.writeFileString(`${brainDir}/index.md`, "# Brain\n");

            yield* setupProjectSessions(dir, fakeDirName(dir, "idempotent"), [
              { name: "conv.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            const invocations = yield* Ref.make<Array<ClaudeInvocation>>([]);
            const layers = makeTestLayers(dir, brainDir, invocations);

            // First run
            yield* runReflect().pipe(Effect.provide(layers));
            const firstCalls = yield* Ref.get(invocations);
            expect(firstCalls.length).toBeGreaterThanOrEqual(1);

            // Reset invocation tracker
            yield* Ref.set(invocations, []);

            // Second run — should skip
            yield* runReflect().pipe(Effect.provide(layers));
            const secondCalls = yield* Ref.get(invocations);
            expect(secondCalls).toHaveLength(0);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("releases lock even when claude fails", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;

            const brainDir = `${dir}/.brain`;
            const fs = yield* FileSystem;
            yield* fs.makeDirectory(`${brainDir}/projects`, { recursive: true });
            yield* fs.writeFileString(`${brainDir}/index.md`, "# Brain\n");

            yield* setupProjectSessions(dir, fakeDirName(dir, "locktest"), [
              { name: "conv.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            // Claude layer that always fails
            const failingClaude = Layer.succeed(ClaudeService, {
              invoke: () =>
                Effect.fail(new BrainError({ message: "Claude crashed", code: "SPAWN_FAILED" })),
            });

            const layers = Layer.mergeAll(
              makeConfigLayer(dir, brainDir),
              VaultService.layer,
              failingClaude,
            ).pipe(Layer.provideMerge(BunServices.layer));

            // Should not throw — error is caught per-group
            yield* runReflect().pipe(Effect.provide(layers));

            // Lock should be released
            const lockPath = `${brainDir}/.daemon-reflect.lock`;
            const lockExists = yield* fs
              .exists(lockPath)
              .pipe(Effect.catch(() => Effect.succeed(false)));
            expect(lockExists).toBe(false);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("continues to next group when one fails", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const origHome = process.env["HOME"];
          try {
            process.env["HOME"] = dir;

            const brainDir = `${dir}/.brain`;
            const fs = yield* FileSystem;
            yield* fs.makeDirectory(`${brainDir}/projects`, { recursive: true });
            yield* fs.writeFileString(`${brainDir}/index.md`, "# Brain\n");

            // Two projects
            yield* setupProjectSessions(dir, fakeDirName(dir, "project-fail"), [
              { name: "s1.jsonl", mtime: oldDate, messages: bigMessages },
            ]);
            yield* setupProjectSessions(dir, fakeDirName(dir, "project-succeed"), [
              { name: "s2.jsonl", mtime: oldDate, messages: bigMessages },
            ]);

            let callCount = 0;
            // Claude that fails on first invocation, succeeds on second
            const flakyClaudeLayer = Layer.succeed(ClaudeService, {
              invoke: () =>
                Effect.suspend(() => {
                  callCount++;
                  if (callCount === 1) {
                    return Effect.fail(
                      new BrainError({ message: "First call fails", code: "SPAWN_FAILED" }),
                    );
                  }
                  return Effect.void;
                }),
            });

            const layers = Layer.mergeAll(
              makeConfigLayer(dir, brainDir),
              VaultService.layer,
              flakyClaudeLayer,
            ).pipe(Layer.provideMerge(BunServices.layer));

            yield* runReflect().pipe(Effect.provide(layers));

            // Should have called claude twice (once per group)
            expect(callCount).toBe(2);

            // The succeeding group's sessions should be checkpointed
            const state = yield* readState(brainDir).pipe(Effect.provide(layers));
            const processed = state.reflect?.processedSessions ?? {};
            // One group succeeded, one failed — at least one session should be checkpointed
            const processedKeys = Object.keys(processed);
            expect(processedKeys.length).toBeGreaterThanOrEqual(1);
          } finally {
            process.env["HOME"] = origHome;
          }
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });
});
