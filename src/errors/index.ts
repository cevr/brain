import { Schema } from "effect";

export class BrainError extends Schema.TaggedErrorClass<BrainError>()("errors/BrainError", {
  message: Schema.String,
}) {}

export class VaultError extends Schema.TaggedErrorClass<VaultError>()("errors/VaultError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("errors/ConfigError", {
  message: Schema.String,
}) {}
