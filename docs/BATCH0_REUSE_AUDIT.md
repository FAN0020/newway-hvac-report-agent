# Batch 0：`local_dictator-main` 复用审计

审计日期：2026-09-18  
审计对象：同机的 `local_dictator-main` 参考副本  
目标项目：Newway Systems 空调现场服务报告 Agent MVP  
本批次边界：只审计、冻结复用边界和后续契约；没有复制源代码，也没有修改源项目。

## 1. 结论

可以实现，但不应该把 `local_dictator-main` 整体搬进新项目。

最值得复用的是它已经验证过的底层能力：浏览器麦克风采集、PCM/WAV 处理、Whisper 进程管理、Whisper 模型安装与校验、推理队列和 Ollama HTTP Provider。它们与“课堂笔记”业务关系较弱，适合在确认代码归属后抽取成新的基础设施模块。

不能直接复用的是完整课堂 UI、课堂 Session/材料管线、Version B 基线和当前 C6“课程材料纠错”。这些代码把课堂、长录音、英文词法规则和课程材料结构写进了实现。直接搬用会让空调 MVP 继承大量无关复杂度，并可能把参考资料误当成本次维修事实。

建议的实现方式是：新建小型 HVAC 应用，只抽取已验证的底层模块；业务 Workflow、HVAC 术语修复、事实提取、报告模板、验证和人工确认全部按新契约重写。

## 2. 审计证据与当前状态

- `package.json` 标记项目为 `private: true`，要求 Node.js 20 以上，直接依赖只有 Electron 和 electron-builder 两个开发依赖。
- 源目录没有项目级 `LICENSE`、`COPYING` 或 `NOTICE` 文件，也没有 `license` 字段。
- 该参考副本当前不是 Git 工作树，无法从该副本确认作者、提交来源和原始许可证。
- 当前副本没有已经准备好的 `whisper-cli`、动态库或 GGML 模型；`runtime/stt` 只有说明文件。启动前需要运行准备脚本并下载/构建运行时。
- README 明确声明当前系统没有 Agent、Planner 或 Tool 选择循环；模型不控制流程。这一点适合新 MVP 继续保持。
- 2026-09-18 在源目录运行了 10 个相关测试文件，共 87 个测试全部通过，覆盖音频拼接、麦克风超时、PCM flush、语音切段、Whisper Provider、模型安装、ASR 队列、Ollama Provider、保守检索和保守纠错。
- 上述通过只证明源副本的单元/集成行为，没有验证真实麦克风、真实 Whisper 模型、真实 Ollama、HVAC 术语准确率或新 MVP 的端到端行为。

## 3. 可复用清单

“可直接摘取”表示技术职责与 HVAC 无关、接口清楚；仍然必须先完成项目代码归属确认，并在新项目中重命名、补许可证说明和重新测试。

| 来源 | 关键函数/类 | 复用判断 | 新项目中的处理 |
|---|---|---|---|
| `web/microphone.js` | `requestMicrophone`、`MicrophoneTimeoutError` | 高 | 可抽取。保留 15 秒超时、拒绝处理和迟到 stream 自动停止；错误文案改成维修报告场景。 |
| `web/pcm-worklet.js` | `LecturePcmProcessor` | 高 | 可抽取算法，但必须把 processor 名称和类名改成 HVAC 中性名称。 |
| `web/pcm-worklet-client.js` | `flushPcmWorklet` | 高 | 可抽取。它保证停止录音前收到最后一批采样。 |
| `web/speech-segmenter.js` | `SpeechBoundarySegmenter` | 中高 | 可复用切段机制；1.2 秒最短、650 毫秒静音、14 秒最长是课堂参数，需要用 30–90 秒维修口述重新验证。 |
| `web/silence.js` | RMS/自动停止辅助逻辑 | 中 | 可参考；自动停止时长需要为现场噪声和停顿重新调参。 |
| `web/app.js` | `resamplePcm`、`wavBlob` 及录音编排片段 | 中 | 这两个通用函数目前嵌在 2,225 行课堂 UI 中，不能整文件搬用；应独立重写为小型音频模块。 |
| `src/audio.js` | `combinePcmWavFiles`、`combinePcmWav` | 高 | 多段录音才需要。保留 WAV 格式、采样率、截断文件和 4 GB 上限校验。单段 MVP 可以暂不接入。 |
| `src/providers/stt.js` | `WhisperProvider`、`runWhisperCommand`、`resolveWhisperBackendPolicy` | 高 | 可作为 `transcribe_audio` 的底层 Provider。改环境变量前缀、错误文案和临时目录前缀；保留超时、取消、输出上限和安全 spawn。 |
| `src/providers/whisper-models.js` | `WhisperModelManager`、`downloadModelFile`、`sha256File` | 高 | 可抽取模型注册、下载、SHA-256 校验、原子安装和失败恢复。保留固定哈希；不要把模型下载隐藏在一次普通报告生成中。 |
| `scripts/prepare-stt-runtime.js` | 固定 `whisper.cpp` b4938 的准备流程 | 中高 | 可改造成安装脚本。它会下载/构建第三方运行时，应保留 `LICENSE.whisper.cpp`，并把版本与产物写入 manifest。 |
| `src/asr-pipeline.js` | `InferenceScheduler` | 中高 | 只抽取有界队列、取消和关闭逻辑。MVP 不需要完整 provisional/revised/highQuality 三阶段策略。 |
| `src/providers/llm.js` | `OllamaProvider` | 高 | 可作为所有本地 LLM Tool 的 Provider。修改默认 system、环境变量名称和业务错误；保留超时、取消、JSON format、`think:false`、本地 loopback。 |
| 相关 `test/*.test.js` | Provider doubles、取消/超时/完整性测试模式 | 高 | 复用测试思想，不照搬课堂断言；重新写 HVAC 语料和工具契约测试。 |

## 4. 必须重写或暂不复用的部分

### 4.1 当前 C6 保守纠错不能原样复用

涉及：

- `src/conservative-correction.js`
- `src/conservative-retrieval.js`
- `src/version-b-baseline.js`
- `src/pipeline.js` 中 cleanup 路由

原因：

1. `runConservativeCleanup` 先调用冻结的 Version B 课堂文本“可读性修复”，再做材料支持的小替换。HVAC MVP 要保留原始 ASR，并且不允许先做一次不可完全追溯的全文润色。
2. 当前规则包含大量英文 stop words、英文 claim predicates、词形和编辑距离逻辑，对中文、Singlish、品牌、零件型号、单位和中英混说没有完成验证。
3. 检索输入是“课程材料”，输出是 `M1:S1` 形式的课堂证据，不是受控的 HVAC 术语/零件记录。
4. 当前检索是词法检索，不是向量 RAG；它适合做保守候选召回，但不能证明某个零件在本次维修中实际被使用。
5. 现有数值修复允许在强证据下替换数字。新 MVP 的数量、金额、读数、制冷剂类型/用量和正负表述必须由技师确认，不能静默修改。

可借鉴但应重写的设计思想：

- 原始文本不可覆盖；
- 检索材料视为不可信的只读参考；
- 模型只选择有限候选，不自由改写全文；
- 所有修改保留原文 span、参考记录 ID、接受/拒绝原因；
- 无证据、冲突、格式错误或 Provider 失败时保持原文；
- JSON Schema、变更预算和确定性校验优先于 LLM 自我声明。

### 4.2 完整课堂应用不应搬用

以下模块业务耦合较重，应在新项目重写最小版本：

- `web/app.js`、`web/index.html`、`web/styles.css`：课堂标签、翻译、Notes、Outline、材料上传和长 Session UI 过多。
- `src/app.js`、`src/server.js`：API 面向课程 Session、材料与多阶段 ASR，远大于今晚 MVP 需要。
- `src/store.js`、`src/storage.js`：可参考原子写和 Session 设计，但新项目只需要录音、转写、事实、报告草稿、校验结果和确认记录。
- `src/providers/material.js`：支持大量课堂文件格式；MVP 术语表和模板先使用版本化 JSON，不需要文档解析。
- 翻译、课堂段落、笔记、提纲、课程材料和 Windows 远程验证功能全部不进入 Batch 1。
- Electron 桌面包装先不进入 Batch 1。先让本地浏览器版本跑通，再决定是否包装桌面应用。

## 5. 运行前提与依赖

### 5.1 基础运行环境

- Node.js 20 或以上。
- Chromium 系浏览器，支持 `getUserMedia`、`AudioContext`、`AudioWorkletNode`。
- 麦克风权限；`localhost`/`127.0.0.1` 可作为安全上下文使用。
- 本地服务只绑定 `127.0.0.1`，除非团队明确接受把客户语音暴露到局域网的风险。

### 5.2 Whisper

- 当前实现使用 `whisper.cpp` CLI，不是 Python `openai-whisper` 命令。
- 源项目固定 `whisper.cpp` b4938；Base 模型约 148 MB，其他注册模型约 78 MB–3.1 GB。
- macOS 准备脚本需要 `curl`、`tar`、`cmake` 和可用的 C/C++ 构建工具；Linux/Windows 路径会下载预构建包。
- 首次准备需要网络；模型和二进制不在本次被审计的源副本内。
- 现有 macOS 策略强制 CPU、最多 4 线程，理由是该固定版本的 Metal 加载不稳定。这可能影响现场演示延迟。
- Whisper Provider 不返回可用于产品承诺的逐词置信度。不能把“已完成转写”解释成“保证识别正确”。

### 5.3 Ollama

- 本机安装并运行 Ollama，默认地址 `http://127.0.0.1:11434`。
- 必须提前拉取指定模型；源项目 README 使用 `qwen3.5:4b`，但新项目应把确切模型 tag 和 digest 写入 Trace。
- Ollama 软件许可证和所用模型许可证是两件不同的事；每个模型发布前必须单独检查。
- 本地模型超时、返回空内容或 JSON 不合法时，Workflow 必须停在可重试状态，不能跳过验证。

### 5.4 npm 与桌面包装

- 本地 Node HTTP 服务主要使用 Node 内置模块，没有声明生产时 npm 依赖。
- Electron 和 electron-builder 只在桌面开发/打包时需要。
- `package-lock.json` 的传递依赖包含 MIT、ISC、BSD、Apache-2.0、BlueOak-1.0.0、Python-2.0 等许可证。发布桌面包前需要生成第三方依赖清单和 Notices，不能只看顶层两个依赖。

## 6. 来源归属与许可证风险

### 6.1 阻断项：源项目自身没有明确许可证

`local_dictator-main` 没有项目级许可证，而且当前副本没有 Git 元数据。即使第三方 Whisper、Ollama 和 Electron 允许复用，也不能由此推断这批业务代码允许复制。

在复制任何源文件前，项目负责人必须完成至少一项：

1. 确认该代码完全由本团队拥有，并书面授权转入本 MVP；或
2. 找到原始仓库、作者和许可证，并满足其归属与分发条件；或
3. 不复制源码，只根据功能和公开接口独立重写。

在确认前，Batch 1 最安全的做法是独立重写小型实现，仅借鉴接口和测试目标。本审计不是法律意见。

### 6.2 已核到的第三方许可

- `whisper.cpp` 官方仓库采用 MIT License；复用或分发时必须保留版权和许可文本。源项目准备脚本已经设计为把 `LICENSE.whisper.cpp` 放进运行时。来源：<https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE>
- OpenAI Whisper 官方仓库说明代码和模型权重采用 MIT License。来源：<https://github.com/openai/whisper/blob/main/LICENSE>
- Ollama 软件采用 MIT License。来源：<https://github.com/ollama/ollama/blob/main/LICENSE>
- Electron 采用 MIT License。来源：<https://github.com/electron/electron/blob/main/LICENSE>
- Ollama 中下载的具体 LLM 模型使用各自许可证；不能用 Ollama 软件的 MIT License 代替模型许可审计。
- 源项目的图标、截图和其他视觉资产没有在当前副本中看到明确归属，不应直接用于新 MVP。

## 7. 新 MVP 的固定 Tool 与 Workflow

详细契约见 `docs/MVP_CONTRACT.md`。本审计冻结如下边界：

```text
录音 UI（不是 LLM Tool）
  → transcribe_audio
  → retrieve_hvac_knowledge
  → normalize_hvac_transcript
  → extract_service_facts
  → validate_report_input
     ├─ 关键转写不确定 → 技师确认
     ├─ 关键事实缺失 → 向技师追问
     └─ 可继续
  → plan_report_sections
  → retrieve_report_template
  → generate_report_draft
  → validate_report_draft
     ├─ FAIL → 修订或补问，禁止发布
     └─ PASS → 技师审阅
  → technician_confirm
  → save_confirmed_report / export_confirmed_report
```

Workflow Controller 决定顺序和门禁；LLM 不自由选择是否跳过某个 Tool。录音、Provider 和纯函数可以是内部模块，不必全部暴露成 Agent Tool；但每个重要阶段仍有稳定 JSON 输入输出，便于独立测试和 Trace。

## 8. 人工确认门禁

- 原始转写、标准化文本和每一项修复必须可并排查看。
- 数字、数量、单位、型号、制冷剂、测量读数、否定词、解决状态、金额一旦有不确定或变化，必须由技师确认。
- 报告中每个事实性 claim 必须关联语音 span、技师手动输入或可信工单字段。
- RAG 找到的常见做法只能生成提醒或追问，不能成为“本次已经做过”的事实。
- `validate_report_draft` 的 PASS 只允许进入技师审阅，不允许自动保存、导出或发送。
- Working session 可以自动保存；“正式报告”只能在技师确认当前版本后保存/导出。
- 确认记录必须绑定报告版本/hash、技师标识和时间。报告改变后旧确认立即失效。

## 9. 测试与验收边界

### 当前复用证据

- 相关源项目测试：87/87 通过。
- 未运行真实 Whisper/Ollama，也没有使用客户数据。

### 新 MVP 的最低验收

1. 麦克风录音可开始、停止，最后一批采样不丢失；拒绝和超时有清楚提示。
2. 一段合成 HVAC 音频可以生成不可变原始转写；失败时保留音频并允许重试。
3. 术语修复只输出有来源的候选及差异；关键数字/否定/状态不得静默变化。
4. 事实对象都带来源；没有来源的内容不能进入报告 claim。
5. 只说“换了一个 35 微法电容”时，系统只记录有证据的零件/动作并提示其他关键字段缺失，不生成虚构的完整维修过程或测试结果。
6. Validator 能拦住“运行 20 分钟正常”“制冷恢复”等输入中不存在的内容。
7. 未确认时，官方保存和导出接口返回拒绝；修改报告后旧确认失效。
8. 所有 Tool 有超时、错误码、重试分类、幂等键和 Trace；写操作出现未知结果时先查询状态，不盲目重试。
9. 不使用真实姓名、电话、完整地址、序列号、价格或未经授权录音做测试。
10. 在没有真实测试集前，只能声明“技术流程跑通”，不能声明真实准确率或生产可用。

## 10. 主要风险与 Batch 1 建议范围

### 风险优先级

1. **代码归属未确认**：阻止直接复制源文件。
2. **真实运行时未准备**：当前副本没有 Whisper 二进制和模型；今晚端到端需要下载/构建和真实环境验证。
3. **HVAC 数据缺失**：没有术语表、报告样本和真实语音，不能证明纠错或报告质量。
4. **当前纠错不适配中文 HVAC**：只能复用原则，不能复用结论。
5. **本地模型许可证/性能未冻结**：需要固定模型 tag/digest，并检查模型许可证和机器资源。

### Batch 1 最小范围

只做一条可见的竖切：

1. 新建最小 Node 20 本地 Web 应用；不引入 Electron。
2. 在确认代码归属前独立实现或最小改写麦克风录音与 WAV 输出。
3. 接通单次 `transcribe_audio`；先不做三阶段 ASR、模型下载 UI、长录音 Session 和翻译。
4. 保存原始音频引用和不可变原始转写，页面可看到两者。
5. 提供 Provider 健康检查；Whisper 或 Ollama 不可用时给出可操作错误。
6. 为后续 Tool 预留 JSON 接口，但 Batch 1 不实现报告生成和 RAG。

Batch 1 的完成标准是“录一段 30–90 秒语音并得到可查看、可重试、不会被覆盖的原始转写”，而不是“完整 Agent 已完成”。
