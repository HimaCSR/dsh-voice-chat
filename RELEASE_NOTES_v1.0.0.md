# DSH-Voice v1.0.0

给 **DeepSeek Harness** 加一套语音对话能力：说话就识别、回复就朗读，你一开口它立刻闭嘴听你说。

**完全本地的语音识别**（不需要显卡 / WSL / Python / 编译）+ **在线的语音合成**（含零样本声音克隆）。

---

## 安装

### 方式一：一行装（推荐）

```powershell
dsh plugin --profile desktop add github:HimaCSR/dsh-voice-chat
```

装完**刷新页面**（`F12` → `Ctrl+R`）。

> 需要本机有 **git**，且能连上 GitHub —— 这一条由 pnpm 调 git 拉取代码。

### 方式二：离线 zip

1. 下载本页附件 **`dsh-voice-chat-1.0.0.zip`**，解压到任意目录
2. ```powershell
   dsh plugin --profile desktop add "<解压目录>\dsh-voice-chat"
   ```
3. **补装可选依赖**（zip / `link:` 方式 pnpm 不会装被链接包的依赖）：
   ```powershell
   dsh plugin --profile desktop add onnxruntime-node@^1.30.0
   ```
4. 刷新页面

> 网络对 GitHub 不稳时（连接被重置）用这个方式更可靠。

---

## ⚠️ 装完必须做的一步：下载模型

**插件本体不含模型文件。** 刚装完只有界面，球是琥珀色 ⚠，识别和朗读都不会工作。

### 怎么下

打开插件的**设置面板** → 点「**下载并准备本地模型**」→ 等进度条走完。

下载是**幂等**的：已完整且有校验的文件会跳过，缺的或校验不过的才重新拉，中断的半个文件不会被当成完整的。所以卡住了直接再点一次即可。

### 下的到底是哪几个模型

默认配置下会取回 **6 个文件，共约 233 MB**：

| 文件 | 大小 | 用途 | 来源 | 落盘位置 |
|---|---|---|---|---|
| `sensevoice.int8.onnx` | **228 MB** | **语音识别主模型**（SenseVoice-Small int8） | HuggingFace `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` | `models\` |
| `tokens.txt` | 309 KB | 上面那个模型的 SentencePiece 词表 | 同上 | `models\` |
| `fireredvad_stream_vad_with_cache.onnx` | 2.2 MB | **断句 / 端点检测主模型**（FireRedVAD） | GitHub `FireRedTeam/FireRedVAD` | `vad\firered\` |
| `cmvn.ark` | 1.3 KB | FireRedVAD 的 Kaldi 均值方差归一化参数 | 同上 | `vad\firered\` |
| `ten-vad.onnx` | ~1 MB | FireRedVAD 起不来时的**兜底** VAD | GitHub `k2-fsa/sherpa-onnx` releases | `vad\` |
| `silero_vad.onnx` | 1.7 MB | 同上，第二个兜底 | HuggingFace `csukuangfj/vad` | `vad\` |

两个兜底 VAD 加起来才几 MB，但**必须一起下**：sherpa 的 C++ 层在 VAD 文件缺失时会直接
`exit(-1)` 杀掉识别进程，而不是降级 —— 一个"要先下载才能用的兜底"等于没有兜底。

### 落在哪里

全部在 **`%DSH_HOME%\voice-chat\`** 下（`%DSH_HOME%` 默认是 `C:\Users\<你>\.dsh`）：

```
%DSH_HOME%\voice-chat\
├── config.json                       ← API Key 等配置（只在本机，不进任何仓库）
├── models\
│   ├── sensevoice.int8.onnx          ← 228 MB
│   └── tokens.txt
├── vad\
│   ├── firered\
│   │   ├── fireredvad_stream_vad_with_cache.onnx
│   │   └── cmvn.ark
│   ├── ten-vad.onnx
│   └── silero_vad.onnx
└── voices\                           ← 你克隆出来的音色，一个目录一个
```

### 网络下不动怎么办

**内置两级镜像回退**，通常不用你操心：

- HuggingFace 的 URL 会自动追加 **`hf-mirror.com`** 镜像
- GitHub 的 raw / release URL 会自动追加 **`gh-proxy.com`** 代理

两个源都失败才会报错。**终极办法是手动放文件**：按上表的"落盘位置"把文件放好，
插件会自己校验大小与 SHA-256，校验通过就直接用，不会再下载。

### 已经有 DSH 自带的 SenseVoice 缓存？

可以复用。本插件用的 SenseVoice 版本与 **DSH 内置 SenseVoice provider 钉的是同一个 revision**，
所以在配置里把 `stt.modelDirectory` 指向那个已存在的目录即可，不用重复下 228 MB。

### 想换精度？

配置项 `stt.precision` 可选 `int8`（默认，228 MB）或 `fp32`（**894 MB**，精度更高、更慢）。
除非发现 int8 识别质量不够，否则没必要换。

---

## 可选：配一个语音合成的 Key

**语音识别完全本地、零 Key 就能用。** 只有**朗读**需要配一个 Key：

- **小米 MiMo**（默认）：`api.xiaomimimo.com`，在设置面板填入 API Key
- 或任意 **OpenAI 兼容**的 `/audio/speech` 端点

不配 Key = **能听不能说**，其它功能一切正常。

---

## 系统要求

| 项 | 要求 |
|---|---|
| DSH | 能装 bundle 插件的版本 |
| 操作系统 | Windows x64（插件在 Windows 上开发与验证；原生依赖走 DSH 自带的 sherpa-onnx） |
| 磁盘 | **约 250 MB**（模型 233 MB + `onnxruntime-node` 解包 287 MB，若安装） |
| 显卡 | **不需要** —— 纯 CPU 推理 |
| Python / WSL / 编译器 | **都不需要** |
| 网络 | 首次下模型需要；之后可完全离线识别 |

---

## 这个版本有什么

- **本地识别**：SenseVoice-Small int8 ONNX，CPU 推理，约 10 倍实时
- **端点检测**：自己实现的 FireRedVAD（Kaldi fbank + CMVN + FSMN 流式推理）；ONNX Runtime 缺失时自动降级到 TEN-VAD，并在设置面板说明原因
- **在线合成**：默认小米 MiMo，也支持任意 OpenAI 兼容端点
- **声音克隆**：上传 5~20 秒参考音频即零样本克隆，无需训练、无需参考文本
- **插话打断**：朗读中你一开口，立刻停播 + 中止在途合成 + 丢弃本轮剩余句子，你这句话成为新一轮
- **透明胶球 UI**：磨砂玻璃 + 单色线性图标；球体恒透明，状态只改图标颜色；朗读时轮廓由真实音频驱动；可拖拽、可吸边、吸边后沿边缘平行展开
- **隐私**：API Key 只留在 Host 侧，从不进页面；识别全程不出本机

## 已验证

| 套件 | 结果 |
|---|---|
| 单元测试 | 18 / 18 |
| HTTP 契约 | 12 / 12 |
| worker 端到端（真模型） | 7 / 7 |
| 活体验证（对运行中的 DSH GUI） | 14 / 14 |

端到端实测（7.59 秒中文语音）：
> **「你好。这是一段用于测试语音识别的中文录音。今天天气不错。」**

## 许可

MIT
