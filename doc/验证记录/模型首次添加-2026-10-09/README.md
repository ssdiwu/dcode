# 模型配置与当前入口更新 · 2026-10-09

**模型配置已集成到主目录 0.1.0 开发版，并从固定入口构建、重开当前客户端，实际核对到真实配置表单。** 此时 507 的开发数据尚未填写真实服务商配置，页面仍如实显示模型不可用；这与旧窗口完全没有填写/保存入口的故障分别判定。没有读取或调用真实模型凭据，没有发起外部付费服务请求。

## 原因与集成范围

原窗口来自主目录，模型配置仍只在 components-slice 实施树；正常入口会复用已有实例，不自动重建或重载。先通过原生应用正常退出等待保存，再集成、复验及从固定入口重开，未清空开发数据。

产品实现来源为既有 Claude Code + K3 实施树。独立 507-review 找到并推动修正了四字段标签、正文实际呈现、请求等待期限、accepted 后旧 ready 投影允许关闭运行端口，以及无消费者 CodingTools 装配。产品门控现从公开 ExecutionPort.read 核对真实相位，读失败不关端口/不提交；旧图与保存顺序回到正式 spec/架构正文。

最终模型增量 **21 文件（16 修改、5 新增）**。原冻结交付清单列了20文件，漏掉根契约测试的两处更新；首轮主树 verify 在契约阶段2/4失败，实际原文保留。补入同源的必需 modelSetup 快照字段及 configureModel 正反例后，契约4/4通过，再跑主树完整门槛。没有放宽产品校验或删除旧非法输入断言。

主目录集成由本次507故障续办串行完成，整合会话当时已核实idle；Claude+K3先停写，协调者修正最终验收fixture并在主树验证。保持既有仅两处工作树，没有再造用户版本或提交/推送/发布。最终验收fixture与修正后的模型spec已在备份中间稿后同步回停写的组件树，避免下次恢复错误门控草稿。Composer、全局样式、品牌资源、固定启动器和 application 公开入口保留；main/index 以hunk合并并保留 dcode-macos.png。

## 正常用户路径与证据

- 正常装配、空配置，从真实控件填写协议、显示名、模型 ID、Base URL 和 API 密钥；保存本身网络请求为0。
- 元数据和 native safeStorage 加密凭据同一记录原子提交，成功后清空界面密钥。真实Pi HTTP模块发送请求，本地服务器逐次核对精确认证与model，每次独立nonce；首发和真实关闭/重开后的第二条回复均断言页面实际可见全文。
- 编辑 model ID、同服务留用密钥、跨目标换密钥、清除密钥、401、连接拒绝、真实服务端错误回显与短密钥都经隔离界面路径验证。保存B写入失败后A的原配置和凭据仍收到新的成功回复。
- 运行测试的公开端口反例明确保持“输入accepted，应用投影仍ready，端口实际running”；保存不得close/commit。真正ready发布后才允许保存。独立仍打开端口验证paused且有pending队列可改但不resume，及read失败原A记录/凭据不变。
- 使用冻结旧app原源码的临时副本重放相同最终反例：实际exit1、两项失败，证明新断言能拒绝旧放行错误；未回滚产品工作树。修复后定向5/5实际exit0。

[旧门控失败日志](original-gate-red.log) / [原源码身份](original-gate-red.json) / [本次源清单](source-manifest.json)。

## 主目录完整检查

2026-10-09 **12:25–12:27 Asia/Shanghai**，直接运行 npm run verify，未用grep/tail管道的退出码推定成功。

| 门槛 | 结果 |
|---|---|
| 架构正反样例、当前源码 | 32/32，44源码文件通过 |
| 全范围类型、Lint、构建 | 通过 |
| 运行测试 | 40/40 |
| 接口契约 | 4/4 |
| 界面端到端 | 65/65，其中模型路径11条 |
| 产品与手写测试源码 | 检查前后字节相同 |

完整日志：[main-verify.log](main-verify.log)。实际npm退出码为0，日志SHA256为 `35b4fb5d389cc967f9cd9a77b481a8e886592ec394c83fbb7940cacc22358bb6`。汇总：[main-verification.json](main-verification.json)。

验证包装器的原始记录仍显示“源码变化”并返回1：它误把git已忽略的生成文件 test/e2e/streaming-sim/dist/current/product.css 纳入源码指纹。唯一变化正是 build-sim.mjs 第58行复制的当前构建样式；产品和手写测试逐项相同。保留[原包装器记录](raw-runner-status.json)，明确区分npm成功与包装器误分类，没有改基线/规则掩盖产品变化，也没有因此重复已通过测试。

## 当前真实窗口

从 `启动 D Code.command` 的等价 `npm run desktop` 入口构建重开，当前进程 PID33464、source为主目录，版本0.1.0-dev。原生Computer Use读回URL为主目录 out/renderer/index.html；真实界面有四个具名输入、安全密钥输入和保存按钮。

[当前表单](evidence/current-model-form.png) / [保存入口可达](evidence/current-model-form-save.png) / [原生界面读回](evidence/current-model-form-save-ax.txt)。实际点击Base URL后PageDown使下方密钥/保存可见，侧栏保持；两次后台工具滚轮没有产生可见位移，未把它报为滚轮验收。当前窗口留在模型页，没有填写507真实配置，保存按钮因必填项为空而禁用，未伪造账户连接成功。

## 未覆盖与恢复

外部服务商账户、Anthropic独立协议、OAuth、自动模型发现/能力额度路由、真实开发工具及用户工作目录均未由本轮验收；English页面的部分保存失败细节仍可能显示中文。用户视觉接受、系统Dock像素及发布另行判定。

本次更改前文件和逐项指纹在 `/Users/diwu/Workspace/Archives/dcode-model-setup-2026-10-09/main-integration/before/`。最终可重放增量为同目录 final-model-feature.patch，SHA256 `d284931872e84166864203ee6134d5982f0c272d7c30a52328361bd7bd6ab984`。原冻结20文件补丁及前期失败不改写；新增文件和当前用户数据不得通过全树覆盖/清空恢复。
