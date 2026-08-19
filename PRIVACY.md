# 隐私说明 / Privacy

听境是本地桌面应用，目前没有听境自建的账号服务器、云端听歌统计或第一方分析遥测。

## 本地保存的数据

应用可能在操作系统分配的应用数据目录或 WebView localStorage 中保存：

- 你选择的音乐来源、账号标识和头像等展示信息；
- 网易云音乐、QQ 音乐或 Spotify 的登录会话；
- 音乐库元数据与图片缓存；
- 播放队列、当前歌曲、播放位置、音量与播放模式；
- 本机今日听歌时长、歌词偏移、语言和主题设置。

听歌时长只在本机统计，不会从 QQ 音乐、网易云音乐或 Spotify 云端读取，也不会上传到听境服务器。

## 与第三方服务的通信

当你选择某个音乐来源时，听境会直接从桌面应用向该来源请求登录、音乐库、歌词或播放所需的数据。第三方服务会按照其自身隐私政策处理这些请求。Spotify 播放会交给 Spotify 官方客户端。

## 删除与退出

在应用中退出账号会清除对应 Provider 会话。卸载应用未必会自动删除操作系统保留的应用数据；如需完全清除，请同时删除 `space.tingjing.player` 对应的应用数据目录。

提交问题或日志前，请删除二维码、Cookie、Token、账号 ID、私人歌单、桌面截图和本机绝对路径。不要在公开 Issue 中提交凭据。

---

Tingjing is a local desktop application. It currently has no Tingjing-operated account server, cloud listening-time service, or first-party analytics telemetry. Provider sessions, library metadata, playback state, local listening time, lyric offsets, language, and theme preferences may be stored in the OS application-data directory or WebView localStorage. Data is exchanged directly with the provider selected by the user and remains subject to that provider's privacy policy.
