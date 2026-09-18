# GitHub 更新准备度

检查日期：2026-09-18

## 结论

当前状态是：**source-ready after user chooses a license and creates the first commit/remote**。

- 源码、确定性测试、真实 Whisper Provider smoke 和 LAN 安全逻辑已验收。
- 当前没有 commit、没有 remote，所有源码都是 untracked；本次未 add/commit/push，不能声称已上传 GitHub。
- 本项目 LICENSE 未决；`MVP1-Newway-Systems项目说明.md` 是用户预先存在、Agent 未修改的文件，需用户确认是否允许进入仓库。
- Whisper 二进制、模型和项目内构建工具不进 Git；新 Mac 需运行 `npm run stt:prepare` 和 `npm run stt:smoke`。
- 真实浏览器麦克风、两台设备 Wi-Fi 和中文 HVAC 语音集仍需现场彩排/评估。

## 已完成的提交前检查

- `npm run check`：44/44 通过。
- `npm run stt:smoke`：项目内 `whisper.cpp` + multilingual Base 模型通过，binary/model 哈希与 manifest 一致。
- `npm run demo` 在 LAN 模式无 token/弱 token 时监听前拒绝启动。
- 待提交源码没有未忽略的大文件、已知密钥、Git 冲突标记或非审计用的本机绝对路径。
- 音频、转写、correction/facts/validation/confirmation receipts、报告、`.env`、cache/tmp、Whisper 运行时、模型、构建工具和虚拟环境已被忽略。

## 提交前剩余步骤

1. 选择 LICENSE，确认项目说明/品牌材料的分发权。
2. 按 `docs/SUBMISSION_CHECKLIST.md` 使用明确文件清单分批 staging；不使用 `git add .`。
3. 复核 staged diff，再建立首个 commit/remote/push。
4. 明天演示前完成主机麦克风与双设备 Wi-Fi 彩排；未通过前不作真实验收声明。

完整候选文件和权限记录见 `docs/PERMISSION_AUDIT.md`；可执行检查清单见 `docs/SUBMISSION_CHECKLIST.md`。
