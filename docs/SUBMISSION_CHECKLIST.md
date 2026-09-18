# GitHub 提交前清单

## 当前状态（2026-09-18）

- [x] `npm run check`：44/44 通过。
- [x] `npm run stt:smoke`：真实 `whisper.cpp` Provider + 官方英文 WAV 通过，binary/model SHA-256 与 manifest 一致。
- [x] LAN 无 token 和弱 token 在监听前 fail-closed。
- [x] 待提交源码无未忽略的大文件、已知密钥、冲突标记或本机绝对路径（权限审计文档例外）。
- [ ] 在仓库公开前选择并添加本项目的 LICENSE，同时确认项目说明/品牌材料的公开分发权。
- [x] 用户已要求推送当前项目；`MVP1-Newway-Systems项目说明.md` 已进入私有仓库。
- [x] 已创建首个 commit 和 Git remote，并推送至私有仓库 `haoqi016/newway-hvac-report-agent`。
- [ ] 明天演示前完成主机浏览器麦克风和两台设备同 Wi-Fi 彩排。
- [ ] 之后建立中文 HVAC 真实或授权测试集，再评估语音和术语修复准确率。

## 后续提交时

1. 使用明确文件列表分批 `git add`；不使用 `git add .`。
2. 运行 `git status --short --ignored`，确认运行时、模型、客户数据、token 和缓存没有进入 staged files。
3. 再跑一次：

   ```sh
   npm run stt:smoke
   TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm run check
   ```

4. 检查 staged diff 和文档承诺，再 commit/push。

## 绝对不提交

- `runtime/stt/<platform>-<arch>/` 下的 Whisper 二进制、模型、manifest 和写入的上游许可副本；
- `runtime/tools/` 下的 CMake、源码、下载和构建缓存；
- `data/audio/`、`transcripts/`、`corrections/`、`facts/`、`validations/`、`confirmations/`、`reports/` 中的运行记录（只保留 `.gitkeep`）；
- `.env`、任何真实 token/API key、客户身份或设备识别信息、未脱敏音频/报告；
- `.cache/`、`.tmp/`、`.tmp-tests/`、`tmp/`、`node_modules/`、虚拟环境和编译产物。

## 准确的发布结论

当前是 **source uploaded to a private GitHub repository; not production-ready**。Whisper 运行时不随 Git 分发，在另一台 Mac 上克隆后必须运行 `npm run stt:prepare` 和 `npm run stt:smoke`。LICENSE 未决，在公开仓库前仍需处理。
