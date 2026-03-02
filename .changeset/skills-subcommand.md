---
"@cvr/brain": minor
---

Add `brain skills list` and `brain skills sync` subcommands. `list` shows installed skills with outdated detection (compares against repo source). `sync` copies updated skills from source to installed location, idempotent — skips identical content. Symlink-aware: syncs to resolved symlink targets.
