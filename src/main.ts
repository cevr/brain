#!/usr/bin/env bun
import { Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { command } from "./commands/index.js";
import { ConfigService } from "./services/Config.js";
import { VaultService } from "./services/Vault.js";

const cli = Command.run(command, {
  version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "0.0.0-dev",
});

const ServiceLayer = Layer.mergeAll(ConfigService.layer, VaultService.layer);

const AppLayer = ServiceLayer.pipe(Layer.provideMerge(BunServices.layer));

// @effect-diagnostics-next-line effect/strictEffectProvide:off
BunRuntime.runMain(cli.pipe(Effect.provide(AppLayer)));
