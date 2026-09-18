# MVP 最终验收记录

验收日期：2026-09-18  
范围：空调现场服务报告 Agent 黑客松 MVP

## 结论

已跑通“语音/手动原文 → 受控 HVAC 术语候选 → 技师逐项核对 → 有来源的服务事实 → 报告模块 → 草稿 → 独立 Validator → 技师确认 → 保存/导出”的代码链路。客户端不能自行注入术语候选或服务事实；确认与当前报告哈希、facts/correction receipts 和 Validator 运行绑定。

这证明代码工作流可用于黑客松演示，不证明真实中文 HVAC 语音准确率或生产可用性。

## 最终门槛

| 门槛 | 结果 | 证据与限制 |
|---|---|---|
| 代码语法 + 确定性自动测试 | **PASS** | `npm run check`：44/44 通过；不启动端口、不调用真实 Ollama |
| 手动文本端到端 | **PASS** | 直接函数链生成、校验、确认、保存/导出，测试产物已清理 |
| 伪造 facts/无来源文字/报告篡改 | **PASS** | 服务端 receipts + 哈希绑定；Validator 和 stale confirmation 回归测试通过 |
| 真实 Whisper CLI/Provider smoke | **PASS** | 官方英文 `jfk.wav` 返回预期转写；Provider 重算 binary/model SHA-256 并与 manifest 一致 |
| Whisper binary SHA-256 | **PASS** | `e3cb45bd1896791d8e7c451929c9aa5ab56547e360d3aaec73f6cb158713dcdc` |
| multilingual Base model SHA-256 | **PASS** | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| LAN 安全逻辑 | **PASS** | 无/弱 token 在监听前拒绝；44 个测试包含 bearer、Origin/Host、CORS、session token 和安全头回归 |
| 真实浏览器麦克风 | **NEEDS LIVE REHEARSAL** | 受管沙箱不能启动网络服务；未在现场浏览器授权并完成录音 |
| 两台真实设备同 Wi-Fi | **NEEDS LIVE REHEARSAL** | 安全逻辑已测，真实 LAN 可达性、token 输入和异机页面未彩排 |
| 中文 HVAC 语音/口音/噪声/数字/否定 | **NEEDS EVAL** | 尚无真实或授权测试集；关键数值和否定仍必须由技师确认 |
| 真实 Ollama 生成 | **NOT RUN / NON-BLOCKING** | 本次不调用 Ollama；确定性回退链已测，演示可不依赖 Ollama |
| 生产就绪 | **NO** | 无 TLS、用户身份/权限模型、限流、保存期策略、合规审查和真实准确率评估 |

## GitHub 准备度

准确结论是：**source-ready after user chooses a license and creates the first commit/remote**。

- 当前没有 commit、没有 remote，本次没有 `git add`、commit 或 push；不能声称已上传 GitHub。
- 待提交源码无未忽略的大文件、已知密钥、冲突标记或非审计文档的本机绝对路径。
- 本项目 LICENSE 仍未决；用户还需决定预先存在的项目说明文件是否可分发。
- Whisper 运行时、模型和项目内构建工具均已排除在 Git 之外。在另一台 Mac 上克隆后，必须运行 `npm run stt:prepare` 和 `npm run stt:smoke`。

## 演示承诺边界

可以说：报告工作流、受控术语候选、事实来源、Validator、人工确认门禁、Whisper 英文官方样本和 LAN 安全逻辑已验收。

不能说：语音识别保证正确、真实中文 HVAC 准确率已验证、手机麦克风/双设备 Wi-Fi 已实测、AI 能做维修/安全/报价决定，或系统已可用于生产。

详细权限和文件记录见 `docs/PERMISSION_AUDIT.md`；明日彩排见 `docs/DEMO_CARD.md` 和 `docs/DEMO_GUIDE.md`。
