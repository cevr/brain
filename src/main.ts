#!/usr/bin/env bun
import { Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { command } from "./commands/index.js";
import { ConfigService } from "./services/Config.js";
import { VaultService } from "./services/Vault.js";
import { BuildInfo } from "./services/BuildInfo.js";
import { AgentPlatformService } from "./services/AgentPlatform.js";
import { ClaudeService } from "./services/Claude.js";

const APP_ERROR_TAGS = new Set([
  "@cvr/brain/BrainError",
  "@cvr/brain/VaultError",
  "@cvr/brain/ConfigError",
]);

const isAppError = (e: unknown): e is { _tag: string; code?: string; message: string } =>
  typeof e === "object" &&
  e !== null &&
  "_tag" in e &&
  APP_ERROR_TAGS.has((e as { _tag: string })._tag);

const cli = Command.run(command, {
  version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "0.0.0-dev",
});

const CoreLayer = Layer.mergeAll(ConfigService.layer, VaultService.layer, BuildInfo.layer).pipe(
  Layer.provideMerge(BunServices.layer),
);

const ServiceLayer = Layer.mergeAll(
  CoreLayer,
  ClaudeService.layer,
  AgentPlatformService.layer.pipe(
    Layer.provide(ConfigService.layer),
    Layer.provideMerge(BunServices.layer),
  ),
);

const wantsJson = process.argv.includes("--json");

const program = cli.pipe(
  Effect.tapCause((cause) =>
    Effect.gen(function* () {
      for (const reason of cause.reasons) {
        if (reason._tag !== "Fail") continue;
        const err = reason.error;
        if (!isAppError(err)) continue;
        if (wantsJson) {
          // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
          yield* Console.log(
            JSON.stringify({ error: err._tag, code: err.code ?? null, message: err.message }),
          );
        } else {
          yield* Console.error(err.message);
        }
      }
    }),
  ),
);

// @effect-diagnostics-next-line effect/strictEffectProvide:off
BunRuntime.runMain(program.pipe(Effect.provide(ServiceLayer)), { disableErrorReporting: true });
