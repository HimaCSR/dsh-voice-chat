# 开发交接（DEVELOPING）

给**下一个会话**看的：读完这份 + `README.md` 就能直接动手，不必重新摸 DSH。
本文件只写"改代码时必须知道、但从代码里看不出来"的事。

---

## 0. 你在做的是版本迭代

用户的开场白是这句话：

> **我要对DSH语音对话插件进行版本迭代。**

看到它就意味着：**先读文档再动手**。按这个顺序把上下文建起来，不要一上来就改代码：

1. 本文件的 §1（装在哪）、§2（改了什么怎么生效）、§6（不能破的不变式）
2. [`../probe/README.md`](../probe/README.md) —— 每个验证脚本干什么、怎么跑
3. [`CHANGELOG.md`](CHANGELOG.md) —— 当前版本有什么能力
4. `git log --oneline` 看最近几次迭代做了什么

### 一次迭代的标准动作

```
① 读上下文（上面四步）
② 改代码（能用 edit 就别 write 整文件，见 §4）
③ 跑验证：至少 unit-tests + live-verify；动了 CSS 再加 render-orb
④ 更新 dsh-voice-chat/package.json 的 version 与 CHANGELOG.md
   （必须先在 CHANGELOG.md 写 ## [<新版本>] 一节，否则 publish.ps1 会拒绝发布）
⑤ git add -A && git commit -m "..."
⑥ .\probe\tools\publish.ps1 -DryRun      ← 先预演
   .\probe\tools\publish.ps1              ← 正式发布
⑦ 把脚本打印的 Release 链接交给用户，提醒他上传 dist\dsh-voice-chat-<版本>.zip
```

> **⛔ 不要 `git tag`、不要 `git push`。** 打标签、推分支、推标签、打安装包全部由
> `publish.ps1` 负责。本仓库已设 `branch.main.pushRemote = no_push` —— 本地 `main` 是
> 开发内容（含 `probe/`），远程 `main` 是插件本体，两者无共同祖先，直接推会毁掉线上仓库。

### 版本号约定

`package.json` 的 `version` 是唯一真源，`CHANGELOG.md` 记录每个版本的能力变化。

- **1.0.0** 首个版本化基线
- 修 bug → patch（`1.0.1`）；加功能 → minor（`1.1.0`）；破坏性改动 → major（`2.0.0`）

**当前基线**：单测 18/18、HTTP 契约 12/12、worker 端到端 7/7、活体验证 14/14。
任何一次迭代结束时这些数字都不该下降。

发布机制、`git subtree` 为什么必要、以及本地/远程 `main` 的差异，见
[`../probe/README.md`](../probe/README.md) 的「发布到 GitHub」一节。

---

## 1. 它现在装在哪、怎么装的

| 项 | 值 |
|---|---|
| 插件源码 | 本仓库根目录（克隆后就是你放它的地方） |
| 展示名 | **DSH-Voice** —— 只改了 `locale/zh.json`、`locale/en.json` 的 `title` 和 `client.js` 的 `zh.title` / `en.title`。**包名仍是 `@local/dsh-voice-chat`**，目录名、路由 `/dsh-voice`、数据目录 `%DSH_HOME%\voice-chat` 都没动 |
| profile | `%DSH_HOME%\profiles\desktop\` |
| 依赖形态 | `package.json` 里是 **`link:<插件目录>`**（符号链接，改源码即时生效）；用 `github:` 安装时是普通依赖 |
| 已选为 bundle | 同文件 `dsh.profile.bundles` 含 `@local/dsh-voice-chat` |
| 额外依赖 | profile 里另有 `onnxruntime-node@1.30.0`（`link:` 不会装被链接包的依赖，必须单独装） |
| 运行数据 | `%DSH_HOME%\voice-chat\`：`models/`、`vad/`、`voices/`、`config.json`（**没有 `plugin.log`**，`log()` 只写 stdout/stderr，从不落盘） |

**本机 profile 的三处手工改动**（要还原就改这三处）：

1. `package.json` — `link:` 依赖 + `dsh.profile.bundles` 追加（`dsh plugin add` 自动写的）
2. `pnpm-workspace.yaml` — pnpm 写下待决的 `allowBuilds: onnxruntime-node:`，已置为 **`false`**（win32/x64 二进制内置，脚本不需要跑）
3. `cordis.patch.yml` — 末尾加了 `- id: hmr` 覆盖，`root: [<插件目录>]`，**让 Host 半区改代码热重载**

---

## 2. 改完之后什么时候生效（最容易踩）

| 改了什么 | 生效方式 |
|---|---|
| `index.js`、`lib/*.js`（Host 半区） | **热重载**，保存即生效（实测 < 400 ms，靠上面第 3 条 HMR root） |
| `client.js`（浏览器半区） | **必须刷新页面**。客户端 bundle 是按文件元信息算版本的，且 Host 侧不会替你重导 |
| `cordis.patch.yml` 的 `config` | 热重载，配置层重组 |
| `package.json` 的 `dsh.client.inject` 等清单字段 | 需要重启 DSH |

> **热重载 = 完整 dispose + 重新 import**，不是"只重挂配置"。实测（2026-10-13）：写入 `index.js` 后，新代码生效与内存账本 `recent`/`recentStt` 由 8 清零**同时**发生，路由全程无 404 空窗（`webServer` 注册被原子替换）。两个代价必须记住：
> - **改 Host 代码会杀掉正在跑的识别 worker**（`index.js` 里 `stt.dispose()` 那个 effect）。**聆听中改代码，那一轮录音就废了**。
> - 内存账本 `recent` / `recentStt` 每次重载清零、无法跨重载累积；反过来说，改完代码再看账本就是干净基线。

**刷新页面的正确姿势**：DSH 桌面窗口**没有地址栏**，按 **F12** 开 DevTools（`main.js` 里无条件绑定），在 DevTools 里点刷新按钮或按 Ctrl+R。

> **别用浏览器开 `http://127.0.0.1:19387`** —— SPA 首页有 DSH 自己的 token 鉴权（`dsh-client-connection`），token 是每进程随机 `randomBytes`、只在内存里，手打地址必然 401。但 **`/dsh-voice/*` 不走那套鉴权**（只校验回环 + 同站点），所以用 curl 就能测。
>
> F12 刷新后 Console 应出现：`[voice-chat] client half loaded; seats: …`。看不到就是浏览器半区没加载。

---

## 3. 验证：6 个脚本，各有各的跑法

```powershell
$node = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$exe  = "<DSH 安装目录>\DeepSeek Harness.exe"   # 需 $env:ELECTRON_RUN_AS_NODE=1
$P    = "<本仓库同级>\probe"
```

> `probe/` **不在本仓库里** —— 它是本机开发侧的验证脚本与工具，随插件本体一起分发没有意义
> （也要跑真模型、真 GPU 环境）。下面提到 `probe/...` 的地方只对做过本地开发的维护者成立。

脚本已按用途分目录：`probe/verify/`（验收门禁）、`probe/tools/`（按需工具）、`probe/design/`。
**每个脚本干什么、怎么跑，见 `probe/README.md`** —— 那里是权威清单，本节只记期望值。

| 脚本（在 `probe/verify/`） | 运行时 | 覆盖 | 期望 |
|---|---|---|---|
| `unit-tests.mjs` | 普通 node | CMVN 夹具、fbank、WAV 往返、端点状态机、TTS 请求形状、**客户端 `apply()` 注册 seat**、**胶球几何**、供应商归一化、版本比较、依赖区间 | 36/36 |
| `http-tests.mjs` | 普通 node | 真实回环服务器：越权、状态码、克隆计划、dev-tone、供应商增删查、依赖审查、版本检查 | 22/22 |
| `manifest-check.mjs` | **Electron-as-node**（要 DSH 里的 js-yaml） | 清单/patch/相对 import 一致性 | `consistent` |
| `worker-e2e.mjs` | **Electron-as-node**（sherpa 在 app.asar 里） | 真模型转写 + 噪声/静音拒识 + **降级路径** | 7/7 |
| `live-verify.mjs` | **Electron-as-node** | 打运行中的 GUI，18 项含真 MiMo 合成 | 18/18 |
| `firered-spike.mjs` | 普通 node + `$env:DSH_VOICE_MODULE_DIR=<profile>` | FireRedVAD 数值闸门（语音 vs 噪声 vs 静音） | PASS |
| `vad-backends.mjs` | **Electron-as-node** | 子进程逐个验 ten/silero 是否可用——sherpa 模型不对时会 `exit(-1)`，只能靠子进程观察 | 见输出 |

另外两件**改 UI / 改样式必跑**的：

- `probe/design/render-orb.mjs`（普通 node）：从 `client.js` 抽出**真正发出去的那段 CSS**，
  校验它引用的每个 class 组件都渲染了，再生成可截图 HTML。**这个错犯过三次**（B 的胶囊条、
  C 的球体透明、C 的水波纹），每次都是选择器写对了但**作用域方向写反**（`[data-state] .th-c`
  而 `data-state` 挂在 `.th-c` 的子孙上），规则永不匹配。
  > 预览页支持 **`?freeze=<秒>`**：把展开动画定格在那一刻，用于对**动画中间帧**截图取证
  > （截图工具抓不到运动中的画面，这一招抓出过两个真问题）。再加 `?skin=dark` 看暗色。
- `live-verify.mjs`：它同时验证「浏览器半区已注册为 client module」。

**省 token 的跑法**：只改 `client.js` 时跑 `unit-tests` + `live-verify` 就够，**不要每次全跑 5 套**；输出只取 `Select-Object -Last 3`，别把整篇日志倒进对话。

---

## 4. 编辑纪律（本会话膨胀 8.7 MB 的主因）

- **能用 `edit` 就别 `write` 整文件**。`client.js` 现在 **100 KB**，整篇重写一次 = 100 KB 输出，
  而且之后**每一轮**都要重新读进上下文。
- **绝不要用 `Get-Content` / `Set-Content` 往返文本文件。** 本机是 **Windows PowerShell 5.1**，
  `Get-Content` 默认按 **ANSI(936)** 解码、`Set-Content -Encoding utf8` 会**加 BOM** ——
  一次批量替换就把 11 个脚本的中文变成乱码（`测试一下。` → `娴嬭瘯涓€涓嬨€?`），
  而且每处会丢掉紧随其后的一个 ASCII 字符（引号、斜杠），**语法直接崩**。
  真要在 PowerShell 里改文件，必须走 .NET 且显式指定编码：
  ```powershell
  $utf8 = [System.Text.UTF8Encoding]::new($false)      # $false = 不写 BOM
  $t = [System.IO.File]::ReadAllText($p, $utf8)
  [System.IO.File]::WriteAllText($p, $t.Replace($a,$b), $utf8)
  ```
  事后的体检方法：`[System.Text.UTF8Encoding]::new($false,$true).GetString($bytes)` 抛异常即非法。
- `client.js` **必须是单文件、无构建步骤**（`window.__ModuleLoader__.load({id, factory(require){…}})` 形式）。没有 JSX，用 `React.createElement`。想拆文件要改 `dsh.client.external` 和 chunk 约定，不值当。
- 改前先读**目标文件的那一段**，不要整篇读。
- 探索类任务丢给 subagent（它们有独立上下文，不进主对话）。
- **这个工程有 git**（仓库根在 `../`，不是"没有 git"—— 曾这么记过，是错的）。发布走
  `../probe/tools/publish.ps1`，它自己管分支、标签与推送；**不要手工 `git push`**
  （本地 `main` 与远程 `main` 没有共同祖先，理由见 `../probe/README.md`）。
  改完先 `git status` 看清工作区，再 `git add -A && git commit`。

---

## 5. 1.1.0 新增的机制（改这块时先读这段）

### 供应商是数据，不是代码

每个供应商自带 `kind`（由哪个适配器接管：`mimo` / `openai-speech` / `dev-tone`），
外加自己的地址、模型、音色、格式与凭据。新增供应商**不需要改适配器**。

- `lib/tts.js` 的 `BUILTIN_PROVIDERS` 是内置表，`normalizeProviders(config)` 把它与
  `config.tts.providers` 合并，**并把旧的扁平字段（`tts.baseUrl` / `tts.model` / `tts.apiKey` …）
  归一化进当前选中的供应商**。磁盘上的原字段不动，所以旧配置照常能读。
- **别再用「值为空才填」的写法做迁移**：内置供应商自带默认地址，用户写在扁平字段里的值会被默认值
  盖掉。归一化时要区分「内置默认值」与「用户配置过的值」——`normalizeProviders` 里的
  `configured` 表就是干这个的。
- `/state` 与 `/providers` **绝不返回明文 Key**，只有 `hasKey` 与 `keySource`。改这两处时
  记得跑 `http-tests.mjs` 里那两条专门盯这件事的用例。

### 人物设定走 systemPrompt，不走 session.prompt

`session.prompt` 的 content schema 只允许 `text` / `image` / `file`，**没有 system 角色**。
所以人设走 `ctx.get('systemPrompt').section({ name, order, text })`：

- 段落名固定为 `deployment:persona-suffix`（**同名即替换**，不是追加），所以改人设不用重启。
- `order` 取 `systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`（当前是 10200）。
- 插件卸载时要 dispose 这个 section，否则段落会留在提示里。

### 版本更新不架服务器

直接问 GitHub Releases API，失败回落到 `gh-proxy.com` 镜像，**两个源都实测 200**。
匿名调 GitHub 只有 **60 次/小时**，所以结果按小时缓存（`UpdateChecker`），而且每次请求都带超时。
取不到就如实说取不到，**不猜版本号**。

### 依赖审查与安装：别用 `pluginManager.installBundle`

它只接受 bundle：`manifest?.dsh?.bundle === undefined` 会抛 `not-bundle`，而且**会回滚**
`package.json` 与 `pnpm-lock.yaml`。装普通依赖要直接调 DSH 自带的 pnpm：

```
<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs
```

（`pnpm` **不在 PATH** 上。）装到当前 profile 目录，用 `process.execPath` 起进程、
`ELECTRON_RUN_AS_NODE=1`，参考 `lib/stt.js` 起 worker 的写法。

---

## 6. 用到的 DSH API（照抄即可）

```js
// Host 半区（index.js）
export const inject = ['webServer'];
export function apply(ctx, rawConfig) {
  ctx.get('profileContext')            // { dir, installAnchor, home, … }  ← 原生依赖解析根
  ctx.webServer.register({ kind: 'prefix', path: '/dsh-voice', handler })  // handler(req,res)
  ctx.effect(() => () => cleanup(), 'label')
}

// 浏览器半区（client.js）
return { inject: ['slots', 'locale', 'sessions'], apply(ctx) {
  ctx.locale.register('voiceChat', { zh, en })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'voice-chat-bar', order: 2,
      locale: 'voiceChat', inject: (sessionId) => face }, Component))
  // 发消息：
  ctx.sessions.binding(sessionId).session.prompt([{ type: 'text', text }], 'steer' | 'queue')
}}
```

- **`inject` 回调收到的是 session-scope key（会话 id）**，来自 `runInject` 的 `binding.key`。
- 两个 seat：`conversation.input.dock`（胶球）、`conversation.input.left`（隐藏的回复监听，靠 `props.useChat` 读 assistant 文本）。
- localStorage：`dsh.voice.enabled` / `dsh.voice.interrupt` / `dsh.voice.voice` / `dsh.voice.language`。
- 单测钩子：`client.js` 返回的 `__internals = { splitSentences, cleanReplyText, chatNodes }`（给 `unit-tests.mjs` 用，别删）。
- **样式表是插件自己注入的**（`ensureStyleTag()`，`<style id="dsh-voice-styles">`，在 `ctx.effect` 里挂载/清理）。原因：keyframes、伪元素、`prefers-reduced-motion` 没法用内联样式对象表达。全部选择器都挂在 `.dshv` 前缀下，不污染应用；亮暗靠 `body[data-ds-dark-theme] .dshv` 切一组 `--dshv-*` 变量。
  > **CSS 注释里绝对不能出现反引号** —— 那段 CSS 是 JS 模板字符串，一个反引号就把字符串截断了（踩过一次，`node --check` 立刻抓到）。写注释要说"the transform property"，不要写代码样式。
- **图标是内联 SVG**（`PATHS` + `Icon`），不再用 emoji；颜色一律 `currentColor`。
- **胶球是固定定位浮层**（不是原来那个内联工具行）。位置存 `dsh.voice.pos`（视口比例），拖动时**直接写 `left/top`、不走 state**（`useLayoutEffect` 只在 `position` 变更时应用），否则重渲染会把正在拖的球拽回原位。拖动与点击用 5px 阈值区分。
- **几何四个纯函数**（`viewportBounds` / `clampPosition` / `snapToEdge` / `layoutFan`，加内部的 `orientBeam` + `reflectBeam`）都接受可注入的 **rect**（`{x, y, width, height}`，不是 `{width, height}`），并且导出在 `__internals` 里 —— `unit-tests.mjs` 有一整套边界用例（四个角 + 边线 + 中央 + 一个 200×200 窄区强制走反射路径，逐个断言包围盒不出界、两两不重叠）。**改这几个函数必须跑单测**，边角行为眼睛看不可靠。
- **可移动区域是运行时从 DOM 量的**（`resolveBounds`）：从胶球往上找最近一个 `overflow-y: auto|scroll|hidden` 且宽高都 ≥ 240 的祖先 —— 实测就是对话面板。量到的 rect 是**视口坐标**，跟 `position: fixed` 的 `left/top` 同一坐标系；存盘按这块 rect 的比例存。**吸边只在离边小于一个球直径（`ORB_SIZE`）时触发**，更远就停在原地；`snapToEdge` 因此返回 `{x, y, edge}` 或 `null`。吸住后 `edge` 会存进 `dsh.voice.pos`，`layoutFan` 拿到它会改成 `edgeLayout()` 的**沿边平行排布**（竖边排成一列、横边排成一行），而不是扇形。
- **"瘫软耷拉"的形变在 `.dshv-gel` 上，不在 `.dshv-orb` 上**：`[data-attached]` 只改 `--dshv-sx/sy/sag/tilt` 四个变量，由 wrapper 的 `transform` 合成。**千万别把它写成 `.dshv-orb` 的 `border-radius`** —— 那个属性在聆听/朗读时由 JS 每帧写（`waveRadius`），任何动 `border-radius` 的 CSS 都会盖掉行内样式。转场的 `transition` 也只挂在 idle/notready 上，否则电平表会拖尾。
- 想核对"发出去的 CSS 到底长什么样"，跑 `node probe/design/render-orb.mjs`：它从 `client.js` 里**抽出那段真 CSS**，检查它引用的每个 class 组件里确实渲染了，再用它生成可截图的 HTML。

---

## 7. 七条不能破的不变式（细节见 README）

1. **fbank 样本必须先乘 32768** —— Kaldi 前端按 int16 幅度域标定，否则所有 log-mel 下移 `ln(32768²)`，模型对所有输入判"不是语音"。
2. **必须比 sherpa 先加载 `onnxruntime-node`** —— 两者都带 `onnxruntime.dll`，Windows 按文件名绑定已加载的同名库，顺序反了就是 `ERR_DLOPEN_FAILED`。
3. **原生依赖靠 `profileContext` 给锚点** —— `link:` 安装时插件的真实路径在用户目录，Node 向上查找永远进不了 profile 的 `node_modules`。
4. **别把缺失/不匹配的 VAD 模型交给 sherpa** —— 它的 C++ 层直接 `exit(-1)`，JS 拦不住，整个 worker 会静默消失。降级时必须**重算该后端自己的模型路径**（曾经把 FireRedVAD 的路径喂给 ten-vad，就是这个坑）。
5. **worker 的 stdout 只有一行**（就绪 JSON）—— 诊断一律走 stderr（`useStderrDiagnostics()`）。
6. **胶球永远透明，状态只改图标颜色** —— 绝不给球体上 `background`。踩过：CSS 写 `[data-state="x"] .th-c .orb`（`data-state` 在 `.dock` 上、`.th-c` 是它的**祖先**），规则永不匹配，通用的实心色规则就把整颗球刷红了。**作用域要写成 `.dshv[data-state="x"] .dshv-orb`**。
7. **朗读时的轮廓与震动分工不能混** —— `border-radius` 由 JS 每帧写（`waveRadius()`，四组互质频率 + `Speaker.level()` 的响度），CSS 只碰 `transform`（`dshv-tremble`）。若给同一个元素再加一条会动 `border-radius` 的动画，动画会盖掉行内样式，波形就没了。打断时 `useEffect` 的清理必须把 `border-radius` 置空，否则球会僵在变形形状上。

---

## 8. 已知缺口 / 下一步可做

- **400 ms 预滚修复尚未在你浏览器里生效**（要刷新页面）。它解决的是：打断时"确认开口"需 220 ms，之前的实现从确认那一刻才开始录音，导致打断那句话**第一个字被切掉**（实测文本里出现过 `妈听。`、`阿西得`）。
- **生僻专有名词识别不准**：`纳西妲` → `阿西得`。SenseVoice 词表里没有这个词。可选方案：同音替换后处理 / 换支持热词偏置的识别模型 / 改称呼。
- **`recent` / `recentStt` 账本会把回归测试的记录混进去**（`live-verify.mjs` 每次跑都写几条）。想分开就给测试请求加个标记字段。
- **打断阈值是按耳机调的**（振幅 0.06 / 持续 220 ms）。外放音箱更容易误触发。
- ~~UI/交互优化的着手点~~ —— **1.0.1 已处理**：设置面板重排（粘性头 / 音色卡片 / 主按钮）、
  展开收起的滑动与文字延迟、底部避让到输入框上方、报错气泡可关。再动这一块时：
  几何都在 `dockLayout` / `dockCentre` / `refit` 这组纯函数里（单测盯着），
  动画只在 `.dshv-node` 与 `.dshv-bead` 两条 CSS 规则上。
