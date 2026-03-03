---
"@cvr/brain": patch
---

fix: skip TCC-protected directories in deriveProjectName to prevent macOS permission popups

The daemon's `deriveProjectName` called `fs.exists()` on reconstructed path candidates, hitting macOS TCC-protected directories (Downloads, Documents, Photos, etc.) and triggering system permission popups. Now skips probing any path under known TCC-protected `$HOME` subdirectories.
