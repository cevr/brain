# @cvr/brain

## 0.3.0

### Minor Changes

- [`c687904`](https://github.com/cevr/brain/commit/c68790495c24e8c2647510011f155d36a0f5fa15) Thanks [@cevr](https://github.com/cevr)! - Add project-namespaced vault directories with auto-detection. `brain inject` now detects the current project (via `BRAIN_PROJECT` env, git root basename, or cwd basename) and injects notes from `projects/<name>/` alongside the global index. `brain init --project --global` creates minimal sub-vaults. New `ConfigService.currentProjectName()` method.

## 0.2.0

### Minor Changes

- [`45867a2`](https://github.com/cevr/brain/commit/45867a2199210a5ecc5ea85f74e54e01890f7195) Thanks [@cevr](https://github.com/cevr)! - CLI audit fixes: structured error codes, BuildInfo service, new `list` command, `--json` on snapshot/inject, `--verbose`/`--min-size` flags, status stdout fix, HOME fallback removal, hooks validation, sections consistency, argument descriptions, `--no-skills` rename, and comprehensive command-level tests.
