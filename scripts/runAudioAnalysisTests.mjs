import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outputDirectory = await mkdtemp(join(tmpdir(), "tingjing-audio-analysis-"));

try {
  const outputFile = join(outputDirectory, "audio-analysis.test.mjs");

  await build({
    bundle: true,
    entryPoints: ["tests/audioAnalysis.test.ts"],
    format: "esm",
    logLevel: "silent",
    outfile: outputFile,
    packages: "external",
    platform: "node",
    target: "node22",
  });

  const result = spawnSync(process.execPath, ["--test", outputFile], {
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
