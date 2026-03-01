#!/usr/bin/env bun
import { Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { command } from "./commands/index.js";
import { ConfigService } from "./services/Config.js";
import { VaultService } from "./services/Vault.js";

const cli = Command.run(command, {
  version: "0.1.0",
});

const ServiceLayer = Layer.mergeAll(ConfigService.layer, VaultService.layer);

const AppLayer = ServiceLayer.pipe(Layer.provideMerge(BunServices.layer));

// @effect-diagnostics-next-line effect/strictEffectProvide:off
BunRuntime.runMain(cli.pipe(Effect.provide(AppLayer)));
