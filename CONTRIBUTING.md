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
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Pull requests and pushes to `main` run these frontend checks on Node.js 22.18.0 and 24, plus native Rust tests on macOS and Windows. Tests that require live provider services remain opt-in and are not run in CI.

Add focused regression tests for behavior changes. Visual changes should include the exact window size, source-build version, reproduction steps, and before/after evidence without exposing personal data.

## Pull requests

- Explain what changed, why, and the user-visible effect.
- Separate confirmed evidence from inference.
- Preserve reduced-motion behavior and both Light/Dark themes.
- Do not lower visual quality to hide a lifecycle or ownership bug.
- Confirm that real login, data, lyrics, and playback paths were not replaced with mock data.

By contributing, you agree that your contribution is licensed under AGPL-3.0-only.
