# 工作区说明

这里**不是一个仓库**，而是几个互不相关的任务共用的一块盘。先看清哪个目录属于哪个任务，
再动手改任何东西。

| 目录 / 文件 | 属于 | 说明 |
|---|---|---|
| [`dsh-voice-chat/`](dsh-voice-chat/) | **语音插件（交付物）** | 会被 `dsh plugin add` 装进 DSH 的完整插件。**改代码就是改这里** |
| [`probe/`](probe/) | 语音插件（开发侧） | 验证脚本、按需工具、设计参考。**不随插件分发** |
| [`纳西妲_中文配音/`](纳西妲_中文配音/) | 语音插件（素材） | 克隆参考音色库：77 个 mp3 + `manifest.json` + 台词稿 + CSV。**不进版本库**（见下） |
| `build/`、`scripts/`、`科学记数法-交互式课件.html` | **另一个项目（PPTX 转网页课件）** | 和语音插件无关，别混着改 |

### 版本控制边界

仓库根就在本目录，但**只有插件和它的开发工具入库**（52 个文件）：

```powershell
git ls-files        # 看实际跟踪了什么
```

| 状态 | 内容 | 为什么 |
|---|---|---|
| **入库** | `dsh-voice-chat/`、`probe/`、本文件、`.gitignore`、`.gitattributes` | 插件本体 + 开发验收工具 |
| **排除** | `纳西妲_中文配音/` | 是**用户素材**而非插件组成；插件不读它，且台词稿属第三方版权内容 |
| **排除** | `build/`、`scripts/`、`科学记数法-交互式课件.html` | 另一个项目 |
| **排除** | `probe/design/orb-live-*.html`、`*.png` | 跑一次 `render-orb.mjs` 就有 |

排除不等于删除 —— 东西都还在磁盘上，只是不参与版本历史。

---

## 从哪开始

| 你想做的事 | 读这个 |
|---|---|
| 了解插件能干什么、怎么装、怎么配 | [`dsh-voice-chat/README.md`](dsh-voice-chat/README.md) |
| **接手开发**：装在哪、改了怎么生效、有哪些坑 | [`dsh-voice-chat/DEVELOPING.md`](dsh-voice-chat/DEVELOPING.md) |
| 跑验证、用工具、改 UI 前校样式 | [`probe/README.md`](probe/README.md) |

## 版本迭代：新会话开场白

开新会话时，把下面这句**原样发给它**：

> **我要对DSH语音对话插件进行版本迭代。**

这句话就是约定。agent 应当据此自己去读
[`dsh-voice-chat/DEVELOPING.md`](dsh-voice-chat/DEVELOPING.md) 与
[`probe/README.md`](probe/README.md)，弄清装在哪、改了什么怎么生效、改完怎么验证，
**然后才开始动手** —— 不需要你再解释一遍背景。

一次迭代的动作顺序：

```
改代码 → 跑验证（至少 unit-tests + live-verify）
       → 更新 dsh-voice-chat/package.json 的 version 与 CHANGELOG.md
       → git commit → git tag vX.Y.Z
```

当前版本 **1.0.0**（首个版本化基线），历史见 `git log --oneline` 与 `git tag`。
能力清单与迭代流程详见 [`dsh-voice-chat/CHANGELOG.md`](dsh-voice-chat/CHANGELOG.md)。

---

## 三条最容易踩的坑（细节见 DEVELOPING）

1. **`client.js` 改完必须刷新页面**（F12 → Ctrl+R），Host 半区才是热重载。
2. **不要用 `Get-Content`/`Set-Content` 往返文本文件** —— 本机 PowerShell 5.1 的默认编码是
   ANSI(936)，会把 UTF-8 中文写成乱码并加 BOM。要改文件用编辑工具，或在 .NET API 里
   **显式指定 UTF-8 无 BOM**。
3. **`dsh-voice-chat/` 是 HMR 的 `root`** —— 往里加非模块文件会触发无意义的重载，
   开发用的东西一律放 `probe/`。
