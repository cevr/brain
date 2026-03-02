# Brain CLI Codemap

## Structure

```
src/
├── main.ts              # Entry point, CLI runner, error handler
├── globals.d.ts         # Compile-time constants (APP_VERSION, REPO_ROOT)
├── errors/index.ts      # BrainError, VaultError, ConfigError (TaggedErrorClass)
├── services/
│   ├── Config.ts        # Paths, env detection, project name resolution
│   ├── Vault.ts         # Vault init, reindex, status, snapshot, file listing
│   └── BuildInfo.ts     # Compile-time repo root + version
├── commands/
│   ├── index.ts         # Root command, subcommand wiring
│   ├── init.ts          # Vault scaffold, hooks, skills install (largest command)
│   ├── inject.ts        # SessionStart hook output — global + project notes
│   ├── skills.ts        # skills list/sync — nested subcommand
│   ├── reindex.ts       # Rebuild index.md from disk
│   ├── status.ts        # Vault health check
│   ├── vault.ts         # Print active vault path
│   ├── list.ts          # List vault files
│   ├── snapshot.ts      # Concatenate .md files
│   └── extract.ts       # Parse JSONL conversations
scripts/
└── build.ts             # Bun.build with compile-time defines → bin/brain
starter/
├── principles/          # Seed principles copied on first init
└── principles.md        # Seed principles index
skills/                  # Brain-managed skills (copied to ~/.claude/skills/ by init)
tests/
├── helpers/index.ts     # Shared withTempDir helper
├── services/            # Config, Vault service tests
└── commands/            # Command handler tests (inject, init, etc.)
```

## Key Patterns

| Pattern                   | Where                          | Notes                                                           |
| ------------------------- | ------------------------------ | --------------------------------------------------------------- |
| Service layer composition | `main.ts:26-28`                | `ConfigService + VaultService + BuildInfo` → `BunServices`      |
| Recursive dir comparison  | `skills.ts:dirsHaveDiff`       | Byte-level file comparison for outdated detection               |
| Minimal init mode         | `Vault.ts:init({ minimal })`   | Project sub-vaults get only dir + index.md                      |
| Project auto-detection    | `Config.ts:currentProjectName` | `BRAIN_PROJECT` → git root → cwd basename                       |
| Error code matching       | All commands                   | `e.code === "INDEX_MISSING"`, never string match on `e.message` |
