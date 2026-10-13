# `probe/` — 开发与验证（不随插件分发）

插件本体在 [`../dsh-voice-chat/`](../dsh-voice-chat/)。这里的东西**只在本机开发时用**，
`package.json` 的 `files` 白名单不含它们，所以永远不会被打包进去。

> 版本迭代的开场白是「**我要对DSH语音对话插件进行版本迭代。**」。
> 看到它就先读 [`../dsh-voice-chat/DEVELOPING.md`](../dsh-voice-chat/DEVELOPING.md) 和本文件，
> 把「改完怎么验证」搞清楚再动手。

## 目录约定

| 目录 | 含义 | 什么时候跑 |
|---|---|---|
| `verify/` | **验收门禁**。改完代码要跑的就是这些，结果有明确的通过/失败 | 每次改动后 |
| `tools/` | **按需工具**。排查具体问题、准备素材、量体积 | 需要时才跑 |
| `design/` | 设计参考 + 一个能从源码里校验样式的夹具 | 改 UI 时 |
| `archive/` | 已完成的一次性任务脚本，保留只为溯源 | 基本不用 |

---

## `verify/` — 验收门禁

> **省 token 的原则**：只改了 `client.js` 就只跑 `unit-tests` + `live-verify`，
> 不要每次五套全跑；输出用 `Select-Object -Last 3`，别把整篇日志倒进对话。

```powershell
$node = "C:\Users\74260\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$exe  = "D:\Hima\App\Deepseek\DeepSeek Harness.exe"   # 需 $env:ELECTRON_RUN_AS_NODE=1
```

| 脚本 | 运行时 | 覆盖什么 | 期望 |
|---|---|---|---|
| `unit-tests.mjs` | 普通 node | CMVN 夹具、fbank、WAV 往返、端点状态机、TTS 请求形状、音色名安全、客户端纯函数、**胶球几何（吸边阈值/扇形不重叠/贴边镜像）** | **18/18** |
| `http-tests.mjs` | 普通 node | 真实回环服务器：越权 403、状态码映射、克隆计划、dev-tone 合成 | **12/12** |
| `manifest-check.mjs` | **Electron-as-node** | 清单 / patch / 相对 import 三者一致性（要 DSH 里的 js-yaml） | `consistent` |
| `worker-e2e.mjs` | **Electron-as-node** | 真模型转写 + 噪声/静音拒识 + **降级路径**（sherpa 在 app.asar 里） | **7/7** |
| `live-verify.mjs` | **Electron-as-node** | 打**正在运行的 GUI**，14 项，含真 MiMo 合成与原生模块解析报告 | **14/14** |
| `firered-spike.mjs` | 普通 node + `$env:DSH_VOICE_MODULE_DIR=<profile>` | FireRedVAD 数值闸门：语音 vs 噪声 vs 静音 | `PASS` |
| `vad-backends.mjs` | **Electron-as-node** | 子进程里逐个验 `ten` / `silero` 是否可用 | 见输出 |

`vad-backends.mjs` 必须走子进程：sherpa 的 C++ 层在模型不对时会直接 `exit(-1)`，
JS 层 `try/catch` 拦不住，只能隔离观察。

```powershell
# 例：改完 client.js 的两条最小验证
& $node probe\verify\unit-tests.mjs   2>&1 | Select-Object -Last 3
$env:ELECTRON_RUN_AS_NODE = 1
& $exe  probe\verify\live-verify.mjs  2>&1 | Select-Object -Last 3
```

---

## `tools/` — 按需工具

| 脚本 | 用途 |
|---|---|
| `asar-ls.mjs <asar> <内部路径> [深度]` | 列出 app.asar 里的目录（找 DSH 源码/样式用） |
| `asar-extract.mjs <asar> <内部路径> <目标目录>` | 把 asar 里的一段解到磁盘 |
| `asar-grep.mjs <asar> <内部路径> <正则> [条数] [扩展名]` | **按匹配**搜 asar（产物是压缩单行，按行搜没用） |
| `prepare-assets.mjs` | 下载并校验语音模型到 `%DSH_HOME%\voice-chat\` |
| `session-size.mjs <会话文件>` | 量某个会话文件有多大 |
| `fbank-probe.mjs <wav>` | 单帧 fbank 的数值解剖（逐段对比参考实现） |
| `firered-diag.mjs <wav>` | FireRedVAD 特征管线在哪里错了（FFT → CMVN → 非流式图） |
| `ort-load.mjs` / `ort-order.mjs` / `ort-child.mjs` | 原生模块加载顺序诊断（`onnxruntime-node` vs sherpa 的 DLL 冲突） |
| `worker-raw.mjs` | 绕过 Host 直接起 worker，手喂 PCM |

`asar-*.mjs` 都要用 Electron 才认 asar：

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
& $exe probe\tools\asar-grep.mjs "D:\Hima\App\Deepseek\resources\app.asar" "dsh/node_modules/@deepseek-ai" "正则" 40
```

---

## `design/`

| 文件 | 用途 |
|---|---|
| `render-orb.mjs` | **从 `client.js` 里抽出真正发出去的那段 CSS**，检查它引用的每个 class 组件确实渲染了，再生成可截图的 HTML。改了 CSS 就跑它 |
| `theme-tokens.md` | DSH 的真实主题令牌表（`--dsw-*`，亮/暗两套），从 app.asar 查证得来 |
| `glass-themes.html` | 当初三套主题方案的对比页（历史参考，实现已定格在 C 方案） |

> `render-orb.mjs` 每次运行都会在 `design/` 下生成 `orb-live-*.html`（每套状态一份）。
> 那些是**可再生产物**，不必保留，要截图时再跑即可。

`render-orb.mjs` 是唯一一个**同时属于设计和验证**的脚本 —— 它能在浏览器看不到的情况下，
证明样式表和组件标记是对得上的（这个错犯过三次）：

```powershell
& $node probe\design\render-orb.mjs      # 输出 classes checked: N
```

---

## `archive/voice-harvest/`

采集「纳西妲」中文语音做克隆参考音色用的一次性脚本（`probe1-3.py`、`download.py`、
`verify.py`、`check_url.py`）。产出的音色库在 [`../纳西妲_中文配音/`](../纳西妲_中文配音/)。

**没用了可以直接删** —— 音色库本身（77 个 mp3 + manifest + CSV + 台词稿）已经独立存在。

---

## 发布到 GitHub

插件本体（**不含本目录**）发布到 <https://github.com/HimaCSR/dsh-voice-chat>。

```powershell
.\probe\tools\publish.ps1 -DryRun     # 预演：重建 release 分支和安装包，不推送
.\probe\tools\publish.ps1             # 推送分支 + 标签
```

`publish.ps1` 做四件事：`git subtree` 拆出 `release` 分支 → `git archive` 打
`dist\dsh-voice-chat-<版本>.zip` → 打 `v<版本>` 标签 → 推送 `release:main` 和标签。

### 为什么用 subtree，而不是直接推 main

**公开仓库必须让 `package.json` 位于仓库根**，否则 `dsh plugin add github:HimaCSR/dsh-voice-chat`
会找不到清单。而插件在本地是 `dsh-voice-chat/` 子目录（profile 的 `link:` 依赖和 HMR root
都钉死了这个路径，不能搬）。`git subtree split --prefix=dsh-voice-chat` 正好把插件提升为分支根。

### ⚠️ 本地 `main` ≠ 远程 `main`

| 分支 | 内容 |
|---|---|
| 本地 `main` | **开发内容**：`dsh-voice-chat/` + `probe/` + 工作区 README |
| 本地 `release` | 插件本体，根目录就是 `package.json`（每次发布由脚本重建） |
| 远程 `main` | = 本地 `release`。**只有这样别人才能一行装** |

两者**没有共同祖先**。直接 `git push origin main` 会失败，`--force` 则会用开发内容
（含 `probe/`）覆盖掉线上仓库。所以本仓库已设 `branch.main.pushRemote = no_push`
把这条路堵死 —— **发布只走 `publish.ps1`**。

### 本机发布依赖的两个非默认设置

1. **必须用 Git 自带的 ssh**：Windows 内置的 OpenSSH 8.1p1 与 GitHub 密钥交换不兼容，
   症状是「主机密钥校验通过后仍报 Host key verification failed」。
   已配进本仓库 `core.sshCommand`：
   ```
   C:/PROGRA~1/Git/usr/bin/ssh.exe -i C:/Users/74260/.ssh/id_ed25519_github_dshvoice -o IdentitiesOnly=yes
   ```
2. **`known_hosts` 里 github.com 的三行是官方指纹**（2023 年 GitHub 换过 RSA 密钥）。
   若再出现主机密钥告警，去官方文档核对，不要盲目删除。

### 发布后的最后一步

到仓库的 **Releases** 页 Draft a new release → 选 `v1.0.0` 标签 → 把
`dist\dsh-voice-chat-1.0.0.zip` 作为附件上传。这一步目前只能手工做（除非提供 token）。

### 本机踩过的编码坑（写脚本必读）

**Windows PowerShell 5.1 读 `.ps1` 时按 ANSI(936) 解析**，所以含中文的 `.ps1`
**必须存成 UTF-8 with BOM**，否则中文变乱码、还会把后面的引号一起吃掉，语法直接崩。
`publish.ps1` 就是因此写了两次。给文件补 BOM：

```powershell
$p = 'probe\tools\publish.ps1'
$t = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))   # $true = 带 BOM
```

