# Evaluation Batch 4 最终交接（2026-09-26）

## 交付状态与边界

本次把前三批评测接成可复现的**独立组件验收**：15 个明确标为 `SYNTHETIC` 的五 scope 种子案例、离线 TTS 生成器、ASR/correction/facts/missing 四类组件 runner、RAG/report runner、仅本地 Ollama 的 DeepEval 适配器及总汇总。组件各用固定输入，失败不会串入下一组件。没有真人录音、人工冻结 Gold、生产质量验证或端到端验收。`npm run check` 保持既有静态检查及自动化回归覆盖，其中包括 `test/e2e-manual.test.js` 的手工文本工作流回归；本轮没有新增或执行完整五阶段 E2E evaluation。

评测标签是 `PROVISIONAL_SYNTHETIC_SEED`，不能把 seed 指标当真实准确率。当前代码适合推到**现有私有 GitHub 仓库供组员复核**；不建议对外公布评测达标、公开仓库或部署生产。公开分发还需另行确认 LICENSE 和材料权利；既有 `docs/Companies_CNA/` 下有二进制文档，无法靠文本密钥扫描确认其内容或分发授权，应由资料持有人复核。最终 commit 在本地，未 push。

## 从干净输入复跑

需要 Node 20+；TTS 实际生成只支持 macOS `say`、`ffmpeg`、`ffprobe`。DeepEval 需项目 `.venv` 内已安装 `evaluation/requirements-deepeval.txt` 的固定版本，以及 `127.0.0.1:11434` 的 Ollama `qwen3.5:9b`；无服务时结果应为 `NOT_RUN`，不改用云端 judge。

```sh
npm run eval:audio:validate
npm run eval:audio:dry-run
npm run eval:audio:generate -- --case HVAC-NORMAL-001 --output .tmp/batch4-audio
npm run eval:components -- --audio .tmp/batch4-audio --output .tmp/batch4-evaluation
npm run eval:batch3 -- --output .tmp/batch4-evaluation
npm run eval:deepeval:adapter -- --output .tmp/batch4-evaluation
npm run eval:deepeval:smoke -- --output .tmp/batch4-evaluation
npm run eval:summary -- --output .tmp/batch4-evaluation
npm run check
```

若要 ASR 覆盖全部 15 个案例，先用 `npm run eval:audio:generate -- --output .tmp/batch4-audio` 生成全量 WAV，再重跑组件。只生成一条 WAV 时，另外 14 条 ASR 正确显示 `NOT_RUN: WAV_MISSING`。生成物和动态结果均在 Git 忽略的 `.tmp/`，不要提交。`eval:deepeval:adapter` 只验转换，随后 smoke 会覆盖同一路径的 DeepEval 文件；只需最小 smoke，不要运行无参数的全量 DeepEval。`npm run check` 保持原有测试覆盖；其中的单个手工文本回归不能证明完整五阶段 E2E 流程。

## 如何阅读本次结果

查看 `.tmp/batch4-evaluation/summary.md`，再追溯 `component-results.md`、`batch3-results.md`、`deepeval-results.md` 与相应 JSON。`RUN` 表示该组件实际执行；`NOT_RUN` 是缺音频、缺固定 fixture、仅 adapter/smoke 选择或本地模型不可用；`NOT_SUPPORTED` 是产品不支持相应模块；`ERROR` 是执行失败。不要将这些状态合并成一个成功率。`hard_gate_failures` 要单独逐条处理，不能被平均分掩盖；它们是评测断言，不等同于产品 hard-gate 的最终输出。

本次抽样：Batch 2 为 24 RUN / 30 NOT_RUN / 6 NOT_SUPPORTED / 0 ERROR，出现 10 条事实关键字段缺失断言；Batch 3 为 20 RUN / 10 NOT_RUN / 0 NOT_SUPPORTED / 0 ERROR、0 条 hard-gate failure；DeepEval 本地 smoke 为 1 RUN / 57 NOT_RUN。SBS Rail 的合成 seed RAG Hit@3 为 0.667、Recall@3 为 0.278；这提示需要人工复核检索标签/排序，不能宣称真实使用表现。报告五条固定正常案例的 `fact_value_coverage=1` 是确定性 builder 合约检查；必填章节的 populated 比率仅 0.5–0.714，缺失项保留占位。事实 F1 只比较字段出现与否，不比较值；report 语义 judge 只是本地模型判断。ASR WER/CER 只对有 WAV、Whisper 可用且 checksum 匹配的案例计算。

本次 `npm run check` 的 266 个测试全部通过，其中既有 `test/e2e-manual.test.js` 作为自动化回归通过；它不计作完整五阶段 E2E evaluation。没有真人录音或真实用户端到端测试。

`component-results.json`、`batch3-results.json`、`deepeval-results.json` 与 `summary.json` 带 manifest/fixture 来源 SHA-256。汇总器拒绝跨版本 DeepEval 输出，旧输出须重跑 adapter 或 smoke。RAG 结果另记录 scope registry 及本地语料文件 hash；macOS TTS 的 WAV checksum 会随系统 voice 版本变化，不能承诺跨机器逐字节一致。

## 发给琼文并冻结 Gold

1. 从 `evaluation/synthetic-cases.v1.json` 选案例，运行完整音频生成或明确标注只生成的 case；打包 `.tmp/.../metadata.json`、对应 WAV、manifest、`evaluation/ground-truth.blank.v1.json`、`evaluation/ANNOTATION_GUIDE.md`，通过团队认可的私有渠道交给琼文。不要把 WAV 或含个人信息的反馈提交 Git。
2. 琼文独立听音频，先记实际听到的逐字稿，再分别标注规范文本、事实/否定/行动、缺失字段、相关知识 ID 和报告点。核对设备 ID、数值和单位；不能直接复制 seed 的标准文本当 Gold。标注单独存储，记录 reviewer、时间、WAV/manifest hash；有歧义时退回或拒绝案例。
3. 第二遍复核后，由独立审核者签字并记录 annotation checksum，才将 `human_review_status` 设为 `reviewed`、`frozen_gold` 设为 `true`。把每个审核完成的 `audio-ground-truth.v1` JSON 收入单独的私有、版本化 Gold 目录（例如团队管理的 `gold/v1/<case_id>.json`），逐条比对 manifest/WAV hash；这一步是**标注文件入库**，不是当前 runner 的导入。当前 runner 只消费 seed，**尚无 frozen Gold 导入/评分入口**。待组员设计独立导入及 Gold 评分契约后再对外报告人工 Gold 指标，不能手工把 seed 的状态字段改成 frozen。

更细标注规则见 `evaluation/ANNOTATION_GUIDE.md`。发布前须完成琼文复核、五 scope 的独立 Gold 覆盖和必要的真实场景验证；此次没有完成这些步骤。
