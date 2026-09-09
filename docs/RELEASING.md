# Release process

Tingjing's release workflow builds two reproducible release candidates from one
source revision:

- a macOS Apple Silicon DMG on GitHub's `macos-15` arm64 runner;
- a Windows x64 NSIS installer on `windows-2025`.

The workflow pins Node.js, Rust, the Tauri CLI, and every reusable GitHub Action.
`package-lock.json` and `src-tauri/Cargo.lock` remain the authoritative dependency
locks.

## Before tagging

1. Update the version in `package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Run `npm ci` and `npm run release:verify`.
3. Run the normal frontend and native test suites from `CONTRIBUTING.md`.
4. Create a tag named exactly `v<version>` from a clean commit.

The release workflow rejects a tag that does not match all four version sources.
It also checks that builds do not modify tracked files and validates the macOS
arm64 and Windows x64 application binaries before collecting installers.

## Outputs

Each platform produces:

- one consistently named installer;
- a SHA-256 checksum;
- JSON build metadata containing the source revision, pinned toolchain versions,
  dependency-lock digests, asset size, asset digest, and signing status.

After both platform jobs pass, tag builds create a **draft** GitHub Release. The
draft includes both installers, one consolidated `SHA256SUMS.txt`, build metadata,
and an explicit notice that the current artifacts are unsigned. Existing releases
are never overwritten.

Manual workflow runs build and retain the same verified artifacts for 14 days but
do not create a Release.

## Signing boundary

This workflow does not configure Apple Developer ID signing, Apple notarization,
or Windows Authenticode. Those credentials must be supplied through protected
GitHub Environments or Secrets before a draft can be considered a signed release.
Never add certificates, private keys, provider sessions, or passwords to the
repository or workflow logs.
