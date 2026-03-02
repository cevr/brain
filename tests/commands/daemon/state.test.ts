/** @effect-diagnostics effect/strictEffectProvide:skip-file effect/preferSchemaOverJson:skip-file */
import { describe, it, expect } from "effect-bun-test";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { BunServices } from "@effect/platform-bun";
import { withTempDir } from "../../helpers/index.js";
import {
  readState,
  writeState,
  acquireLock,
  releaseLock,
  isSettled,
  deriveProjectName,
} from "../../../src/commands/daemon/state.js";

const TestLayer = BunServices.layer;

describe("daemon state", () => {
  describe("readState / writeState", () => {
    it.live("returns default state when file is missing", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const state = yield* readState(dir);
          expect(state.reflect).toEqual({});
          expect(state.ruminate).toEqual({});
          expect(state.meditate).toEqual({});
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("roundtrips state through write + read", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const original = {
            reflect: {
              lastRun: "2024-06-01T00:00:00.000Z",
              processedSessions: { "proj/session.jsonl": "2024-06-01T00:00:00.000Z" },
            },
            ruminate: { lastRun: "2024-05-01T00:00:00.000Z" },
            meditate: { lastRun: "2024-04-01T00:00:00.000Z" },
          };

          yield* writeState(dir, original);
          const loaded = yield* readState(dir);

          expect(loaded.reflect?.lastRun).toBe("2024-06-01T00:00:00.000Z");
          expect(loaded.reflect?.processedSessions?.["proj/session.jsonl"]).toBe(
            "2024-06-01T00:00:00.000Z",
          );
          expect(loaded.ruminate?.lastRun).toBe("2024-05-01T00:00:00.000Z");
          expect(loaded.meditate?.lastRun).toBe("2024-04-01T00:00:00.000Z");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("returns default state when file is corrupt", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          yield* fs.writeFileString(`${dir}/.daemon.json`, "not valid json{{{");

          const state = yield* readState(dir);
          expect(state.reflect).toEqual({});
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("acquireLock / releaseLock", () => {
    it.live("acquires and releases a lock", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;

          yield* acquireLock(dir, "reflect");

          // Lock file should exist with our PID
          const content = yield* fs.readFileString(`${dir}/.daemon-reflect.lock`);
          expect(content.trim()).toBe(String(process.pid));

          yield* releaseLock(dir, "reflect");

          const exists = yield* fs.exists(`${dir}/.daemon-reflect.lock`);
          expect(exists).toBe(false);
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("acquires lock when stale (dead PID)", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;

          // Write a lock with a PID that definitely doesn't exist
          yield* fs.writeFileString(`${dir}/.daemon-reflect.lock`, "999999999\n");

          // Should succeed — stale lock
          yield* acquireLock(dir, "reflect");

          const content = yield* fs.readFileString(`${dir}/.daemon-reflect.lock`);
          expect(content.trim()).toBe(String(process.pid));
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("fails when lock is held by a live process", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;

          // Write a lock with our own PID (which is alive)
          yield* fs.writeFileString(`${dir}/.daemon-reflect.lock`, `${process.pid}\n`);

          const exit = yield* acquireLock(dir, "reflect").pipe(Effect.exit);

          expect(exit._tag).toBe("Failure");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("isSettled", () => {
    it.live("returns true for mtime > 30 min ago", () =>
      Effect.sync(() => {
        const old = new Date(Date.now() - 31 * 60 * 1000);
        expect(isSettled(old)).toBe(true);
      }),
    );

    it.live("returns false for mtime < 30 min ago", () =>
      Effect.sync(() => {
        const recent = new Date(Date.now() - 5 * 60 * 1000);
        expect(isSettled(recent)).toBe(false);
      }),
    );

    it.live("returns false for mtime exactly now", () =>
      Effect.sync(() => {
        expect(isSettled(new Date())).toBe(false);
      }),
    );
  });

  describe("deriveProjectName", () => {
    it.live("extracts last segment from dashified path", () =>
      Effect.sync(() => {
        expect(deriveProjectName("-Users-cvr-Developer-personal-brain")).toBe("brain");
      }),
    );

    it.live("handles simple names", () =>
      Effect.sync(() => {
        expect(deriveProjectName("my-project")).toBe("project");
      }),
    );

    it.live("handles single segment", () =>
      Effect.sync(() => {
        expect(deriveProjectName("brain")).toBe("brain");
      }),
    );

    it.live("handles empty string", () =>
      Effect.sync(() => {
        expect(deriveProjectName("")).toBe("");
      }),
    );

    it.live("handles leading dash only", () =>
      Effect.sync(() => {
        expect(deriveProjectName("-")).toBe("-");
      }),
    );
  });
});
