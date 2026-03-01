# brain

CLI for persistent agent memory. Encodes the [brainmaxxing](https://github.com/poteto/brainmaxxing) workflow into a single binary.

## Install

```bash
bun run build
```

## Usage

```
brain init          # scaffold vault + wire hooks + install skills
brain status        # vault health
brain vault         # print active vault path
brain inject        # SessionStart hook (outputs index to stdout)
brain reindex       # PostToolUse hook (rebuilds index.md)
brain snapshot <dir> [-o file]   # concatenate .md files
brain extract <dir> -o <output>  # mine JSONL conversations
```
