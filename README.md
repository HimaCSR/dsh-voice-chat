# DSH-Voice 语音对话插件（`@local/dsh-voice-chat`）

给 DeepSeek Harness 加一套**完全本地**的语音输入 + **在线**语音输出：说话就识别、回复就朗读，你开口说话它立刻闭嘴听你说。

| 能力 | 实现 |
|---|---|
| 语音识别（STT） | **本地 SenseVoice-Small**（int8 ONNX，228 MB，CPU 推理，sherpa-onnx） |
| 断句 / 端点检测（VAD） | **FireRedVAD**（官方 ONNX，本插件自己实现的 Kaldi fbank + CMVN + FSMN 流式推理） |
| 语音合成（TTS） | **线上 API，默认小米 MiMo**（`api.xiaomimimo.com`），也支持任意 OpenAI 兼容的 `/audio/speech` |
| 声音克隆 | MiMo `mimo-v2.5-tts-voiceclone`：上传 5~20 秒参考音频即零样本克隆，无需训练、无参考文本 |
| 插话打断（barge-in） | 朗读中你一开口，立即停播 + 中止在途合成 + 丢弃本轮剩余句子，你这句话成为新一轮 |

不需要 NVIDIA 显卡、不需要 WSL、不需要 Python、不需要编译——全部跑在 DSH 自己的进程里。

---

## 1. 安装

插件以 **bundle 包**形式交付，没有构建步骤。安装会把包写进 `desktop` profile，改动对该 profile 的所有会话生效。

### ⚠️ 装之前先知道这 4 件事（**不是一步到位**）

**① 装完必须再下模型 —— 这一步不能省。** 插件不含模型文件，共 **228 MB 起**（SenseVoice 识别模型 + FireRedVAD + TEN-VAD 兜底）。装好后打开设置面板点「**下载并准备本地模型**」，等进度条走完。没下模型时只有 UI，识别和朗读都不工作（球会显示琥珀色 ⚠）。

**② 需要本机有 git，且能连上 GitHub。** `github:` 安装由 pnpm 调 git 拉取代码。网络对 GitHub 不稳时（连接被重置），改用**方式 B 的本地 zip** 更可靠。

**③ `onnxruntime-node`（解包 287 MB）是可选的。** 它只服务 FireRedVAD 端点检测：

- 用 `github:` 安装 → pnpm 会**自动装**，无需干预
- 用本地 `link:` 安装 → pnpm **不会**装被链接包的依赖，要单独跑一条
  ```powershell
  dsh plugin --profile desktop add onnxruntime-node@^1.30.0
  ```
- **不装插件也能用**：会自动降级到 TEN-VAD，只影响断句精度，并在设置面板与 `/dsh-voice/state` 的 `vadNote` 里说明原因

**④ 朗读需要 API Key，但这是可选的。** 语音识别**完全本地、零 Key**；只有语音输出需要配一个 MiMo（`api.xiaomimimo.com`）或任意 OpenAI 兼容的 Key。不配就是「能听不能说」。

一句话总结：**一行装插件 → 点一下下模型 = 能听；再配个 Key = 能说。**

**方式 A：一行安装（推荐）**

```powershell
dsh plugin --profile desktop add github:HimaCSR/dsh-voice-chat
```

**方式 B：Web 界面**

1. 侧栏 → **插件** → **添加插件**
2. 在输入框里粘贴插件目录的绝对路径，例如：
   ```
   <你放置插件的目录>\dsh-voice-chat
   ```
3. 点 **安装**，装完点 **立即启用**
4. 刷新页面（`Ctrl+R`）

**方式 C：Creator 预设 + `plugin_manager`**

把会话切到 **cordis（Creator）** 预设，然后让 agent 用 `plugin_manager` 的 `install_bundle`、`target` = 上面的绝对路径。
然后把包名 `@local/dsh-voice-chat` 追加到 `%DSH_HOME%\profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组，重启 DSH。

> **实测记录（本机）**：`dsh plugin --profile desktop add "<路径>"` 会同时完成两件事——以 `link:` 方式把插件装进 profile 的 `node_modules`，并把包名追加进 `dsh.profile.bundles`。跑完插件**当场就生效了**（Web 配置层热重载），不需要重启。
> **之后改插件代码不必重启**：profile patch 末尾给 `@deepseek-ai/dsh-hmr` 配了 `root` 指向插件目录，Host 半区（`index.js` / `lib/*.js`）保存即热重载。实测（2026-10-13）：写入 `index.js` 后，下一次 400 ms 采样就已在 `/dsh-voice/state` 里看到新代码，路由全程无 404 空窗。生效矩阵与两个代价见 DEVELOPING §2。
>
> **关于依赖**：`dsh plugin add <路径>` 用的是 `link:` 协议，pnpm **不会**顺带安装被链接包的依赖，所以 `onnxruntime-node` 要单独装一次：
> ```powershell
> dsh plugin --profile desktop add onnxruntime-node@^1.30.0
> ```
> 它在 Windows x64 上**自带预编译二进制**，安装脚本只是去取 CUDA/TensorRT 那两个用不到的可选组件，因此：
> - pnpm 报 `ERR_PNPM_IGNORED_BUILDS: onnxruntime-node` 是**正常且无害**的（本机已实测：不跑脚本，原生绑定照样加载、推理照样成功）；
> - 本机把 profile 的 `pnpm-workspace.yaml` 里 pnpm 写下的 `allowBuilds: onnxruntime-node:` 置为 `false`，即明确拒绝执行该脚本，插件功能不受影响。想改成允许就把它设为 `true`；
> - `onnxruntime-node` 解包约 287 MB，只用于 FireRedVAD。**没装上也不会让插件挂掉**——它会自动降级到 TEN-VAD，并在设置面板与 `/dsh-voice/state` 的 `vadNote` 里说明原因。

---

## 2. 第一次使用：下载模型

**插件本体不含模型文件**，装完只有界面：球是琥珀色，旁边显示 **⚠ 语音模型未就绪**。

点那颗球 → 展开 → **设置**（齿轮）→ 点「**下载并准备本地模型**」，等进度条走完。

### 会下哪几个文件

默认配置（`precision=int8`、`vadBackend=firered`）取回 **6 个文件，约 233 MB**：

| 文件 | 大小 | 用途 | 来源 |
|---|---|---|---|
| `sensevoice.int8.onnx` | **228 MB** | **语音识别主模型** | Hugging Face（不通时自动走 `hf-mirror.com`） |
| `tokens.txt` | 309 KB | SentencePiece 词表 | 同上 |
| `fireredvad_stream_vad_with_cache.onnx` | 2.2 MB | **端点检测主模型** | FireRedVAD 官方仓库（不通时自动走 `gh-proxy.com`） |
| `cmvn.ark` | 1.3 KB | FireRedVAD 的 CMVN 参数 | 同上 |
| `ten-vad.onnx` | ~1 MB | FireRedVAD 起不来时的兜底 | sherpa-onnx releases（同样有 `gh-proxy.com` 回退） |
| `silero_vad.onnx` | 1.7 MB | 第二个兜底 | Hugging Face |

> 两个兜底加起来才几 MB，但**必须一起下**：sherpa 的 C++ 层在 VAD 文件缺失时直接 `exit(-1)`
> 杀掉识别进程，而不是降级 —— 一个"要先下载才能用的兜底"等于没有兜底。

### 落在哪里

```
%DSH_HOME%\voice-chat\          （默认 C:\Users\<你>\.dsh\voice-chat\）
├── config.json                 ← API Key 等配置，只在本机
├── models\
│   ├── sensevoice.int8.onnx
│   └── tokens.txt
├── vad\
│   ├── firered\
│   │   ├── fireredvad_stream_vad_with_cache.onnx
│   │   └── cmvn.ark
│   ├── ten-vad.onnx
│   └── silero_vad.onnx
└── voices\                     ← 克隆出来的音色，一个目录一个
```

下载是**幂等**的：已完整且校验通过的文件跳过，缺的或校验不过的才重拉，中断的半个文件不会被当成完整的。
所以卡住了直接再点一次即可；**升级插件也不会重新下载**。

### 下载失败怎么办

1. **内置两级镜像回退**，一般不用管：HuggingFace → 自动追加 `hf-mirror.com`；GitHub → 自动追加 `gh-proxy.com`。
2. **手动放文件**（终极办法）：按上面的目录结构把文件放好。插件会自己校验大小与 SHA-256，
   校验通过就直接用，不会再下载。
3. **复用 DSH 自带的 SenseVoice 缓存**：本插件与 **DSH 内置 SenseVoice provider 钉的是同一个 revision**，
   把配置项 `stt.modelDirectory` 指向那个已存在的目录即可，省下 228 MB。

> 嫌 228 MB 大？`int8` 已是默认；`fp32` 要 **894 MB** 且更慢，不建议。

---

## 3. 配置 TTS 供应商

### 默认：小米 MiMo

在 [小米 MiMo 开放平台](https://mimo.mi.com/) 申请 API Key，然后**二选一**：

- 设环境变量 `MIMO_API_KEY`（推荐，Key 不落盘）；
- 或在插件设置面板的 **MiMo API Key** 输入框里填（保存在 `%DSH_HOME%\voice-chat\config.json`）。

**没有 Key 时**：识别、断句、插话打断全都照常可用，只有朗读会返回明确的 `no-api-key` 错误，不会静默失败。想先验证整条朗读链路（句子切分 → 合成请求 → 队列播放 → 打断），把 `provider` 改成 `dev-tone`，它会生成一段长度随句子变化的提示音。

### 也可以换成别的供应商

设置面板的**高级设置**页里有供应商下拉与配置表单，可以自己加。内置的**硅基流动 SiliconFlow** 是已验证可用的参考配置，点一下即填入表单，剩下的只要补上自己的 Key：

| 参考配置 | 地址 | 模型 | Key 从哪来 | 克隆 |
|---|---|---|---|---|
| **硅基流动 SiliconFlow** | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` | [siliconflow.cn](https://siliconflow.cn/) 注册后取 | 支持 |

> OpenRouter 曾是内置参考配置之一，已移除：它的免费档不路由到支持克隆的端点，推荐它等于许诺做不到的事。适配代码仍在，需要的用户可以自行添加。

表单里要填的东西：名称、接口格式（`mimo` 走 chat/completions，`openai-speech` 走 `/audio/speech`，`siliconflow` 走 `/audio/speech` 并多一步音色注册）、地址、模型、音色、音频格式、API Key 或环境变量名。

两点要留意：

- **格式不能乱填**。有些服务只收 `mp3` 与 `pcm`，填 `wav` 会被拒掉。填 `pcm` 时插件会自己包成 WAV 容器。
- **克隆能力是供应商的属性**，由接口格式决定，不能随手勾上。给不支持克隆的供应商发克隆请求会明确报 `clone-unsupported`，而不是悄悄按普通音色合成。

### 声音克隆：两家都能克隆，流程不同

| 供应商 | 怎么克隆 | 参考音频的文字 |
|---|---|---|
| **小米 MiMo** | 一次调用，参考音频作为 data URI 随请求发过去 | 不需要（zero-shot） |
| **硅基流动 SiliconFlow** | 两步：先把参考音频注册成音色，拿到音色 id，再用 id 合成 | **需要**，用它与音频对齐 |

硅基流动的音色 id 会被缓存下来，注册一次就好；参考音频换了才会重新注册。音色库里本来就存着参考音频对应的文字（`ref_text.txt`），硅基流动下设置页会把它标成必填。

克隆请求是幂等的，**限流与超时都会自动退避重试**：429 / 503 最多重试三次（间隔 0.7s / 1.4s / 2.8s），超时再试一次。

自己加的供应商存在 `tts.providers` 里（见第 8 节），删除走 `DELETE /providers?id=`；内置的删不掉。

### MiMo 的接口形状（实现依据）

> 顺带一提：MiMo 的 **TTS 模型没有下线**。官方退役通知只涉及文本模型 `mimo-v2.5` / `mimo-v2.5-pro`（2026.10.21 退役，改为 v2.6-flash / v2.6-pro），`mimo-v2.5-tts` / `-voiceclone` / `-voicedesign` 仍在文档里，所以插件默认的模型名不变。

它**不是** OpenAI 的 `/v1/audio/speech`，而是复用 chat completions：

```http
POST https://api.xiaomimimo.com/v1/chat/completions
api-key: <KEY>            # 也接受 Authorization: Bearer <KEY>

{
  "model": "mimo-v2.5-tts",              // 克隆时用 mimo-v2.5-tts-voiceclone
  "messages": [
    { "role": "user",      "content": "风格指令，不会被念出来" },
    { "role": "assistant", "content": "真正要念的文本" }   // ← 文本必须在 assistant
  ],
  "audio": {
    "format": "wav",
    "voice": "mimo_default"              // 克隆时是 data:audio/wav;base64,……
  },
  "stream": false
}
```

音频在 `choices[0].message.audio.data`（base64）。克隆约束：参考音频只能是 **wav/mp3**，base64 后 **≤ 10 MB**，且克隆不支持流式。

想确认"到底会发什么"而不真的发请求：`POST /dsh-voice/tts/plan` 会返回将要发送的 model、消息角色顺序、voice 类型和数据长度、以及 header 名字。

---

## 4. 使用

输入框上方是一颗**透明胶球**（iOS 控制中心那套磨砂玻璃材质）。点它，大珠子碎成四颗小胶球，各带功能名：

| 小胶球 | 作用 |
|---|---|
| **麦克风** | 点一下开始**连续聆听**：说完停顿约 0.9 秒自动把识别文字发出去；再点一下停止 |
| **朗读** | 回复逐句朗读的总开关（localStorage `dsh.voice.enabled`） |
| **插话 / 排队** | **插话**：处理中你一说话就打断当前轮次（`steer`）。**排队**：等当前回复说完再接（`queue`） |
| **设置** | 设置面板：引擎状态、模型准备、音色切换/新建、API Key、识别语言 |

音色名**不再显示在按钮上**，改在设置面板里选。

### 胶球是怎么动的

球在任何状态下都**保持透明** —— 只有里面的图标换色：待机/朗读为常规色，聆听为红，识别中与未就绪为琥珀。

| 状态 | 表现 |
|---|---|
| 待机 | 轮廓按 9.3 秒一轮的不规则关键帧缓缓起伏（纯 CSS） |
| 聆听 / 识别中 | 三圈同心水波向外荡（2.4s / 1.35s），叠加亚像素级高频震动 |
| 朗读中 | 轮廓由**真实音频**驱动：`Speaker` 里的 `AnalyserNode` 给出响度，四组互质频率（0.27 / 0.41 / 0.63 / 0.19 Hz）的正弦叠加算出 `border-radius`，所以永远看不出循环 —— 像浪一样此起彼伏，音量越大起伏越明显 |

### 把它挪到顺手的地方

胶球是**固定定位的浮层**，可以拖着走：

- **可移动区域是对话区**，不是整个窗口 —— 胶球只用**对话面板**那块矩形，所以它不会飘到侧栏或标题栏上。这块区域是运行时从 DOM 找出来的（离它最近的一个 `overflow: auto/scroll/hidden` 且够大的祖先容器），找不到才退回整个窗口。
- **靠近边缘才吸**：松手时只有**离边小于一个大水球的直径（52px）**才会吸上去 —— 更远就停在原地不动。吸上之后只保留垂直于那条边的坐标。
- **吸住时球会瘫软耷拉**：贴边的那一侧被压扁、整体朝下坠一点、还带 10° 的倾斜（贴在左/右边缘时），从上边缘吸住则竖向压扁、向下坠。就是一颗挂在玻璃上的水珠，不是一个球。
- **底边上收到输入框顶部**：可移动区域的下边界不是对话面板的真正底部，而是**输入框（composer）的顶边**再留 6px —— 否则吸到底部会把 token / 缓存命中那行读数压住。
- **展开是平滑滑动**：四颗按固定间距**排到离球最近的那条边**上并**贴着边**（0 内缩，贴边那一侧压扁，和大球同一个姿态），三颗依次错开 0.03 / 0.09 / 0.15 秒。四颗之间**没有排斥、也没有边缘反弹** —— 间距本身就是分开它们的唯一手段；边太短时整列收紧并整体平移，保证不越界。
- **文字与图标落定后才出现**：飞行途中只有水滴，站定之后功能名与图标才淡入。贴顶边时标签也在**上方**（放到下方会被对话文字穿过）。
- **收起时沿边聚拢**：四颗顺着那条边滑到一处、在那里融回大球，**大球就出现在它们聚拢的位置**（而不是展开前的地方）。
- 位置按**对话区比例**存进 localStorage（`dsh.voice.pos`）；拖动分隔条或缩放窗口时重新测量，吸附中的球会跟着那条边逐帧移动（拖动期间关掉定位缓动，所以不再滞后）。
- **点球体**展开/收起。展开后**点界面任何别的地方**（或按 Esc）四颗小胶球自动收回成大胶球 —— 点设置面板里的按钮则不会收回。
- 想重置位置：清掉 localStorage 的 `dsh.voice.pos`。

`prefers-reduced-motion: reduce` 时所有波动、震动、水波都会关掉。

### 出错了怎么告诉你

朗读失败、识别失败、麦克风打不开这类错误，会在球旁边显示成一个**红色气泡**：

- 按球所在的半边自动排到**有空间的一侧**（球贴右边缘时气泡在左边），限宽、最多三行，完整文本在 `title` 里；
- 点 **✕** 关掉它，点正文**打开设置面板**（面板的「运行状态」区始终保留完整错误）；
- 下一次识别成功或朗读成功时旧错误自动消失；持续性的问题（比如没配 Key）会再报一次。

模型未就绪是**状态**而不是错误，所以球旁边显示的是琥珀色的 **⚠ 语音模型未就绪** 按钮（点它开设置），两者不会同时出现。

### 声音克隆

设置面板 → **新建克隆音色**：填音色名 + 选参考音频（wav/mp3，**5~20 秒干净人声**最稳）+ 可选填"这段话说了什么"。创建后在 **音色** 下拉里选它，朗读就会走 `mimo-v2.5-tts-voiceclone`。

音色库在 `%DSH_HOME%\voice-chat\voices\<音色名>\`，每个音色一个目录，里面是 `ref_audio.wav|mp3` + `ref_text.txt` + `meta.json`。想批量添加就直接建目录放文件，刷新设置面板即可看到。

---

## 5. 工作原理

```
浏览器（DSH Web GUI，同源）
 ├ 语音水珠     conversation.input.dock   透明胶球 → 点开碎成四颗功能小珠
 └ 回复监听器   conversation.input.left   读 assistant 流式文本 → 逐句 TTS → FIFO 播放
        │  fetch /dsh-voice/*      （同源，无 CORS，无第二个端口）
        ▼
DSH Host 进程（插件 index.js）
 ├ WebServer 前缀路由 /dsh-voice  →  仅回环 + 同站点校验
 ├ 模型资产管理  lib/assets.js      固定 size + SHA-256，HF → hf-mirror 回退
 ├ 克隆音色库    lib/voices.js      <dataRoot>/voices/<名>/
 └ SttService    lib/stt.js  ──spawn(Electron-as-node)──▶ lib/worker.js 子进程
                                                            └ sherpa-onnx: SenseVoice
                                                            └ onnxruntime-node: FireRedVAD
```

**为什么 STT 放子进程**：原生推理崩溃或吃爆内存时，死掉的是一次性子进程而不是 DSH 本体；静默 5 分钟后回收约 250 MB 常驻内存。

**为什么插话检测在浏览器侧**：等一次网络往返判断"用户开口了"会给每次打断加几百毫秒。本地 RMS 门限（AEC + 噪声门 + 220 ms 保持）负责即时打断；宿主侧 FireRedVAD 负责**认定这段音频里到底有没有人说话**——所以噪声误触发的录音会在识别之前就被丢掉，不会变成幽灵消息。

> **打断时的 400 ms 预滚**：门限需要持续 220 ms 才敢确认"用户真的开口了"，如果确认那一刻才开始录音，这句话的**第一个字就已经过去了**。实测里表现得很清楚——打断那次的识别结果是 `妈听。哎，现在你真的停了…`，开头两个字是被切掉后语音模型对残片作出的猜测。所以打断模式下会一直保留最近 400 ms 的音频，触发时把它接回录音开头。这是客户端改动，改完**刷新页面**才生效。

**为什么 API Key 只在宿主**：Key 永不下发到页面，浏览器只调用同源的 `/dsh-voice/tts`。

### FireRedVAD 是怎么跑起来的

sherpa-onnx **任何版本都不支持 FireRedVAD**（C API 只认 Silero 和 TEN-VAD，上游支持 PR #3392 至今未合并），所以本插件直接跑官方 ONNX 图，并把周边管线用 JS 重写：

```
波形 → Kaldi 兼容 80 维 log-mel fbank → CMVN
     → FSMN 流式图（带 8×128×19 缓存，10 ms 一帧）→ 逐帧语音概率 → 端点状态机
```

数值约定全部取自上游源码（`audio_feat.py` / `stream_vad_postprocessor.py`）而非猜测。实现中有三个**踩过的坑**，改动前请先读 `lib/firered-vad.js` 与 `lib/sherpa.js` 的注释：

1. **样本必须先缩放 32768 倍**。Kaldi 特征前端是按 int16 幅度域标定的（kaldi 的波形读取器直接把 int16 值喂进去），喂归一化到 [-1,1] 的浮点会让每个 log-mel 值整体下移 `ln(32768²) ≈ 20.8`，模型于是对**所有**输入都判"不是语音"（实测：清晰语音上非流式图峰值只有 0.004）。
2. **必须比 sherpa-onnx 先加载 onnxruntime-node**。两者都带一个叫 `onnxruntime.dll` 的文件，Windows 按文件名绑定已加载的同名 DLL：先加载 sherpa 会钉住它那份旧版本，之后 onnxruntime-node 的绑定直接 `ERR_DLOPEN_FAILED`（"The operating system cannot run %1"）。已验证反过来加载时两个运行时都能正常工作。
3. **原生依赖要靠 DSH 告诉插件它在哪**。`dsh plugin add <路径>` 用 `link:` 把插件链进 profile，插件的真实文件仍在用户自己的目录里；Node 从**真实路径**向上查找，永远进不了 profile 的 `node_modules`。所以 Host 半区从 DSH 自己的 `profileContext` 服务读 profile 目录，把解析根随 payload 传给子进程（`lib/sherpa.js: setModuleAnchors`）。`GET /dsh-voice/diag` 会把实际解析结果显示出来。
4. **别把缺失的 VAD 模型交给 sherpa**。sherpa-onnx 的 C++ 层在 VAD 文件不存在时会直接 `exit(-1)`，JS 层 `try/catch` 拦不住，整个识别进程会静默消失。所以 `lib/vad.js` 在构造前先 `existsSync`，缺文件就走可捕获的错误路径。

### 降级策略

`vadBackend` 默认 `firered`。只要 FireRedVAD 起不来（onnxruntime 没装、模型缺失、数值不过闸），插件**不会静默换掉**，而是：

- 自动回退到 `ten`（TEN-VAD，再不行 `silero`），
- 在**设置面板**和 `GET /dsh-voice/state` 的 `vadNote` 里**写明实际用的是哪个 VAD 以及原因**。

---

## 6. 设置面板的三个页签

设置面板原本是一整页，越加越长。现在拆成三页签，插件自身的状态（就绪、报错、模型下载进度）留在页签之上，因为它描述的是插件而不是某一项配置。

| 页签 | 放什么 |
|---|---|
| **音色偏好** | 音色下拉、已克隆音色卡片与试听、克隆上传（仅在当前供应商支持克隆时出现） |
| **人物设定** | 人物设定、语气指令、识别语言 |
| **高级设置** | 供应商下拉与供应商配置表单、两个灵敏度滑杆、模型准备说明、诊断 + 依赖审查、版本更新 |

版本更新按要求排在诊断之后。

---

## 7. HTTP 接口（`/dsh-voice`，仅回环 + 同站点）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | 引擎就绪度、模型准备进度、音色表、配置摘要、供应商列表、插件版本 |
| POST | `/stt?language=zh` | 16 kHz 单声道 PCM16 或 WAV → `{ text, segments, speechSeconds, inferenceSeconds }` |
| POST | `/tts` | `{ text, voice }` → 音频字节 |
| POST | `/tts/plan` | 同上但只回答"会发什么请求"，不联网、不返回音频 |
| GET | `/voices` | 音色列表 + MiMo 预设音色 |
| POST | `/voices` | `{ name, filename, refText, dataBase64 }` 新建/覆盖音色 |
| DELETE | `/voices?name=` | 删除音色 |
| GET | `/voices/sample?name=` | 参考音频字节（设置面板用它试听） |
| POST | `/prepare` | 启动模型下载（立即 202，进度看 `/state`） |
| POST | `/config` | 白名单字段持久化：`voice/apiKey/baseUrl/provider/model/cloneModel/format/instruction/language/vadBackend/persona` |
| GET | `/providers` | 供应商列表（**只有 `hasKey` / `keySource`，没有明文 Key**） |
| POST | `/providers` | 新增或修改一个供应商 |
| DELETE | `/providers?id=` | 删除一个用户自建的供应商（内置的删不掉） |
| GET | `/deps` | 依赖审查报告：版本、要求、来源、状态 |
| POST | `/deps/install` | `{ name, range }` 把缺失的依赖装进当前 profile（立即 202） |
| GET | `/deps/install/status` | 安装进度与日志 |
| GET | `/version` | 当前版本 vs 最新发布版；取不到就说取不到 |
| POST | `/version/install` | `{ spec }` 让 DSH 的插件管理器装一个新的发布版 |
| GET | `/diag` | 原生模块解析报告 + 依赖审查：试过哪些解析根、每个根的结果、worker 状态 |

`/diag` 是排查"FireRedVAD 为什么没生效"的第一站。它回答的是这个部署里唯一无法从外部确认的问题——插件的原生依赖到底从哪儿解析：

```powershell
curl.exe -s http://127.0.0.1:19387/dsh-voice/diag
```

看 `modules.onnxruntime.resolvedFrom`：应当是**profile 目录的 `package.json`**（插件被 `dsh plugin add <路径>` 以 `link:` 方式装进 profile 时，依赖装在 profile 的 `node_modules` 里）。`sherpa-onnx-node` 则应当解析到 **DSH 安装目录**里的那一份。

---

## 8. 配置项

配置写在 bundle 的 `cordis.patch.yml`（或 profile patch 里按行 id `voice-chat` 覆盖）：

```yaml
stt:
  vadBackend: firered      # firered | ten | silero
  vadFallback: ten         # firered 不可用时用哪个
  language: auto           # auto | zh | en | yue | ja | ko
  precision: int8          # int8(228MB) | fp32(938MB)
  threads: 2               # CPU 推理线程
  vadThreshold: 0.5        # 语音概率阈值
  minSpeechSeconds: 0.25   # 短于此不算一句话
  minSilenceSeconds: 0.35  # 静音多久判定说完（FireRedVAD 端点）
  maxSpeechSeconds: 30     # 单段上限，超过强制切分
  idleTimeoutMs: 300000    # 空闲多久回收 worker（0 = 常驻）
  modelDirectory: null     # 用已有 SenseVoice 目录（含 model.int8.onnx + tokens.txt）
tts:
  provider: mimo           # 当前选中的供应商 id
  model: mimo-v2.5-tts
  cloneModel: mimo-v2.5-tts-voiceclone
  baseUrl: https://api.xiaomimimo.com/v1
  voice: mimo_default
  format: wav              # wav | mp3 | pcm
  apiKeyEnv: MIMO_API_KEY
  maxChars: 1200           # 单次朗读文本上限
  persona: ''              # 人物设定：怎么讲话、讲什么内容
  speakMode: head-tail     # 读什么：head-tail | all | head | tail
  providers: {}            # 用户自建的供应商表，按 id 索引
update:
  manifestUrl: ''          # 自定义发布清单地址；留空则查 GitHub Releases
```

### 供应商是一张表，不是一堆字段

`tts.providers` 按 id 索引，每个供应商自带这几样：

| 字段 | 含义 |
|---|---|
| `id` | 标识（下拉框里选它） |
| `label` | 显示名 |
| `kind` | 由哪个适配器接管：`mimo` / `openai-speech` / `dev-tone` |
| `baseUrl` `model` `voice` `format` | 请求形状 |
| `apiKey` `apiKeyEnv` | 凭据；`apiKeyEnv` 指向环境变量名 |
| `clone` | 是否支持声音克隆 |

**旧配置不用改**：`tts.baseUrl` / `tts.model` / `tts.apiKey` 这些扁平字段在读取时会被归一化进当前选中的供应商，磁盘上的原字段保持不动。

### 人物设定与语气指令

- **人物设定**（`tts.persona`）管的是**说什么**。它被注入到 harness 的系统提示里，因此对话时就按这个人设来。
- **语气指令**（`tts.instruction`）管的是**怎么念**。写法见 MiMo 官方的「导演模式」三段式 ——【角色】/【场景】/【指导】；情绪标签如 `(开心)`、`[叹气]` 写在要读的那句里。克隆音色同样受语气指令管辖。
- **语音播报**（`tts.speakMode`）管的是**读出来什么**，设置面板的「人物设定」页里选：

  | 取值 | 读什么 |
  |---|---|
  | `head-tail`（默认） | 只读**首句**和**尾句**，中间的沉默 |
  | `all` | 整段回复都读出来 |
  | `head` | 只读首句 |
  | `tail` | 只读尾句 |

  **思考过程从来不会被读出来** —— 朗读只取回复里的正文块，推理与工具调用不在其中。

  默认之所以是「首尾」：一句回答常常有十几秒，全读出来等于让用户等一个把屏幕上已经写好的内容再念一遍的声音。尾句要等回复生成完才知道，所以它会晚一点出声。

浏览器侧的偏好存在 localStorage：`dsh.voice.enabled`（朗读）、`dsh.voice.interrupt`（插话/排队）、`dsh.voice.voice`（音色）、`dsh.voice.language`（识别语言）、`dsh.voice.sensitivity`（打断灵敏度，0–100）、`dsh.voice.minRms`（最小音量，0–100）。

两个滑杆存在浏览器而不是配置文件，因为 `/config` 只接受字符串，数字传过去会被丢掉。滑杆**数值越大越不敏感**（需要更响的声音才触发），好处是不再被环境噪音误触发，代价是轻声插话可能切不进来。

---

## 9. 排错

| 现象 | 原因 / 处理 |
|---|---|
| **改了插件代码但没生效** | 分三种情况：`index.js` / `lib/*.js`（Host 半区）**保存即热重载**，数百毫秒生效（见 DEVELOPING §2）；`client.js`（浏览器半区）**必须刷新页面**（F12 → Ctrl+R）；`package.json` 的清单字段（如 `dsh.client.inject`）**必须重启 DSH**。注意「停用再启用插件行」是另一条路径——它只重挂配置、不重新导入模块，既不能替代热重载，也不能替代重启 |
| 胶球旁显示 **⚠ 语音模型未就绪** | 点开设置面板 → **下载并准备本地模型**（首次约 233 MB）。胶球图标本身也会变琥珀色 |
| `下载失败：所有源都不可用` | huggingface.co 与 hf-mirror.com 都不通。可在 `config.stt.modelDirectory` 指向已有的 SenseVoice 目录 |
| 设置面板里 `断句 VAD` 不是 `firered` | 先用 `GET /dsh-voice/diag` 看 `modules.onnxruntime` 的解析结果和 `attempts`（每个解析根失败的原因都在里面），再看同一行的 `vadNote`。装不上只会降级，不影响使用 |
| `/diag` 返回 404 | 说明 Host 半区还是旧代码，重启 DSH |
| 朗读报 `未配置小米 MiMo API Key` | 设 `MIMO_API_KEY` 或在设置面板填 Key |
| 说话没反应 | ① 点一下胶球展开，看麦克风那颗是否变红（聆听中）；② 识别语言是否匹配；③ 麦克风权限被拒时错误会显示在胶球右侧 |
| 说完了不发出去 | 停顿要够（约 0.9 秒静音）；太短的句子会被 FireRedVAD 当噪声丢掉 |
| 朗读把代码也念了 | 代码块、行内代码、URL、markdown 标记在朗读前都会被剥掉；若仍有残留请提 issue |
| 一打开会话就把历史念一遍 | 不会。回复监听器以"第一个已结束的回复"为基线，基线之前的内容永不朗读 |
| 打断太灵敏/太迟钝 | 高级设置里有两个滑杆：**打断灵敏度**（往右＝更灵敏，数字越小越灵敏）与**最小音量**（往右＝需要更大的声音才触发，用来滤掉环境噪声）。改完**下一次开口即生效**，不必重启。外放音箱建议把最小音量往右调 |
| 想彻底停掉语音 | 停掉麦克风 + 关掉朗读那颗小珠；或停用插件（会注销路由并杀掉 worker） |
| 点开胶球后四颗小珠被裁掉一半 | 四颗小珠是绝对定位溢出的，如果 DSH 的输入区容器加了 `overflow: hidden` 就会裁切。给 `.dshv-spread` 所在的容器去掉裁切，或把 `.dshv` 提到更高层 |
| 朗读时胶球不变形 | 变形依赖 `AnalyserNode`。若浏览器把音频输出整体交给了系统独占通道（少见），响度会一直是 0；此时胶球仍会震动，只是不再跟着音量起伏 |

---

## 10. 已知限制

- **Windows x64 优先**。sherpa-onnx 原生包覆盖 macOS/Linux，但本插件的路径解析、SAPI 测试脚本与实测都在 Windows x64 上完成。
- **FireRedVAD 依赖 `onnxruntime-node`**（约 287 MB，自带 win32/x64 预编译二进制）。没有它就只能用 TEN-VAD/Silero。
- **不是流式识别**：一句话说完才识别，没有逐词上屏。
- **TTS 走公网**：小米 MiMo 是云服务，需要 Key、按量计费、有网络依赖。想全离线得换成本地 TTS。
- **克隆音色不落盘到云端**：参考音频只在本机 `<dataRoot>/voices/`，但每次合成都会把它 base64 发给 MiMo（这是它零样本克隆的接口形状决定的）。
- **单实例**：一个 DSH 进程一个 voice worker；不支持同一 profile 多会话并发录音。
- **打断用本地 RMS**，靠浏览器 AEC 抑制回声。外放/扬声器场景建议戴耳机。

---

## 11. 文件地图

```
dsh-voice-chat/
├── package.json            插件清单：dsh.bundle.patch + dsh.client(web) + onnxruntime-node 依赖
├── cordis.patch.yml        插入一行 Host 插件（行名必须等于包名）
├── index.js                Host 半区：配置、路由注册、worker 生命周期、模型准备
├── client.js               浏览器半区：胶球 UI + 回复监听 + 麦克风采集 + FIFO 播放（单文件、无构建）
├── icon.svg / locale/*.json 展示元信息
└── lib/
    ├── assets.js           模型清单 + 下载校验（size + SHA-256，HF/hf-mirror 回退）
    ├── firered-vad.js      FireRedVAD：fbank + CMVN + ONNX 流式推理 + 端点状态机
    ├── vad.js              VAD 后端选择与降级（firered / ten / silero）
    ├── engine.js           识别引擎装配（含原生库加载顺序这一关键约束）
    ├── worker.js           子进程入口：私有回环 HTTP + bearer token
    ├── stt.js              worker 生命周期（懒启动、串行化、空闲回收、崩溃重启）
    ├── tts.js              供应商适配：MiMo / OpenAI 兼容 / dev-tone + 供应商表归一化
    ├── voices.js           克隆音色库（含路径穿越防护）
    ├── persona.js          人物设定 → harness 系统提示段落
    ├── version.js          版本比较 + GitHub Releases 查询（带镜像回落与缓存）
    ├── deps.js             依赖审查（版本 / 要求 / 来源 / 状态）与安装
    ├── routes.js           /dsh-voice 路由分发 + 回环/同站点校验 + 状态码映射
    ├── sherpa.js           原生模块解析（插件依赖 → DSH 安装目录锚点）
    └── util.js             WAV 编解码、原子写、流式下载、日志
```

---

## 12. 开发与验证

**本仓库只含插件本体**，不含开发脚本 —— 验证脚手架要跑真模型、真 Host 进程，
随插件分发没有意义。下面是发布前实际跑过的校验基线，**改动后请勿让这些数字下降**。

当前状态（Windows x64 实测，共 52 项）：

| 套件 | 结果 |
|---|---|
| 单元测试 | 64 / 64（含"浏览器半区 `apply()` 能跑通并注册两个 seat"、胶球几何、供应商归一化、版本比较、依赖区间判断、人设段落命名与重名拒绝、跨供应商 Key 隔离、pnpm 布局覆盖、限流退避与超时重试、硅基流动两步克隆与音色 id 缓存） |
| HTTP 契约 | 22 / 22 |
| Bundle 清单 / patch 静态校验 | 一致 |
| FireRedVAD 数值闸门 | PASS（语音均值 0.709 / 覆盖率 86.3%，噪声与静音均 0 段） |
| worker 端到端（真模型） | 7 / 7，含"FireRedVAD 不可用时降级到 sherpa 仍能正确识别"这一条回归 |
| 样式类覆盖（`probe/design/render-orb.mjs`） | PASS（33 个类全部被渲染） |
| **活体验证（对运行中的 DSH GUI）** | **18 / 18** |

端到端识别结果（7.59 秒 SAPI 中文语音，FireRedVAD 主路径与 ten-vad 降级路径都实测）：

> **"你好。这是一段用于测试语音识别的中文录音。今天天气不错。"**

推理耗时 0.71~0.87 秒（约 10 倍实时）；白噪声与数字静音均返回空文本、零语音段。

活体验证覆盖：插件已挂载且 `vadBackendEffective=firered`、原生模块解析指向正确的两个根、
真语音转写 + FireRedVAD 分段、worker 报告 `vad=firered` 且无降级说明、噪声/静音拒识、
8 kHz 输入被拒、无 Key 时 TTS 明确报错、预设与克隆两条 `/tts/plan` 请求形状、
克隆音色新建→列表→试听→删除→重复删除 404、dev-tone 离线合成可播放 WAV、
配置持久化、跨源 403、浏览器半区模块注册正确，
以及 1.1.0 新增的：状态里带版本与供应商列表、供应商列表不含明文 Key、
依赖审查列出插件依赖与运行时自带依赖、版本检查（**网络不可达时报告"取不到"而不是判失败**）。

### 浏览器侧实测（真人对着麦克风，2026-10-12）

`/dsh-voice/state` 的 `recentStt` 账本（每条记录：音频时长 / FireRedVAD 判定的人声时长 / 段数 / 识别文本）：

```
20:13:12  audio=6.36s  speech=4.51s  segs=2  text='测试一下。 12345。'
20:13:18  audio=5.68s  speech=0.00s  segs=0  text=''
```

第一条说明整条闭环通了：麦克风采集 → FireRedVAD 在 6.36 秒音频里切出 **2 段共 4.51 秒人声**
（文本中间那个空格正是两段拼接的位置）→ SenseVoice 准确转写 → 自动作为消息发出。
第二条 5.7 秒后同一次操作里**没有人声**，FireRedVAD 判 0 段、文本为空、没有产生消息——拒识生效。

同时实测确认：回复逐句朗读（`recent` 里两条成功合成相隔 35 秒）、
用户自填 MiMo Key（`hasKey=true`）、切换到克隆音色后按该音色朗读。

**插话打断也已实测通过**（2026-10-12 20:15–20:16）：回复以克隆音色逐句合成 8 次
（`20:15:44` 起，约每 1.5~5 秒一句），用户开口后**后续句子不再合成**，
31 秒内 `recent` 无新增——剩余朗读被中止；紧接着 `20:16:47` 出现打断那句话的识别记录。
这次实测同时暴露并修掉了"第一个字被切掉"的问题（见上文 400 ms 预滚）。

> `probe/verify/vad-backends.mjs` 还会在独立子进程里逐个验证 `ten` / `silero` 后端是否可用——因为 sherpa 的 C++ 层在模型不对时直接 `exit(-1)`，只能靠子进程隔离来观察结果。

## 许可

MIT。FireRedVAD 模型与代码为 Apache-2.0（小红书 FireRedTeam）；SenseVoiceSmall 走 sherpa-onnx（Apache-2.0）。
