# Codex App Server 生图隔离探针（2026-09-28）

## 验证问题

现有 ChatGPT/Codex 订阅认证能否通过本机 Codex App Server 生成一张真实图片，并返回可保存的图像结果？

## 假设与信号

- 支持信号：`account/read` 是 `chatgpt`、能力位 `imageGeneration=true`；一次 `turn/start` 收到 `imageGeneration completed`，`savedPath` 可读，图像文件有效。
- 否定信号：认证为 API Key、能力不可用、实际图像事件失败或没有可读产物。

## 运行方式与范围

- 本机 `codex-cli 0.157.1`，仓库外 `/tmp/dcode-appserver-image-34Epvn`。
- `python3 probe.py preflight`；`python3 probe.py generate`。
- 子进程移除 `OPENAI_API_KEY` 环境变量；`codex login status` 报告 ChatGPT 登录。
- 会话 `ephemeral=true`，工作目录为隔离临时目录，1 次实际 `turn/start` 生图请求。
- 没有读取 API Key、OAuth token、邮箱或认证文件；没有调用 Images API。

## 观察

- 预检：`account/read` 返回 ChatGPT managed，plan 为 Pro；`modelProvider/capabilities/read.imageGeneration=true`。
- 两次正式探针在 `account/read` 阶段遭遇 `workspace routing discovery timed out`，均未创建 turn。切换为 CLI 登录状态加已完成的 App Server 能力预检后继续。
- `thread/start` 返回 `ephemeral=true`、`modelProvider=openai`、`model=gpt-6-sol`。
- `turn/start` 接受；事件先出现 `imageGeneration status=in_progress`，后为 `completed`、`failure=null`，有非空 `result` 与可读 `savedPath`；`turn/completed.status=completed`、`error=null`。
- 期间一次 `tls handshake eof`，App Server 自动重连，本次生成完成，没有额外生成请求。
- `apple-test.png` 是 PNG RGB 1254×1254、715638 字节；SHA-256 `a35df55832d202acb5f5ec9aa457f1a3986da153236919528bed32f8a3529a38`；视觉检查为白底红苹果绿叶。

## Verdict

**supported**：本机订阅认证经 App Server 可以完成单图生成并取得文件。未直接核对账号后台账单或精确额度扣减；官方文档给出 ChatGPT 登录下生图计入 Codex 用量，API Key 模式另行计费。本次也没有验证 D Code 接入、产物登记、重启恢复或打包分发。

## 清理状态

临时探针、协议定义和测试图暂留仓库外，以供本轮需求记录引用；不进入 D Code 生产代码。完成证据转写后可清理整个临时目录。

## 官方来源

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/pricing
