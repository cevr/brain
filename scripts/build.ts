import { mkdirSync, lstatSync, unlinkSync, symlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

console.log("Building brain...");

const binDir = join(rootDir, "bin");
mkdirSync(binDir, { recursive: true });

const pkg = await Bun.file(join(rootDir, "package.json")).json();
const version = (pkg as { version: string }).version;

const platform =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

const buildResult = await Bun.build({
  entrypoints: [join(rootDir, "src/main.ts")],
  target: "bun",
  minify: false,
  define: {
    REPO_ROOT: JSON.stringify(rootDir),
    APP_VERSION: JSON.stringify(version),
  },
  compile: {
    target: `bun-${platform}-${arch}`,
    outfile: join(binDir, "brain"),
    autoloadBunfig: false,
  },
});

if (!buildResult.success) {
  console.error("Build failed:");
  for (const log of buildResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Binary built: ${join(binDir, "brain")}`);

const home = process.env["HOME"] ?? os.homedir();
const bunBin = join(home, ".bun", "bin", "brain");
try {
  // Remove existing symlink before creating new one (TOCTOU is fine here —
  // worst case the unlink fails and symlinkSync reports the real error)
  try {
    lstatSync(bunBin);
    unlinkSync(bunBin);
  } catch {
    // doesn't exist
  }
  symlinkSync(join(binDir, "brain"), bunBin);
  console.log(`Symlinked to: ${bunBin}`);
} catch (e) {
  console.log(`Could not symlink to ${bunBin}: ${e}`);
}
