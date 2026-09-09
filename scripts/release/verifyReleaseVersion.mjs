import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const tauriConfig = await readJson("src-tauri/tauri.conf.json");
const cargoToml = await readFile(
  path.join(repositoryRoot, "src-tauri/Cargo.toml"),
  "utf8",
);
const rustToolchain = await readFile(
  path.join(repositoryRoot, "rust-toolchain.toml"),
  "utf8",
);

const cargoVersion = cargoToml.match(
  /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];
const rustVersion = rustToolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
const cliSpec = packageJson.devDependencies?.["@tauri-apps/cli"];
const lockedCliVersion = packageLock.packages?.["node_modules/@tauri-apps/cli"]?.version;

const requiredValues = {
  "package.json version": packageJson.version,
  "package-lock.json version": packageLock.version,
  "package-lock root version": packageLock.packages?.[""]?.version,
  "Tauri config version": tauriConfig.version,
  "Cargo package version": cargoVersion,
};

const missing = Object.entries(requiredValues).filter(([, value]) => !value);
if (missing.length > 0) {
  throw new Error(`Missing release versions: ${missing.map(([name]) => name).join(", ")}`);
}

const uniqueVersions = new Set(Object.values(requiredValues));
if (uniqueVersions.size !== 1) {
  throw new Error(
    `Release versions do not match:\n${Object.entries(requiredValues)
      .map(([name, value]) => `- ${name}: ${value}`)
      .join("\n")}`,
  );
}

if (!rustVersion) {
  throw new Error("rust-toolchain.toml must pin a Rust channel");
}

if (!lockedCliVersion || cliSpec !== lockedCliVersion) {
  throw new Error(
    `@tauri-apps/cli must be pinned exactly (package.json=${cliSpec}, lock=${lockedCliVersion})`,
  );
}

const releaseTag = process.env.RELEASE_TAG?.trim();
const version = packageJson.version;
if (releaseTag && releaseTag !== `v${version}`) {
  throw new Error(`Release tag ${releaseTag} does not match application version v${version}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      version,
      releaseTag: releaseTag || null,
      nodeRequirement: packageJson.engines?.node ?? null,
      rustVersion,
      tauriCliVersion: lockedCliVersion,
    },
    null,
    2,
  )}\n`,
);
