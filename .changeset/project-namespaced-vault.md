---
"@cvr/brain": minor
---

Add project-namespaced vault directories with auto-detection. `brain inject` now detects the current project (via `BRAIN_PROJECT` env, git root basename, or cwd basename) and injects notes from `projects/<name>/` alongside the global index. `brain init --project --global` creates minimal sub-vaults. New `ConfigService.currentProjectName()` method.
