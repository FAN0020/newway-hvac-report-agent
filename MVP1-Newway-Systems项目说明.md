# 第一个 MVP：Newway Systems 现场服务报告 Agent

更新日期：2026-09-17

## 1. 项目主题（整理版）

### 英文版

Field technicians are required to prepare service reports after completing customer visits. These reports normally document the work performed, replacement parts used, customer observations, and follow-up recommendations. However, technicians often need to travel immediately to their next job and therefore complete the reports later from memory. This process consumes valuable time and frequently results in incomplete, delayed, or inconsistent documentation.

The proposed solution is an AI-assisted field service reporting agent. Immediately after completing a job, a technician can speak a few short keywords or a brief voice note. The agent converts the input into a structured draft service report covering the customer-reported issue, inspection findings, work performed, parts used, test results, customer observations, and recommended follow-up actions. The technician reviews and confirms the draft before it is saved or sent.

### 中文版

现场维修技师完成客户上门服务后，需要填写服务报告，记录客户反映的问题、现场检查结果、已完成的维修或保养工作、更换的零部件、测试结果以及后续建议。

但技师完成一单后通常要马上赶往下一个服务地点，往往只能在稍后凭记忆补写报告。这不仅占用技师的有效工作时间，也容易造成报告延迟、信息遗漏、表达不一致，甚至无法清楚追溯当时做了什么。

本项目拟开发一个 AI 现场服务报告 Agent。技师完成工作后，只需现场说出几个关键词或一段简短语音，Agent 就把信息整理成结构化的服务报告草稿。报告必须由技师检查和确认后才能保存或发送，AI 不替代技师作出维修、安全或报价决定。

> 原始文本末尾的 “Client Document Coll... Accounting firms require” 看起来属于另一个会计事务所文档收集题目，且内容不完整，因此本项目说明没有把它并入当前主题。

## 2. 目标公司：Newway Systems 是做什么的？

Newway Systems Pte Ltd 是一家新加坡空调与室内环境工程服务公司。公司官方资料称其业务始于 1987 年，服务住宅和商业客户，并把自己定位为 ACMV（Air-Conditioning and Mechanical Ventilation，空调与机械通风）及室内空气质量相关服务商。

它的业务不只是清洗家用空调，主要包括：

- 住宅空调：单联机、多联机、中央/区域冷却、住宅通风与排风、除湿与空气净化、风管设计和制作。
- 商业空调与机械通风：VRF/VRV 系统、冷冻水空调系统、冷却塔和冷水机组、机房专用空调（CRAC）、机械通风与排风系统。
- 现场维保：定期检查和清洁、滤网/盘管/冷凝器清洁、制冷剂检查、电气连接检查、故障诊断、紧急维修和部件更换。
- 工程与升级：空调安装、系统改造、智能控制和能源管理集成；官方资料还列出数据中心/服务器机房、HVAC 风管、空气净化和电气控制系统等集成项目。
- 室内空气质量（IAQ/IEQ）：检测 CO2、VOC 和颗粒物，进行环境评估，并提出通风、过滤、净化等改善方案。

因此，准确说法是：**Newway 的核心业务是空调、制冷和机械通风系统，以及与这些系统密切相关的室内空气质量和控制工程；它并不只是维修家用空调，但公开资料不足以证明它负责所有类型的楼宇设备维护。**

## 3. Newway 可能面对的现场维修服务场景

以下场景中的“业务范围”有 Newway 官方资料支持；“需要填写哪些报告字段”是为 MVP 做的合理工作流假设，后续应通过员工访谈或匿名样本报告验证。

### 场景 A：住宅分体式空调定期保养

- 技师到 HDB、公寓或住宅检查一台或多台室内机和室外机。
- 清洁滤网、盘管、风轮和排水管，检查制冷效果、风量、异味、噪音和漏水。
- 报告需要记录设备/房间、清洁内容、检查结果、异常情况、客户反馈和下次保养建议。

### 场景 B：住宅或办公室空调故障排查与维修

- 客户报告不制冷、制冷弱、漏水、异响、错误代码、风量不足或耗电上升。
- 技师现场诊断，可能进行排水管疏通、制冷剂泄漏检测或补充、更换滤网、修复保温材料，或建议更换故障部件。
- 报告需要区分“客户描述”“技师发现”“已完成工作”“所用/更换部件”“测试结果”和“仍需跟进的问题”。

### 场景 C：办公室或商业建筑的计划性维保

- 同一次服务可能涉及多个区域、多台设备以及中央系统、VRF/VRV、风管或机械通风设备。
- 技师检查滤网、盘管、冷凝器、制冷剂、电气连接和系统性能，并尽早发现可能导致停机的问题。
- 报告更强调资产编号、位置/区域、逐台检查结果、未解决缺陷、停机影响和后续维修计划。

### 场景 D：商业场所紧急故障维修

- 办公室、商店或其他商业场所出现系统停机，Newway 派技师快速诊断并恢复运行。
- 可能涉及故障部件更换和临时处置。
- 报告需要记录到场时间、故障现象、根因或初步判断、恢复措施、更换部件、恢复后的测试结果以及是否需要再次上门。

### 场景 E：中央空调、机房冷却或复杂 ACMV 系统

- 对中央空调、冷冻水系统、CRAC、机械通风、风管和控制系统进行检查、校准、维修或升级。
- 报告可能包含运行参数、报警/错误代码、温度或气流表现、系统校准和控制设置。
- 这类报告专业性和风险更高，不适合作为第一个 MVP 的唯一测试场景，但可以作为以后扩展方向。

### 场景 F：室内空气质量现场评估

- 在住宅、办公室、商业建筑、学校或医疗设施测量 CO2、VOC 和颗粒物，并评估通风、过滤和净化情况。
- 这更接近检测/咨询报告，而不是普通维修单；数据字段、标准引用和审核要求与空调维修报告不同。
- 第一版 MVP 不应把 IAQ 报告和维修服务报告混成同一种模板。

## 4. 第一个 MVP 应该聚焦什么？

### 建议范围

先做：**住宅及小型商业空调的保养、故障排查和一般维修报告。**

第一版不要同时覆盖中央冷水机组、CRAC、复杂楼宇控制系统和正式 IAQ 检测报告。它们的术语、测量数据、合规要求和审批链都不同，会使 MVP 难以验证。

### MVP 用户流程

1. 技师完成现场工作。
2. 技师选择服务类型，例如“定期保养”“漏水排查”或“不制冷维修”。
3. 技师录入一段 30–90 秒的语音或几个关键词。
4. Agent 提取信息并生成结构化草稿。
5. 对缺失的关键字段，Agent 明确提问；不能自行编造。
6. 技师检查、修改并确认。
7. 系统导出可复制或可下载的服务报告。

### 第一版报告字段

- 工单号、服务日期和地点
- 客户报告的问题
- 设备类型、品牌/型号（知道时填写）及位置
- 现场检查发现
- 已完成的清洁、保养或维修工作
- 使用或更换的零部件/材料及数量
- 完工后的测试结果
- 未解决问题和风险提示
- 后续建议及是否需要再次上门
- 客户意见或现场确认
- 技师姓名和最终确认状态

### 关键产品边界

- Agent 只生成草稿，不自动确认维修事实。
- 不知道的内容标为“未提供/待确认”，不得猜测零件、故障根因、测量数值或客户承诺。
- 报价、保修承诺、安全判断和是否更换部件仍由授权人员决定。
- MVP 测试只使用空白模板、虚构数据或经过匿名化和授权的样本，不收集客户姓名、电话、完整地址、设备序列号、价格或其他机密资料。

## 5. 目前已确认与尚未确认的内容

### 已由公开资料确认

- Newway 面向住宅和商业客户提供空调相关服务。
- 业务包含常规保养、深度清洁、故障排查、维修、安装和系统升级。
- 商业系统范围包括 VRF、冷冻水空调、冷却塔/冷水机组、CRAC、机械通风和排风。
- 公司还提供室内空气质量测试及改善方案。

### 仍需向 Newway 验证

- 技师当前是在纸张、Excel、WhatsApp、现有 FSM/CRM，还是其他系统中记录服务结果。
- 报告是在现场完成，还是在下一单途中/当天结束后补写。
- 最常遗漏的字段和最耗时的环节是什么。
- 每天每位技师平均完成多少张报告，每张需要多少分钟。
- 是否允许语音录入，现场常用语言和术语是什么。
- 现有报告模板、审批人、客户签字及合规要求。
- 第一版系统应输出 Word、PDF、邮件正文，还是录入现有系统所需的结构化数据。

## 6. 公开资料来源

- [Newway 官方公司介绍](https://newway.sg/about-newway-air-conditioning/)：公司历史、住宅/商业空调系统、机械通风、CRAC、集成项目及 IAQ 业务。
- [Newway 商业空调服务](https://newway.sg/commercial-aircon-servicing/)：定期保养、紧急维修、系统升级及常见商业现场工作。
- [Newway 空调清洁与维修服务](https://newway.sg/aircon-cleaning-services/)：一般保养、化学清洗、故障排查、排水管、制冷剂、滤网和保温维修等具体服务。
- [Newway 中央空调系统](https://newway.sg/central-air-conditioning-system/)：中央系统的维护、常见故障、远程监控和智能控制。
- [Newway 官方主页](https://newway.sg/)：室内空气质量检测对象、指标和改善方案。

