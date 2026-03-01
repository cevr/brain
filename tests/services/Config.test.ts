/** @effect-diagnostics effect/strictEffectProvide:skip-file effect/strictBooleanExpressions:skip-file effect/unnecessaryPipeChain:skip-file */
import { describe, it, expect } from "effect-bun-test";
import { Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { layerNoop } from "effect/FileSystem";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as BunPath from "@effect/platform-bun/BunPath";
import { ConfigService } from "../../src/services/Config.js";

const notFound = () =>
  Effect.fail(
    new PlatformError(
      new SystemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString" }),
    ),
  );

// Minimal noop FS — Config only does exists/readFileString/writeFileString/makeDirectory
const noopFs = layerNoop({
  exists: () => Effect.succeed(false),
  readFileString: () => notFound(),
  writeFileString: () => Effect.void,
  makeDirectory: () => Effect.void,
});

const makeTestLayer = (fsOverrides?: Partial<FileSystem>) =>
  ConfigService.layer.pipe(
    Layer.provide(Layer.mergeAll(fsOverrides ? layerNoop(fsOverrides) : noopFs, BunPath.layer)),
  );

describe("ConfigService", () => {
  describe("globalVaultPath", () => {
    it.live("returns BRAIN_DIR env when set", () => {
      const original = process.env["BRAIN_DIR"];
      process.env["BRAIN_DIR"] = "/custom/brain";
      return Effect.gen(function* () {
        const config = yield* ConfigService;
        const result = yield* config.globalVaultPath();
        expect(result).toBe("/custom/brain");
      })
        .pipe(Effect.provide(makeTestLayer()))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (original === undefined) delete process.env["BRAIN_DIR"];
              else process.env["BRAIN_DIR"] = original;
            }),
          ),
        );
    });

    it.live("falls back to ~/.brain when no env or config", () => {
      const original = process.env["BRAIN_DIR"];
      delete process.env["BRAIN_DIR"];
      return Effect.gen(function* () {
        const config = yield* ConfigService;
        const result = yield* config.globalVaultPath();
        const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
        expect(result).toBe(`${home}/.brain`);
      })
        .pipe(Effect.provide(makeTestLayer()))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (original !== undefined) process.env["BRAIN_DIR"] = original;
            }),
          ),
        );
    });
  });

  describe("loadConfigFile", () => {
    it.live("returns {} when no config exists", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService;
        const result = yield* config.loadConfigFile();
        expect(result).toEqual({});
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.live("parses config file when it exists", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService;
        const result = yield* config.loadConfigFile();
        expect(result).toEqual({ globalVault: "/my/vault" });
      }).pipe(
        Effect.provide(
          makeTestLayer({
            exists: () => Effect.succeed(true),
            readFileString: () => Effect.succeed(JSON.stringify({ globalVault: "/my/vault" })),
            writeFileString: () => Effect.void,
            makeDirectory: () => Effect.void,
          }),
        ),
      ),
    );
  });

  describe("configFilePath", () => {
    it.live("uses XDG_CONFIG_HOME when set", () => {
      // XDG_CONFIG_HOME is captured at layer construction time,
      // so we must set it before building the layer
      const original = process.env["XDG_CONFIG_HOME"];
      process.env["XDG_CONFIG_HOME"] = "/custom/config";
      const layer = makeTestLayer();
      return Effect.gen(function* () {
        const config = yield* ConfigService;
        const result = yield* config.configFilePath();
        expect(result).toBe("/custom/config/brain/config.json");
      })
        .pipe(Effect.provide(layer))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (original === undefined) delete process.env["XDG_CONFIG_HOME"];
              else process.env["XDG_CONFIG_HOME"] = original;
            }),
          ),
        );
    });
  });

  describe("claudeSettingsPath", () => {
    it.live("returns ~/.claude/settings.json", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService;
        const result = yield* config.claudeSettingsPath();
        const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
        expect(result).toBe(`${home}/.claude/settings.json`);
      }).pipe(Effect.provide(makeTestLayer())),
    );
  });
});
