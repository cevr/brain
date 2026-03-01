import { Effect, Layer, ServiceMap } from "effect";

export class BuildInfo extends ServiceMap.Service<
  BuildInfo,
  {
    readonly repoRoot: string;
    readonly version: string;
  }
>()("@cvr/brain/services/BuildInfo") {
  /** Production layer — reads compile-time constants injected by scripts/build.ts */
  static layer: Layer.Layer<BuildInfo> = Layer.effect(
    BuildInfo,
    Effect.sync(() => ({
      repoRoot:
        typeof REPO_ROOT !== "undefined"
          ? REPO_ROOT
          : new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "0.0.0-dev",
    })),
  );

  /** Test layer with explicit values */
  static layerTest = (opts: { repoRoot: string; version?: string }) =>
    Layer.succeed(BuildInfo, {
      repoRoot: opts.repoRoot,
      version: opts.version ?? "0.0.0-test",
    });
}
