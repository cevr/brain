import { Option, Schema } from "effect";

export class BrainError extends Schema.TaggedErrorClass<BrainError>()("BrainError", {
  message: Schema.String,
  code: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("BRAIN_ERROR"))),
  suggestion: Schema.optional(Schema.String),
}) {}

export class VaultError extends Schema.TaggedErrorClass<VaultError>()("VaultError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  code: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("VAULT_ERROR"))),
  suggestion: Schema.optional(Schema.String),
}) {}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  code: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("CONFIG_ERROR"))),
  suggestion: Schema.optional(Schema.String),
}) {}
