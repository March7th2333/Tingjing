import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const outputDirectory = path.join(repositoryRoot, "release-artifacts");
const execFileAsync = promisify(execFile);

const platform = process.argv[2];
const platformConfig = {
  "macos-arm64": {
    extension: ".dmg",
    searchDirectory: "src-tauri/target/release/bundle/dmg",
    outputName: (version) => `Tingjing-${version}-macOS-arm64.dmg`,
    signing: {
      developerId: false,
      notarized: false,
      status: "no Apple Developer ID distribution signature",
    },
  },
  "windows-x64": {
    extension: ".exe",
    searchDirectory: "src-tauri/target/release/bundle/nsis",
    outputName: (version) => `Tingjing-Setup-${version}-Windows-x64.exe`,
    signing: {
      authenticode: false,
      status: "no Windows Authenticode distribution signature",
    },
  },
}[platform];

if (!platformConfig) {
  throw new Error("Usage: node prepareReleaseArtifact.mjs <macos-arm64|windows-x64>");
}

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(entryPath) : [entryPath];
    }),
  );
  return files.flat();
};

const sha256 = async (filePath) => {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
};

const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
);
const toolchainText = await readFile(
  path.join(repositoryRoot, "rust-toolchain.toml"),
  "utf8",
);

const sourceDirectory = path.join(repositoryRoot, platformConfig.searchDirectory);
const candidates = (await walk(sourceDirectory)).filter(
  (filePath) => path.extname(filePath).toLowerCase() === platformConfig.extension,
);

if (candidates.length !== 1) {
  throw new Error(
    `Expected exactly one ${platformConfig.extension} in ${platformConfig.searchDirectory}, found ${candidates.length}`,
  );
}

await mkdir(outputDirectory, { recursive: true });
const assetName = platformConfig.outputName(packageJson.version);
const assetPath = path.join(outputDirectory, assetName);
await copyFile(candidates[0], assetPath);

const assetStats = await stat(assetPath);
if (assetStats.size === 0) {
  throw new Error(`Release asset ${assetName} is empty`);
}

const assetDigest = await sha256(assetPath);
const { stdout: rustcVersionOutput } = await execFileAsync("rustc", ["--version"]);
const checksumName = `SHA256SUMS-${platform}.txt`;
await writeFile(
  path.join(outputDirectory, checksumName),
  `${assetDigest}  ${assetName}\n`,
  "utf8",
);

const metadata = {
  schemaVersion: 1,
  application: "Tingjing",
  version: packageJson.version,
  platform,
  source: {
    repository: process.env.GITHUB_REPOSITORY ?? "March7th2333/Tingjing",
    commit: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
  },
  runner: {
    name: process.env.RUNNER_NAME ?? null,
    os: process.env.RUNNER_OS ?? process.platform,
    architecture: process.env.RUNNER_ARCH ?? process.arch,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
  },
  toolchain: {
    node: process.version,
    nodeRequirement: packageJson.engines?.node ?? null,
    rustPin: toolchainText.match(/^channel\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    rustc: rustcVersionOutput.trim(),
    tauriCli: packageLock.packages?.["node_modules/@tauri-apps/cli"]?.version ?? null,
  },
  lockfiles: {
    packageLockSha256: await sha256(path.join(repositoryRoot, "package-lock.json")),
    cargoLockSha256: await sha256(path.join(repositoryRoot, "src-tauri/Cargo.lock")),
  },
  asset: {
    name: assetName,
    bytes: assetStats.size,
    sha256: assetDigest,
  },
  signing: platformConfig.signing,
};

const metadataName = `build-metadata-${platform}.json`;
await writeFile(
  path.join(outputDirectory, metadataName),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify({ assetName, checksumName, metadataName, sha256: assetDigest })}\n`,
);
