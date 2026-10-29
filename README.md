# CODIO — Your Private Radio

**陌生的歌曲，熟悉的听感。 / Unfamiliar songs. A familiar feeling.**

[中文](#中文) · [English](#english) · [Windows 下载 / Download](https://github.com/bs0612/CODIO-Your-Private-Radio/releases/download/v0.1.7-preview.20261027/CODIO-0.1.7-Windows-x64-20261027.zip) · [Releases](https://github.com/bs0612/CODIO-Your-Private-Radio/releases) · [MIT License](LICENSE)

## 中文

CODIO 是一款 Windows 私人音乐电台，把推荐、听歌记忆、AI DJ、歌曲衔接和封面粒子放进同一个安静的桌面空间。当前为 **0.1.7 Preview**，仍在持续打磨，欢迎体验和反馈。

### 下载与使用

**[下载 Windows 10/11 x64 便携版](https://github.com/bs0612/CODIO-Your-Private-Radio/releases/download/v0.1.7-preview.20261027/CODIO-0.1.7-Windows-x64-20261027.zip)** · [更新说明与 SHA-256](https://github.com/bs0612/CODIO-Your-Private-Radio/releases/tag/v0.1.7-preview.20261027)

1. 完整解压 ZIP 后运行 `CODIO.exe`，不要只复制 EXE 或在压缩包里直接运行。
2. 不需要注册 CODIO 账户；按需连接自己的 QQ 音乐。可播放歌曲取决于平台、地区、会员权限和网络。
3. AI DJ 可选：连接自己的 `deepseek-v4-flash` API Key，服务商按你的账户计费。CODIO 不出售聊天额度。
4. 更新前正常退出旧程序，将新版解压到一个新目录；不要删除自己的用户数据目录。

程序尚未购买 Windows 代码签名证书。请只从本仓库下载并核对 SHA-256，不要关闭系统安全防护。**Code → Download ZIP** 和 Releases 自动生成的 **Source code** 是开发源码，不是可直接运行的桌面程序。

### 它在做什么

- **Right where you are**：围绕已经证实的口味寻找更贴合的新歌，少量保留熟悉锚点。新鲜度不等于口味距离。
- **A little further**：通过独立候选获取和刷新流程，在有依据的相邻方向上探索，不是把上栏剩余歌曲直接放到下栏。
- **听歌记忆与画像**：明确反馈与有效收听参与同一套记忆，区分长期偏好和本次意图。单曲不喜欢不等于封禁整位歌手。
- **AI DJ**：通过本地工具核对歌曲、记录明确偏好及操作播放器。“喜欢这两首歌”不等于要求播放。偏好保存、画像更新、重排排队和隐藏队列提交分别确认；反馈不突然替换当前可见的 24 首，主动 REFRESH 再换一批。
- **播放与视觉**：Night Drift、Now Playing 大字/分栏歌词、封面粒子、音量波形和双 Deck 衔接；支持本地 WAV 导入。

歌曲级证据不足时保持不确定，不能宣称已理解每首歌的音色、情绪或编曲。推荐、音源、歌词和衔接仍有外部服务和分析能力的边界；预览版不承诺所有歌曲、账户或电脑都具有相同体验。

### 隐私与开源

- 下载包和仓库不含开发者 QQ 登录、DeepSeek Key、收藏、画像、播放历史、曝光记录、诊断导出或音频缓存，也不附带音乐文件。
- QQ 凭证保留在本机 Electron 会话。DeepSeek Key 由桌面主进程通过系统 `safeStorage` 加密，不写入网页 `localStorage`。
- AI DJ 会将相关聊天和精简电台状态发送到 DeepSeek。QQ、封面和天气等功能也会使用相应外部服务，因此 CODIO 不是完全离线软件。
- 当前源码按 **MIT** 开源，允许使用、修改、分发和商用，但须保留版权及许可声明。第三方依赖、音乐、封面、歌词、商标与服务不由此授予权限，详见 [第三方声明](THIRD-PARTY-NOTICES.md)。
- 只公开当前程序快照，不公开作者本机的旧开发历史或个人测试导出。

问题反馈请使用 [Issues](https://github.com/bs0612/CODIO-Your-Private-Radio/issues)，附版本、Windows 版本、复现步骤和歌曲完整名称/版本。不要提交 Key、Cookie、验证码、完整聊天记录或个人数据目录。

## English

CODIO is a Windows personal music radio combining recommendations, listening memory, an AI DJ, track transitions and album-cover particles in one quiet desktop space. **0.1.7 Preview** is an evolving early release; feedback is welcome.

### Download and get started

**[Download the Windows 10/11 x64 portable app](https://github.com/bs0612/CODIO-Your-Private-Radio/releases/download/v0.1.7-preview.20261027/CODIO-0.1.7-Windows-x64-20261027.zip)** · [Release notes and SHA-256](https://github.com/bs0612/CODIO-Your-Private-Radio/releases/tag/v0.1.7-preview.20261027)

1. Extract the entire ZIP, then run `CODIO.exe`. Do not run it inside the archive or copy the EXE alone.
2. No CODIO account is required. Connect your own QQ Music account if needed; playback depends on service availability, region, membership and network access.
3. AI DJ is optional and uses your own `deepseek-v4-flash` API key. DeepSeek bills your account directly; CODIO does not sell chat credits.
4. Quit the old app before updating, extract the new version into a new folder and keep your existing user-data directory.

The Windows app is currently unsigned. Download only from this repository, verify the SHA-256 and do not disable system security. **Code → Download ZIP** and GitHub's automatic **Source code** archives contain developer sources, not the runnable Windows app.

### What it does

- **Right where you are** seeks new songs with reliable links to established preferences, with a few familiar anchors. Novelty and taste distance are different things.
- **A little further** has its own candidate acquisition and refresh flow for evidence-linked exploration, rather than receiving the upper lane's leftovers.
- **Listening memory** combines explicit feedback and meaningful listening, separating lasting preferences from temporary intent. Disliking one song does not ban its artist.
- **AI DJ** verifies music identities and uses local tools to save explicit preferences or control playback. Expressing a preference is not permission to start playback. Saving, profile updates, queued reranking and hidden-queue commits are distinct results. Feedback keeps the visible 24 songs stable; use REFRESH to replace a batch.
- **Playback and visuals** include Night Drift, large/split Now Playing lyrics, album particles, a volume waveform and dual-deck transitions. Local WAV import is supported.

When song-level evidence is missing, sound characteristics remain uncertain. CODIO does not claim to understand every song's timbre, emotion or arrangement. Recommendations, audio availability, lyrics and transitions remain subject to service and analysis limitations; preview quality is not a guarantee across every song, account or computer.

### Privacy and open source

- Neither the repository nor the download includes developer logins, API keys, personal libraries, listening history, recommendation exposure, private diagnostics, audio caches or music files.
- QQ credentials remain in the local Electron session. The desktop main process encrypts the DeepSeek key using system `safeStorage`, not browser `localStorage`.
- AI DJ sends relevant chat and a compact radio-state snapshot to DeepSeek. Music, artwork and weather features contact their respective services; this is not a fully offline app.
- Current project sources are available under the **MIT License**. Usage, modification, distribution and commercial use are permitted with the copyright and license notice retained. Third-party components and content retain their own rights; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- This is a clean snapshot of the current application, not the author's private development history or personal diagnostic exports.

Please report issues with the app version, Windows version, reproduction steps and exact song/version. Never include keys, cookies, login codes, full conversations or user-data directories.

## 从源码开发 / Build from source

Windows x64 · Git · Node.js **22.13.0+** · npm. Initial dependency installation requires network access.

```powershell
git clone https://github.com/bs0612/CODIO-Your-Private-Radio.git
cd CODIO-Your-Private-Radio
npm ci
npm run build
npm run desktop:server
npm run desktop
```

无需部署网站。测试时建议先设置全新的数据目录，避免触碰真实账号和画像。No website deployment is needed. Use a fresh data directory for development:

```powershell
$env:CODIO_DATA_DIR = Join-Path $env:TEMP ('codio-dev-' + [guid]::NewGuid().ToString('N'))
npm run desktop
```

网页热更新 / Hot reload: run `npm run dev:web` and `npm run desktop:launch` in separate terminals. The optional legacy `voice` script is not required for the current AI DJ; its models and samples are not distributed.

```powershell
# Build first: the rendered HTML tests read dist.
node --test tests/*.test.mjs
npm run lint -- --ignore-pattern '.qa/**' --ignore-pattern '.wrangler/**'
node --check desktop/main.cjs
node --check desktop/preload.cjs

# Optional Windows NSIS installer, not the prebuilt portable ZIP:
npm run desktop:build
```

结构 / Structure: `app/` contains the interface, listening memory and audio logic; `desktop/` contains Electron bridges and local services; `tests/` contains isolated automated tests. Inside `app/`, `RadioExperience.tsx` holds the radio itself, with the self-contained pieces in their own modules: `particle-gl.ts` (GPU album particles and halo), `aurora-gl.ts` (home sky), `media-session.ts` (OS media keys), `sleep-timer.ts`, `keyboard-shortcuts.ts`, `listening-backup.ts` and the shared `radio-types.ts`. Personal diagnostics, machine-specific migration scripts, backups and speech models are not source dependencies and are excluded.

已知类型检查边界 / Known type-check boundary: retained Cloudflare template files have independent environment-type gaps for `cloudflare:workers`, `Fetcher` and `D1Database`. These are reported separately from desktop build results, not hidden to claim a clean full-project type check. `.openai/hosting.json` contains empty local bindings only, not the original hosted project's identity or deployment credentials.

自动测试和构建不等同于真实账户、试听或硬件性能验收。Automated checks and builds do not replace native playback, real-account or hardware acceptance testing.
