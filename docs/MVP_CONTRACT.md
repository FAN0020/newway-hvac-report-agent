# Newway Systems 空调现场服务报告 Agent：MVP 契约 v0.2

状态：**FROZEN FOR MVP IMPLEMENTATION**  
冻结日期：2026-09-18  
适用范围：第一个可演示、可本地运行的空调维修报告 MVP

## 1. 产品承诺

住宅或小型商业空调技师完成现场服务后，可以录入 30–90 秒语音或几个关键词。系统把技师实际提供的信息整理成结构化服务报告草稿，指出不确定内容和缺失字段，并在技师明确检查和确认后才允许生成正式报告文件。

系统帮助记录和整理，不替代技师作出维修、安全、报价、保修或零件更换决定。

## 2. 本次范围

### 包含

- 住宅及小型商业分体式空调的一般保养、故障排查和普通维修。
- 浏览器麦克风录音。
- 本地 Whisper 语音转文字。
- 本地 Ollama 模型进行受控术语标准化、事实提取和报告组织。
- 版本化 HVAC 术语/零件目录和报告模板。
- 缺失字段追问、事实来源绑定、报告校验和技师人工确认。
- 确认后保存结构化 JSON，并导出可复制文本；PDF/Word 不是第一条端到端路径的前置条件。

### 不包含

- 中央冷水机组、冷却塔、CRAC、复杂 VRF/BMS 控制和正式 IAQ 检测报告。
- 自动诊断故障根因、自动判断设备安全、自动决定维修方案。
- 自动报价、成本推断、保修承诺、付款或客户签字流程。
- 未经确认自动保存、发送、上传 CRM/FSM 或通知客户。
- 从历史客户报告学习或把原始客户录音放进 RAG。
- 多 Agent 自由协商、Planner 自由选 Tool 或自动改变 Workflow。
- 对真实业务准确率、生产可用性或合规性的声明。

## 3. 输入、输出和“不足输入”规则

### 输入

- 必需：一段音频，或技师手动输入的文字。
- 推荐预填：服务类型、工单号、服务日期、设备位置、技师姓名。
- 可选：设备类型、品牌/型号、已批准零件目录中的零件选择。

### 目标输出

- 不可变原始转写。
- 标准化转写及逐项修复记录。
- 带来源的结构化事实。
- 缺失字段和追问。
- 带 claim 来源的报告草稿。
- 草稿校验结果。
- 技师确认记录和确认后的正式报告。

### 不足输入规则

“几个关键词”不等于系统可以补齐全部报告。如果技师只说：

> 换了一个 35 微法电容。

系统最多可以确认或待确认地记录“更换电容、规格 35 µF、数量 1”。客户问题、现场检查、测试结果、完成状态和后续建议必须保持“未提供/待确认”，并生成简短追问。

RAG 中存在“更换电容后通常测试启动电流”也不能写成“本次已测试启动电流”。参考知识不是本次服务事实。

## 4. 核心数据对象

### `TranscriptArtifact`

```json
{
  "audio_id": "audio_123",
  "raw_text": "换了一个三十五微法电容",
  "language": "zh",
  "segments": [
    { "start_ms": 0, "end_ms": 2100, "text": "换了一个三十五微法电容" }
  ],
  "provider": "whisper.cpp",
  "model": "base",
  "source_hash": "sha256:..."
}
```

`raw_text` 一旦产生不得被标准化 Tool 覆盖。重跑 ASR 会产生新版本，不覆盖旧版本。

### `CorrectionReceipt`

```json
{
  "schema_version": "hvac-correction-receipt.v1",
  "correction_receipt_id": "correction_...",
  "transcript_artifact_id": "transcript_...",
  "transcript_raw_text_hash": "sha256:...",
  "knowledge_version": "hvac-corrections@2026-09-18",
  "candidate_bundle_hash": "sha256:...",
  "decisions": [{
    "candidate_id": "candidate_...",
    "correction_id": "corr_candidate_...",
    "source_span": { "start": 4, "end": 10, "text": "三十五微法" },
    "candidate": "35 µF",
    "decision": "ACCEPT",
    "critical_value_confirmed": true,
    "status": "CONFIRMED_BY_TECHNICIAN"
  }],
  "final_text": "换了一个35 µF电容",
  "final_text_hash": "sha256:...",
  "technician_id": "TECH-007",
  "confirmed_at": "..."
}
```

候选只能由服务端版本化 HVAC 词表生成。技师即使不接受任何修复，也必须生成绑定原文的确认凭证，facts 提取不能绕过该凭证。

### `ServiceFact`

```json
{
  "fact_id": "fact_1",
  "field": "parts_used",
  "value": { "name": "电容", "specification": "35 µF", "quantity": 1 },
  "source_refs": ["confirmed_text:0-11", "correction_receipt:correction_..."],
  "support_status": "DIRECT_TRANSCRIPT"
}
```

允许的 `support_status`：

- `DIRECT_TRANSCRIPT`
- `MANUAL_ENTRY`
- `CONFIRMED_BY_TECHNICIAN`
- `UNCERTAIN`

`UNCERTAIN` 事实不能被写成确定事实。

### `ReportClaim`

```json
{
  "claim_id": "claim_1",
  "section": "parts_and_materials",
  "text": "更换 35 µF 电容 1 个。",
  "fact_ids": ["fact_1"]
}
```

每个事实性句子必须至少关联一个 `fact_id`。模板标题、固定免责声明和“未提供”占位不是事实性 claim，但要标记为 `template_text`。

## 5. 报告模块

模块定义存放在版本化 JSON 配置中。第一版不要为十几个固定模块引入向量数据库。

### 固定模块

1. 工单与服务信息
2. 设备信息及位置
3. 客户反映的问题
4. 现场检查结果
5. 已完成的保养或维修工作
6. 使用或更换的零部件/材料及数量
7. 完工后的测试结果
8. 当前完成状态
9. 未解决事项与后续建议
10. 技师复核与确认

固定模块始终存在；没有内容时显示“未提供/待确认”，不能隐藏以制造完整感。

### 条件模块

- 制冷剂记录
- 维修前后读数
- 照片/附件
- 成本与报价
- 保修情况
- 客户现场意见/确认

成本、报价和保修只接受授权系统字段或人工输入，不从语言常识、零件目录或历史价格推断。

## 6. HVAC 知识库与 RAG 边界

### MVP 知识库可以包含

- 批准的 HVAC 中英文术语、口语别名和单位表示。
- 品牌、设备类型、零件名称和批准的零件编号。
- 服务类型对应的报告字段和追问提示。
- 版本化报告模块与企业批准措辞。
- 允许展示给技师的检查提醒。

### 禁止进入 RAG

- 未匿名化客户姓名、电话、地址、序列号和录音。
- 未经授权的历史报告。
- AI 生成但未被人工批准的维修知识。
- 价格、报价承诺或安全结论。

### 检索输出的权限

检索结果只能：

- 提供术语/零件候选；
- 决定使用哪个模板版本；
- 生成缺失字段提醒或追问；
- 给 Validator 提供受控词表。

检索结果不能直接证明本次服务做了什么，也不能直接新增报告事实。

MVP 首选版本化 JSON + 词法/精确检索。向量检索只有在多个公司、多份制造商资料或大量模板使 JSON 检索无法满足评估时才引入，Tool 接口保持不变。

## 7. Tool 清单与调用契约

所有 Tool 必须返回有界 JSON；不得用自然语言代替状态码。每次调用记录 `trace_id`、输入版本/hash、模型/知识库/模板版本、开始结束时间和结果状态。

| Tool | 责任 | 默认超时/重试 | 副作用与幂等 |
|---|---|---|---|
| `transcribe_audio` | 音频转不可变原始文字和时间段 | 10 分钟；超时/进程失败可人工重试一次 | 读取音频、使用临时目录；以 `audio_hash + model + language` 幂等 |
| `retrieve_hvac_knowledge` | 按 `query_type` 和过滤条件返回术语、零件或模板记录 ID | 2 秒；安全自动重试一次 | 只读；查询幂等 |
| `normalize_hvac_transcript` | 只提出受知识库支持的修复候选，输出差异和不确定项 | 120 秒；格式错误可重试一次 | 无外部写；不修改 raw |
| `extract_service_facts` | 从 raw、已确认修复和工单字段提取结构化事实，绑定来源 | 120 秒；格式错误可重试一次 | 无外部写；相同输入版本幂等 |
| `validate_report_input` | 确定性检查关键不确定项、缺失字段和冲突，生成有限追问 | 2 秒；无需 LLM 重试 | 无外部写；强制调用 |
| `plan_report_sections` | 根据服务类型和已提取事实选择固定/条件模块 | 2 秒；无需 LLM 重试 | 读取版本化规则；强制调用 |
| `retrieve_report_template` | 获取明确版本的报告模板和字段 Schema | 2 秒；安全自动重试一次 | 只读；不得由相似度任意换模板 |
| `generate_report_draft` | 只使用已支持事实和模板生成带 claim 来源的草稿 | 120 秒；格式错误可重试一次 | 只生成草稿；不得保存/发送 |
| `validate_report_draft` | 独立检查 Schema、来源覆盖、新增、遗漏、矛盾和不确定性强化 | 120 秒；确定性失败不可用重试掩盖 | 只读强制门禁；硬规则结论优先 |
| `save_confirmed_report` | 保存技师确认的当前报告版本 | 10 秒；未知结果先按幂等键查询 | 写操作；需要有效确认 token |
| `export_confirmed_report` | 导出确认版本为可复制文本/JSON，后续可扩展 PDF | 30 秒；未知结果先查询产物 | 写文件；以报告版本/hash 幂等 |

### Tool 通用返回包络

```json
{
  "tool": "validate_report_draft",
  "trace_id": "trace_123",
  "status": "PASS",
  "data": {},
  "warnings": [],
  "retryable": false,
  "error_code": null
}
```

通用状态：`PASS`、`NEEDS_CONFIRMATION`、`NEEDS_MORE_INFO`、`FAIL`、`RETRYABLE_ERROR`、`OUTCOME_UNKNOWN`。

### 为什么 Validator 也是 Tool

Validator 需要稳定输入输出、独立测试、Trace 和强制门禁，因此应包装成 Tool。但它不是让 Agent 自由决定是否调用；Workflow Controller 每次生成草稿后强制调用。

同一 Ollama 模型可以在 MVP 中用不同请求执行生成和语义检查，但不能靠“模型说自己没编造”通过。正式 PASS 至少依赖确定性 Schema、来源绑定、必填字段、受限状态和确认规则；LLM 语义检查只是补充。

## 8. 固定 Workflow 与状态机

```text
AUDIO_RECEIVED / TEXT_RECEIVED
  ↓ transcribe_audio（文字输入跳过）
TRANSCRIBED
  ↓ retrieve_hvac_knowledge
  ↓ normalize_hvac_transcript
NORMALIZED
  ├─ 关键修复未确认 → NEEDS_TRANSCRIPT_CONFIRMATION
  ↓ extract_service_facts
FACTS_EXTRACTED
  ↓ validate_report_input
  ├─ 关键事实缺失 → NEEDS_MORE_INFO
  ├─ 事实冲突 → NEEDS_FACT_CONFIRMATION
  ↓ plan_report_sections
  ↓ retrieve_report_template
REPORT_PLANNED
  ↓ generate_report_draft
DRAFT_GENERATED
  ↓ validate_report_draft
  ├─ FAIL → NEEDS_REVISION 或 NEEDS_MORE_INFO
  ↓ PASS
TECHNICIAN_REVIEW
  ├─ 修改 → 重新 validate_report_draft
  ├─ 未确认 → 禁止正式保存/导出
  ↓ 明确确认当前 hash
CONFIRMED
  ↓ save_confirmed_report / export_confirmed_report
COMPLETED
```

Workflow Controller 由代码实现。LLM 不得改变状态机、不选择跳过 Validator，也不能直接调用保存/导出。

## 9. 关键修复规则

以下内容不得静默改变：

- 数字、数量、金额和时间；
- 电压、电流、温度、压力和制冷剂用量；
- 零件编号、设备型号、故障代码；
- 制冷剂类型；
- “有/没有”“已解决/未解决”“已更换/未更换”等正负或完成状态；
- 报价、保修和客户承诺。

修复 Tool 必须保留：原文 span、候选、知识记录 ID、风险、状态和原因。关键修复只有技师确认后才能作为确定事实进入报告。

普通格式变化，例如空格、大小写或批准术语显示，也必须出现在修复记录中；它们可以标为低风险，但不能覆盖 raw。

## 10. 输入校验与追问

### 最低事实集合

完整报告希望覆盖：

- 客户问题；
- 检查发现；
- 已完成工作；
- 零件/材料；
- 测试结果；
- 当前完成状态；
- 未解决事项/后续建议。

不是每个服务都会使用零件，也不是每个服务都有未解决事项。系统要允许明确回答“未使用零件”“无已知未解决事项”，但不能用空白推断“无”。

### 追问限制

- 一轮最多三个问题。
- 优先问测试结果、完成状态和安全相关不确定项。
- 问题必须能由技师观察或记录回答，不要求 AI 自己诊断。
- 用户可以选择“未提供/稍后填写”，系统保留缺失标记。

## 11. 草稿生成规则

- 只能使用 `ServiceFact` 中非 `UNCERTAIN` 的事实。
- 不得从模板、RAG、常识或语言流畅度新增维修动作、根因、读数、时间或结论。
- “可能”“初步判断”“未确认”不得改写成确定结论。
- 缺失字段显示“未提供/待确认”，不能被流畅句子隐藏。
- 每个事实性句子必须输出 `fact_ids`。
- 建议必须区分两类：技师明确说过的建议，以及系统生成的“请技师确认是否需要”的问题。后者不能写进正式建议栏。

## 12. 报告验证规则

`validate_report_draft` 至少返回：

```json
{
  "status": "FAIL",
  "unsupported_claims": [],
  "omitted_supported_facts": [],
  "contradictions": [],
  "uncertainty_strengthening": [],
  "missing_required_fields": [],
  "invalid_fact_references": [],
  "schema_errors": [],
  "next_action": "NEEDS_REVISION"
}
```

硬失败条件：

- 事实性 claim 没有有效 `fact_id`；
- claim 内容超出其事实来源；
- 遗漏已确认的重要事实；
- 改变否定、数量、单位、型号或完成状态；
- 把不确定判断写成确定事实；
- 使用未确认的关键修复；
- 模板/schema 版本不一致；
- 必填字段既没有内容也没有“未提供”状态。

## 13. 人工确认门禁

技师确认界面必须展示：

- 原始转写；
- 标准化转写和每项修复；
- 未确认/缺失字段；
- 完整报告草稿；
- Validator 结果；
- “这是草稿，AI 不替代维修、安全或报价判断”的提示。

确认动作必须绑定：

- `report_version`
- `report_hash`
- `validator_run_id`
- 技师标识
- 确认时间

报告内容、事实、模板版本或校验结果任何一项改变，旧确认失效。未确认报告可以作为 working session 自动保存，但不得标为正式报告、不得导出或发送。

## 14. 数据、隐私和本地边界

- 测试只用合成、虚构或经匿名化且获授权的数据。
- 默认不采集客户姓名、电话、完整地址、设备序列号和价格。
- 原始音频和报告保存在本地项目数据目录，不进入 Git。
- 服务默认只监听 `127.0.0.1`。
- 日志记录 ID、状态、hash 和错误，不记录完整客户语音或报告正文。
- 删除 Session 时应同时删除录音、转写、草稿和确认记录；该删除功能可以在端到端跑通后补，但演示数据必须有清理方法。

## 15. 测试集与验收标准

### 当前数据状态

真实测试集：`PENDING`。在得到匿名化、授权样本前，不允许报告真实准确率。

### 立即建立的合成契约测试

至少覆盖：

- 完整维修口述；
- 只说零件的信息不足案例；
- 数字、单位、型号、数量；
- “没有漏水”“未更换”“仍未解决”等否定表达；
- 中英文混说、品牌/零件口语别名；
- 相互矛盾的两次陈述；
- RAG 中存在常见步骤但技师未说做过；
- LLM 输出无效 JSON、超时和 Ollama 不可用；
- 未确认保存、修改后使用旧确认 token；
- 重试同一写操作和 `OUTCOME_UNKNOWN` 查询。

### MVP 硬验收

1. 原始转写保留率：100%，任何修复不覆盖 raw。
2. 合成关键字段测试中，未经确认的数字、否定、型号、状态静默变化次数：0。
3. 合成报告中不受支持 claim 通过门禁次数：0。
4. 所有报告 claim 的有效事实来源覆盖率：100%。
5. 必填字段缺失时，系统生成“未提供/待确认”或追问，不虚构填充：100%。
6. 未确认正式保存/导出成功次数：0；内容修改后旧确认继续有效次数：0。
7. Provider 超时、无效 JSON 和进程失败均返回可理解状态，保留可重试输入。
8. 一条真实本机演示路径通过：录音 → 转写 → 修复/确认 → 事实 → 草稿 → 校验 → 技师确认 → 保存/导出。
9. 测试和演示不包含未经授权的客户隐私。

这些标准证明 MVP Workflow 和安全边界跑通，不证明生产准确率、法律合规或 Newway 已接受使用。

## 16. 分批实现边界

### Batch 1：录音与原始转写

- 最小本地 Web UI；
- 麦克风录音和 WAV；
- Whisper Provider；
- 不可变 raw 与 Provider 健康检查；
- 合成音频 smoke test。

### Batch 2：HVAC 知识与受控修复

- 版本化术语/零件 JSON；
- `retrieve_hvac_knowledge`；
- `normalize_hvac_transcript`；
- 修复差异和关键确认界面。

### Batch 3：事实、模板与草稿

- `extract_service_facts`、`validate_report_input`；
- 固定/条件模块规则；
- 草稿生成和有限追问。

### Batch 4：独立验证与确认保存

- `validate_report_draft`；
- 技师确认 token/hash；
- 确认后保存/导出；
- 端到端和故障注入测试。

## 17. 待验证但不允许模型自行决定的事项

- Newway 真实报告模板和必填字段；
- 技师实际语言、口音和常用缩写；
- 真实零件目录、品牌/型号和批准措辞；
- 输出最终需要 PDF、Word、邮件还是现有 FSM/CRM 数据；
- 报告和录音的保存期限；
- 最终本地模型及许可证；
- 技师和客户的签名/审批流程。

这些事项可以在后续配置中替换，但不能通过模型猜测来补全。
