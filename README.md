<div align="center">
  <img src="./public/mark.svg" width="112" alt="Tingjing mark" />

# 听境 Tingjing

**让音乐占满画面。**<br />
*Let music fill the screen.*

[![Latest release](https://img.shields.io/github/v/release/March7th2333/Tingjing?display_name=tag&sort=semver)](https://github.com/March7th2333/Tingjing/releases/latest)
[![CI](https://github.com/March7th2333/Tingjing/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/March7th2333/Tingjing/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/March7th2333/Tingjing/total)](https://github.com/March7th2333/Tingjing/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/March7th2333/Tingjing?style=flat)](https://github.com/March7th2333/Tingjing/stargazers)

[下载最新版](https://github.com/March7th2333/Tingjing/releases/latest) ·
[English](#english) ·
[参与贡献](./CONTRIBUTING.md)
</div>

听境不是把音乐塞进普通播放器界面，而是把封面、歌词、时间和声音组织成一个连续的桌面音乐空间。它以黑白编辑视觉为基础，保留真实封面颜色，并提供音乐墙与四种 Listening Space。

## 下载

| 平台 | 安装包 | 状态 |
| --- | --- | --- |
| macOS Apple Silicon | [Tingjing-0.1.1-macOS-arm64.dmg](https://github.com/March7th2333/Tingjing/releases/download/v0.1.1/Tingjing-0.1.1-macOS-arm64.dmg) | 可用，未签名 / 未公证 |
| Windows x64 | [Tingjing-Setup-0.1.1-Windows-x64.exe](https://github.com/March7th2333/Tingjing/releases/download/v0.1.1/Tingjing-Setup-0.1.1-Windows-x64.exe) | 早期版本，未签名 |

当前安装包没有 Apple Developer ID、Apple 公证或 Windows Authenticode 签名，因此系统可能显示安全提醒。请只从本仓库的 [Releases](https://github.com/March7th2333/Tingjing/releases) 下载，并核对 Release 中的 SHA-256。

## 核心体验

- **空间化音乐收藏**：封面轨道、音乐墙与连续 Cover Portal 转场。
- **四个 Listening Space**：Music Space、Lyrics Flow、Typography 与 Imprint。
- **真实歌词时间**：优先使用 Provider 提供的逐字时间；不可验证时明确降级，不伪造逐字数据。
- **播放队列**：顺序、随机、单曲循环、列表循环、恢复播放与本地音量设置。
- **黑白编辑视觉**：Light / Dark / System，封面保持原始颜色。
- **中英界面**：中文与 English 可即时切换。
- **本地统计**：今日听歌时长只保存在本机。

## 音乐来源

| 来源 | 登录 | 播放方式 |
| --- | --- | --- |
| 网易云音乐 | 扫码 | 应用内播放 |
| QQ 音乐 | QQ 音乐 App 扫码 | 应用内播放 |
| Spotify | OAuth PKCE | 交由 Spotify 官方客户端播放 |

网易云音乐与 QQ 音乐接入是非官方社区实现，可能随第三方接口变化而失效；Spotify 使用官方 Web API 授权，但听境不会提取 Spotify 音频或歌词。请只使用你本人有权访问的账号和内容。仓库及安装包不包含从第三方平台抓取的歌曲、歌词、专辑封面或账号凭据；源码中的少量演示元数据与歌词仅用于本地预览和测试。

## 本地开发

需要 Node.js 22.18+、npm、Rust stable，以及 Tauri 2 对应的系统依赖。测试脚本会直接运行 TypeScript 测试文件，因此更早的 Node.js 版本不受支持。

```bash
npm ci
npm run dev
```

运行桌面壳：

```bash
npm run tauri -- dev
```

检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
cargo +stable test --manifest-path src-tauri/Cargo.toml --lib --locked
```

Spotify 开发需要在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 创建应用，登记回调地址 `http://127.0.0.1/callback`，并通过登录页或 `VITE_SPOTIFY_CLIENT_ID` 提供公开 Client ID。不要在桌面应用中加入 Client Secret。

## 开源与边界

听境源代码采用 [GNU AGPL-3.0-only](./LICENSE)。第三方依赖、商标和品牌素材保留各自权利，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。本许可证不授予任何音乐、歌词、封面、平台商标或第三方服务内容的权利。

请阅读 [隐私说明](./PRIVACY.md)、[安全策略](./SECURITY.md) 与 [贡献指南](./CONTRIBUTING.md)。如果你喜欢这个方向，欢迎点一个 Star，也欢迎提交可复现的问题和克制的改进。

---

## English

Tingjing is an open-source spatial desktop music player built with Tauri, React, TypeScript, native CSS, and Canvas. It treats cover art, lyrics, time, and sound as one continuous music space instead of a collection of ordinary player pages.

- Download the latest macOS Apple Silicon DMG or Windows x64 installer from [Releases](https://github.com/March7th2333/Tingjing/releases/latest).
- Current binaries are unsigned and may trigger Gatekeeper or SmartScreen warnings.
- NetEase Cloud Music and QQ Music integrations are unofficial community implementations. Spotify uses OAuth PKCE and delegates playback to the official Spotify client.
- No music, lyrics, cover art, provider credentials, or user-library data fetched from third-party platforms are bundled with this repository. A small amount of original demo metadata and lyrics is included only for local previews and tests.
- Source code is licensed under AGPL-3.0-only; third-party assets and trademarks are excluded from that grant.

For development and contribution details, see [CONTRIBUTING.md](./CONTRIBUTING.md).
