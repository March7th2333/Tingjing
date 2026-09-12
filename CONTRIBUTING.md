# Contributing to Tingjing

感谢你愿意改进听境。这个项目优先保护连续的音乐空间、真实时间数据、账号隔离和克制的黑白视觉。

## Before opening a change

1. Search existing Issues and Pull Requests.
2. Keep the change focused; do not rewrite unrelated transitions or Provider logic.
3. Never commit real QR codes, cookies, tokens, account IDs, private music-library data, recordings, desktop screenshots, packaged apps, or local build caches.
4. For Spotify, use OAuth PKCE and official external playback boundaries. Never add a Client Secret or expose a raw Spotify audio URL.
5. For QQ Music and NetEase Cloud Music, do not bypass DRM, paid access, geographic restrictions, or account authorization.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
cargo +stable test --manifest-path src-tauri/Cargo.toml --lib --locked
```

Pull requests and pushes to `main` run these frontend checks on Node.js 22.18.0 and 24, plus native Rust tests on macOS and Windows. Tests that require live provider services remain opt-in and are not run in CI.

## Opening an Issue

Use the repository's [Issue chooser](https://github.com/March7th2333/Tingjing/issues/new/choose) for a structured Bug report or feature request. Keep reports focused and redact credentials, private library data, screenshots, and local paths before submitting them.

Security vulnerabilities, working exploits, or material containing sensitive account data must follow [SECURITY.md](./SECURITY.md) and should not be posted in a public Issue.

## Release candidates

The tag-triggered release workflow builds a macOS Apple Silicon DMG and Windows
x64 NSIS installer only after the repository checks pass. It records checksums,
lockfile digests, source metadata, and the current unsigned status without
overwriting an existing Release. See [docs/RELEASING.md](docs/RELEASING.md) for
the versioning, artifact, and signing boundaries.

Add focused regression tests for behavior changes. Visual changes should include the exact window size, source-build version, reproduction steps, and before/after evidence without exposing personal data.

## Pull requests

The Pull Request template mirrors the required local checks and evidence boundaries. Complete the relevant items rather than deleting the checklist.

- Explain what changed, why, and the user-visible effect.
- Separate confirmed evidence from inference.
- Preserve reduced-motion behavior and both Light/Dark themes.
- Do not lower visual quality to hide a lifecycle or ownership bug.
- Confirm that real login, data, lyrics, and playback paths were not replaced with mock data.

By contributing, you agree that your contribution is licensed under AGPL-3.0-only.
