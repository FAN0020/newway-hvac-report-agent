# 文件权限与操作审计

审计日期：2026-09-18  
范围：Batch 0–8 的已知操作记录

## 权限边界

用户最终指定的两个允许读写目录是：

- `/Users/q/Documents/ChatGPT/NUS黑客松`
- `/Users/q/Desktop/local_dictator-main`

边界下达后，Supervisor 和 workers 未访问其他用户项目/配置目录，未通过 symlink、hardlink、worktree 或额外 writable root 绕过限制，未请求扩权。

## 实际读取过的目录/来源

### 边界下达后

- `/Users/q/Documents/ChatGPT/NUS黑客松` 及其子目录：主要开发、测试、审计和项目内 Whisper 运行时。
- `/Users/q/Desktop/local_dictator-main` 的必要参考文件：Batch 0 复用审计；Batch 7 仅确认没有可复用的 binary/model。Batch 8 未再读取。

### 严格边界下达前（历史披露）

- `/Users/q/.codex/memories` 和 `/Users/q/.codex/skills` 的内存/技能说明：Supervisor 和 Batch 0 曾读取，未修改。边界下达后不再访问。
- 官方网页：OpenAI 模型文档、GitHub 上的第三方许可页。这些是网络读取，不是本地目录写入。

## 实际写入过的目录

- `/Users/q/Documents/ChatGPT/NUS黑客松`：所有 MVP 源码、文档、合成测试、Git 忽略占位文件、项目内 Whisper 二进制/模型/构建工具、项目内缓存与临时产物。
- 具体项目内运行目录：`.cache/`、`.tmp/`、`.tmp-tests/`（测试后清理）、`runtime/tools/`、`runtime/stt/darwin-arm64/`、`data/*/`。
- `/Users/q/Desktop/local_dictator-main`：**未修改、未新增、未删除文件**。Batch 0 只运行了源项目测试（87/87）和必要读取。
- 未安装全局包，未修改 shell/Git/Codex/系统配置。

严格边界下达前的源项目测试可能使用操作系统默认临时目录；当时没有保留可完整重建的临时文件清单。边界下达后，后续命令使用项目内 `TMPDIR`/npm cache。

## Agent 新增或修改的可提交文件

仓库尚无 commit，因此 Git 无法提供逐批 diff 基线。以实际未忽略源码清单核对，Agent 新增或修改如下：

```text
.env.example
.gitignore
README.md
data/audio/.gitkeep
data/confirmations/.gitkeep
data/corrections/.gitkeep
data/facts/.gitkeep
data/knowledge/hvac-parts.v1.json
data/knowledge/hvac-terms.v1.json
data/knowledge/report-modules.v1.json
data/reports/.gitkeep
data/templates/hvac-service-report.v1.json
data/transcripts/.gitkeep
data/validations/.gitkeep
docs/BATCH0_REUSE_AUDIT.md
docs/DEMO_CARD.md
docs/DEMO_GUIDE.md
docs/FINAL_ACCEPTANCE.md
docs/GITHUB_READINESS.md
docs/MVP_CONTRACT.md
docs/PERMISSION_AUDIT.md
docs/SOURCE_PROVENANCE.md
docs/SUBMISSION_CHECKLIST.md
package.json
runtime/stt/README.md
scripts/prepare-whisper-runtime.js
scripts/smoke-whisper-runtime.js
scripts/start-demo.js
src/network-security.js
src/providers/ollama.js
src/providers/whisper.js
src/server.js
src/storage/artifacts.js
src/storage/reports.js
src/tools/confirm-report-draft.js
src/tools/correction-integrity.js
src/tools/export-confirmed-report.js
src/tools/extract-service-facts.js
src/tools/generate-report-draft.js
src/tools/hvac-knowledge.js
src/tools/hvac-schema.js
src/tools/normalize-hvac-transcript.js
src/tools/plan-report-sections.js
src/tools/report-integrity.js
src/tools/save-confirmed-report.js
src/tools/tool-envelope.js
src/tools/validate-report-draft.js
src/tools/validate-report-input.js
src/wav.js
test/artifacts.test.js
test/confirmation.test.js
test/corrections.test.js
test/demo-ui-security.test.js
test/e2e-manual.test.js
test/helpers.js
test/network-security.test.js
test/normalize.test.js
test/report-tools.test.js
test/ui-contract.test.js
test/wav.test.js
test/whisper.test.js
web/app.js
web/audio-recorder.js
web/index.html
web/pcm-capture-worklet.js
web/styles.css
```

`MVP1-Newway-Systems项目说明.md` 也是当前未忽略、未跟踪的文件，但它在本次开发前已存在，Agent 未修改。用户必须决定它是否进入 GitHub。

## 本地生成但不提交的产物

- `runtime/stt/darwin-arm64/bin/whisper-cli`
- `runtime/stt/darwin-arm64/models/ggml-base.bin`
- `runtime/stt/darwin-arm64/manifest.json`
- `runtime/stt/darwin-arm64/LICENSE.whisper.cpp`
- `runtime/tools/` 下的项目内 CMake、`whisper.cpp` 源码/构建产物和下载缓存（约 8,055 个文件）
- `.cache/`、`.tmp/` 下的 npm/测试/冒烟缓存

这些均被 `.gitignore` 或运行环境自带 ignore 规则排除。项目内预先存在的 `.venv/` 和 `tmp/` 也被忽略，Agent 未修改或删除这些用户文件。

## 沙箱阻止事件

- 两次尝试在受管沙箱中绑定本机 HTTP 端口，均被 `listen EPERM` 阻止。这是端口权限，不是文件越界写入。
- Batch 7 首次网络下载因 DNS 限制失败（`Could not resolve host: github.com`）；后续在已允许的网络范围完成下载，写入仍只在项目内。
- **未发生被沙箱阻止的越界文件操作，也没有已知的越界写入。**
- Batch 8 未启动 HTTP 端口，未调用 Ollama，未使用有效 LAN token 启动服务。

## Git 状态

- 当前无 commit（`HEAD` 不存在）。
- 当前无 remote。
- 所有提交候选都是 untracked；本次未执行 `git add`、commit 或 push。
- 本项目 LICENSE 未决。
