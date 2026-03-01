import { Schema } from "effect";

export class BrainError extends Schema.TaggedErrorClass<BrainError>()("@cvr/brain/BrainError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

export class VaultError extends Schema.TaggedErrorClass<VaultError>()("@cvr/brain/VaultError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
}) {}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("@cvr/brain/ConfigError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}
