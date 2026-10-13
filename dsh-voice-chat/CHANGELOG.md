# 变更日志

版本号以 `package.json` 的 `version` 为准；每次发布打一个 `vX.Y.Z` 标签。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 版本约定

版本号以 `package.json` 的 `version` 为准；每次发布打一个 `vX.Y.Z` 标签。

| 改了什么 | 升哪一位 | 例 |
|---|---|---|
| 修 bug、改文档 | patch | `1.0.0 → 1.0.1` |
| 加功能（向后兼容） | minor | `1.0.1 → 1.1.0` |
| 破坏性改动（改配置项名、改 HTTP 路由） | major | `1.1.0 → 2.0.0` |

> 改 `client.js` 之后**必须刷新页面**（F12 → Ctrl+R）；只有 Host 半区（`index.js` / `lib/*.js`）是热重载的。
> 本仓库只含插件本体，验证脚本与发布流程在项目开发侧，不随插件分发。

---

## [1.0.0] — 首个版本化基线

把从零搭起来的插件第一次纳入版本控制。此刻的能力全貌：

### 语音识别（本地）
- SenseVoice-Small **int8 ONNX**（228 MB，CPU，sherpa-onnx）——不需要显卡、WSL、Python 或编译
- **FireRedVAD** 端点检测：自己实现的 Kaldi fbank + CMVN + FSMN 流式推理（`lib/firered-vad.js`）
- ONNX Runtime 不可用时自动降级到 TEN-VAD，并在设置面板与 `/state` 的 `vadNote` 说明原因
- 识别 worker 跑在子进程里；**必须比 sherpa 先加载 `onnxruntime-node`**（同名 DLL 冲突）

### 语音合成（在线）
- 默认小米 MiMo（`api.xiaomimimo.com`），复用 chat completions 形状而非 `/v1/audio/speech`
- 支持任意 OpenAI 兼容的 `/audio/speech`
- **声音克隆**：`mimo-v2.5-tts-voiceclone`，5~20 秒参考音频零样本克隆，无需训练、无参考文本
- `dev-tone` 离线占位音，可在没有 Key 时验证整条朗读链路

### 交互
- **插话打断**：朗读中你一开口立刻停播 + 中止在途合成 + 丢弃本轮剩余句子，你那句话成为新一轮
- 回复逐句朗读：长回答在流式输出时就开始说，不等整段结束
- **一颗透明胶球**（iOS 控制中心那套磨砂玻璃 + 单色线性 SVG 图标）：
  - 球体恒透明，**状态只改里面的图标颜色**（待机/朗读=常规，聆听=红，识别中/未就绪=琥珀）
  - 待机缓慢荡漾；聆听/识别中三圈同心水波 + 亚像素震动
  - **朗读时轮廓由真实音频驱动**（`AnalyserNode` 取响度 + 四组互质频率正弦叠加算 `border-radius`）
  - 点开碎成四颗小胶球（麦克风 / 朗读 / 插话 / 设置），音色名不再占用按钮
  - **可拖拽 + 吸边**：离边小于一个球直径才吸；吸住后球体压平耷拉；展开时沿边缘平行排布
  - 可移动区域是**对话面板**那块矩形，不是整个窗口
  - 点界面别处或按 Esc 收回
- 设置面板：引擎状态、模型下载进度条、音色库、克隆、API Key、识别语言、可复制诊断信息

### 工程
- 完全本地识别 + 在线合成；API Key 只留在 Host 侧，从不进页面
- 仅供回环 + 同站点的 `/dsh-voice/*` 路由，无第二个端口、无 CORS
- 七套验收脚本 + 一个样式一致性夹具（见 [`../probe/README.md`](../probe/README.md)）
- 校验基线：单测 18/18、HTTP 契约 12/12、worker 端到端 7/7、活体验证 14/14
