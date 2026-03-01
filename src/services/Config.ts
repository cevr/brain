import { Console, Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ConfigError } from "../errors/index.js";

const ConfigFileSchema = Schema.Struct({
  globalVault: Schema.optional(Schema.String),
});

type ConfigFile = typeof ConfigFileSchema.Type;

const ConfigFileJson = Schema.fromJsonString(ConfigFileSchema);
const decodeConfigFile = Schema.decodeUnknownEffect(ConfigFileJson);
const encodeConfigFile = Schema.encodeEffect(ConfigFileJson);

export class ConfigService extends ServiceMap.Service<
  ConfigService,
  {
    readonly globalVaultPath: () => Effect.Effect<string, ConfigError>;
    readonly projectVaultPath: () => Effect.Effect<Option.Option<string>, ConfigError>;
    readonly activeVaultPath: () => Effect.Effect<string, ConfigError>;
    readonly configFilePath: () => Effect.Effect<string, ConfigError>;
    readonly claudeSettingsPath: () => Effect.Effect<string, ConfigError>;
    readonly loadConfigFile: () => Effect.Effect<ConfigFile, ConfigError>;
    readonly saveConfigFile: (config: ConfigFile) => Effect.Effect<void, ConfigError>;
  }
>()("@cvr/brain/services/Config/ConfigService") {
  static layer: Layer.Layer<ConfigService, never, FileSystem | Path> = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;

      const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
      const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");

      const resolveConfigFilePath = () =>
        Effect.succeed(path.join(xdgConfig, "brain", "config.json"));

      const loadConfigFile = Effect.fn("ConfigService.loadConfigFile")(function* () {
        const cfgPath = path.join(xdgConfig, "brain", "config.json");
        const exists = yield* fs
          .exists(cfgPath)
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({ message: `Cannot check config: ${e.message}` }),
            ),
          );
        if (!exists) return {};
        const text = yield* fs
          .readFileString(cfgPath)
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({ message: `Cannot read config: ${e.message}` }),
            ),
          );
        return yield* decodeConfigFile(text).pipe(
          Effect.catch((e) =>
            Console.error(`Warning: corrupt config, using defaults: ${e}`).pipe(Effect.as({})),
          ),
        );
      });

      const globalVaultPath = Effect.fn("ConfigService.globalVaultPath")(function* () {
        const envDir = process.env["BRAIN_DIR"];
        if (envDir !== undefined) return envDir;

        const cfg = yield* loadConfigFile();
        if (cfg.globalVault !== undefined) return cfg.globalVault;

        return path.join(home, ".brain");
      });

      const projectVaultPath = Effect.fn("ConfigService.projectVaultPath")(function* () {
        const explicit = process.env["BRAIN_PROJECT_DIR"];
        if (explicit !== undefined) {
          const exists = yield* fs
            .exists(explicit)
            .pipe(
              Effect.mapError(
                (e: PlatformError) =>
                  new ConfigError({ message: `Cannot check project vault: ${e.message}` }),
              ),
            );
          return exists ? Option.some(explicit) : Option.none<string>();
        }

        const claudeDir = process.env["CLAUDE_PROJECT_DIR"];
        if (claudeDir !== undefined) {
          const brainDir = path.join(claudeDir, "brain");
          const exists = yield* fs
            .exists(brainDir)
            .pipe(
              Effect.mapError(
                (e: PlatformError) =>
                  new ConfigError({ message: `Cannot check project vault: ${e.message}` }),
              ),
            );
          return exists ? Option.some(brainDir) : Option.none<string>();
        }

        const cwd = process.cwd();
        const cwdBrain = path.join(cwd, "brain");
        const exists = yield* fs
          .exists(cwdBrain)
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({ message: `Cannot check project vault: ${e.message}` }),
            ),
          );
        return exists ? Option.some(cwdBrain) : Option.none<string>();
      });

      const activeVaultPath = Effect.fn("ConfigService.activeVaultPath")(function* () {
        const project = yield* projectVaultPath();
        if (Option.isSome(project)) return project.value;
        return yield* globalVaultPath();
      });

      const claudeSettingsPath = () => Effect.succeed(path.join(home, ".claude", "settings.json"));

      const saveConfigFile = Effect.fn("ConfigService.saveConfigFile")(function* (
        config: ConfigFile,
      ) {
        const cfgPath = yield* resolveConfigFilePath();
        const dir = path.dirname(cfgPath);
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({ message: `Cannot create config dir: ${e.message}` }),
            ),
          );
        const text = yield* encodeConfigFile(config).pipe(
          Effect.mapError(() => new ConfigError({ message: "Cannot encode config" })),
        );
        yield* fs
          .writeFileString(cfgPath, text + "\n")
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new ConfigError({ message: `Cannot write config: ${e.message}` }),
            ),
          );
      });

      return {
        globalVaultPath,
        projectVaultPath,
        activeVaultPath,
        configFilePath: resolveConfigFilePath,
        claudeSettingsPath,
        loadConfigFile,
        saveConfigFile,
      };
    }),
  );
}
