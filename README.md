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

### GitHub 仓库

插件已发布到 **<https://github.com/HimaCSR/dsh-voice-chat>**（public，MIT）。

```powershell
.\probe\tools\publish.ps1 -DryRun     # 预演
.\probe\tools\publish.ps1             # 真正发布（推分支 + 标签）
```

**注意：本地 `main` 和远程 `main` 不是同一份内容。**

| 分支 | 内容 |
|---|---|
| 本地 `main` | 开发内容：`dsh-voice-chat/` + `probe/` + 本文件 |
| 本地 `release` | 由 `publish.ps1` 用 `git subtree` 重建，根目录即插件的 `package.json` |
| 远程 `main` | = 本地 `release`，**不含 `probe/`** |

两者无共同祖先。本仓库已设 `branch.main.pushRemote = no_push` 堵死误推 ——
**发布只走 `publish.ps1`**，别直接 `git push`。详见 [`probe/README.md`](probe/README.md)。

---

## 从哪开始

| 你想做的事 | 读这个 |
|---|---|
| 了解插件能干什么、怎么装、怎么配 | [`dsh-voice-chat/README.md`](dsh-voice-chat/README.md) |
| **接手开发**：装在哪、改了怎么生效、有哪些坑 | [`dsh-voice-chat/DEVELOPING.md`](dsh-voice-chat/DEVELOPING.md) |
| 跑验证、用工具、改 UI 前校样式 | [`probe/README.md`](probe/README.md) |

## 发布新版本：完整流程

### 第 0 步：开新会话时发这一句

> **我要对DSH语音对话插件进行版本迭代。**

这句话是约定。agent 会自己去读
[`dsh-voice-chat/DEVELOPING.md`](dsh-voice-chat/DEVELOPING.md) 与
[`probe/README.md`](probe/README.md)，弄清装在哪、改了什么怎么生效、改完怎么验证，
**然后才开始动手** —— 不需要你再解释一遍背景。

### 第 1~5 步：改代码 → 验证 → 升版本 → 提交 → 发布

```powershell
cd "D:\Hima\App\yidongyunpan\移动云盘同步盘\Harness\project"
$node = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$exe  = "<DSH 安装目录>\DeepSeek Harness.exe"

# ① 改代码。改完 client.js 记得刷新页面（F12 → Ctrl+R），Host 半区才是热重载

# ② 跑验证 —— 至少这两条，数字不该比基线低
& $node probe\verify\unit-tests.mjs        # 期望 18/18
$env:ELECTRON_RUN_AS_NODE = 1
& $exe  probe\verify\live-verify.mjs       # 期望 14/14（要 DSH GUI 开着）

# ③ 升版本号（改 dsh-voice-chat\package.json 的 version）
#    并在 dsh-voice-chat\CHANGELOG.md 顶部加一节 ## [1.1.0]

# ④ 提交
git add -A; git commit -m "feat: ..."

# ⑤ 发布
.\probe\tools\publish.ps1 -DryRun          # 先预演，确认无误
.\probe\tools\publish.ps1                  # 正式发布（推分支 + 标签）
```

### 第 6 步：建 Release（目前只能手工做）

`publish.ps1` 跑完会直接打印一个链接，形如
`https://github.com/HimaCSR/dsh-voice-chat/releases/new?tag=v1.1.0`。

打开它 → 正文粘 [`RELEASE_NOTES_v1.0.0.md`](RELEASE_NOTES_v1.0.0.md) 的内容（改成对应版本）
→ 附件拖 `dist\dsh-voice-chat-1.1.0.zip` → **Publish release**。

---

### 版本号怎么定

改 `dsh-voice-chat/package.json` 的 `version`，按语义化版本：

| 改了什么 | 升哪一位 | 例 |
|---|---|---|
| 修 bug、改文档 | patch | `1.0.0 → 1.0.1` |
| 加功能（向后兼容） | minor | `1.0.1 → 1.1.0` |
| 破坏性改动（改配置项名、改 HTTP 路由） | major | `1.1.0 → 2.0.0` |

### `publish.ps1` 会替你拦两类错误

1. **工作区脏** —— 有未提交改动直接拒绝，避免线上代码和仓库记录不一致
2. **CHANGELOG 没写** —— `CHANGELOG.md` 里没有 `## [<当前版本>]` 一节就拒绝，避免版本历史是空的

（两道门槛都实测过：故意把 version 改成 `9.9.9` 会被明确拒绝并告诉你该写什么。）

### ⚠️ 千万别用 `git push`

本地 `main` 是**开发内容**（含 `probe/`），远程 `main` 是**插件本体**，两者无共同祖先。
本仓库已设 `branch.main.pushRemote = no_push` 把这条路堵死 —— **发布只走 `publish.ps1`**。

当前版本 **1.0.0**，历史见 `git log --oneline` 与 `git tag`。
能力清单见 [`dsh-voice-chat/CHANGELOG.md`](dsh-voice-chat/CHANGELOG.md)。

---

## 三条最容易踩的坑（细节见 DEVELOPING）

1. **`client.js` 改完必须刷新页面**（F12 → Ctrl+R），Host 半区才是热重载。
2. **不要用 `Get-Content`/`Set-Content` 往返文本文件** —— 本机 PowerShell 5.1 的默认编码是
   ANSI(936)，会把 UTF-8 中文写成乱码并加 BOM。要改文件用编辑工具，或在 .NET API 里
   **显式指定 UTF-8 无 BOM**。
3. **`dsh-voice-chat/` 是 HMR 的 `root`** —— 往里加非模块文件会触发无意义的重载，
   开发用的东西一律放 `probe/`。
