import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";

const outputFile = resolve(tmpdir(), "aural-audio-analysis.test.mjs");

await build({
  bundle: true,
  entryPoints: ["tests/audioAnalysis.test.ts"],
  format: "esm",
  logLevel: "silent",
  outfile: outputFile,
  packages: "external",
  platform: "node",
  target: "node24",
});

const result = spawnSync(process.execPath, ["--test", outputFile], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
