# Composer 剪贴板图片与 Skill 展示边界

状态：Accepted（局部取代 ADR 0028 关于“不做剪贴板粘贴图片”以及 Skill 调用名直接作为用户可见名称的边界）

Composer 的图片输入只有一套附件状态机。用户经系统文件选择器选择图片，或在可编辑 Composer 中粘贴剪贴板图片，都会生成同一种内存附件 chip，并继续服从单条消息最多 8 张、单张原始字节不超过 5 MB、只随下一条 prompt / steer 发送、不持久化、不进入后续消息队列、失败随正文恢复的既有合同。剪贴板不是第二种附件或第二条发送协议。

macOS 剪贴板同时暴露多种表示时，D Code 只消费一次图片语义：全部为图片的 file URL 优先，保留原文件名、MIME 与数据；否则优先读取 PNG，TIFF 等可解码位图统一转为 PNG。file URL 与位图表示不得合并，否则同一图片会重复进入附件。混合图片与非图片 file URL 不拦截，避免静默丢失文件；纯文本继续由 NSTextView 原生粘贴。拖放附件仍不在当前范围。

Skill 的用户可见名称与内部调用语法分离。`session.getCommands` 和 `resources.list` 两条来源都把 `skill:<name>` 识别为 Skill；`+ › 技能` 与 `/` 面板只显示 `<name>` 和说明，类型写作“技能”，不显示 `/skill:`。选中后仍以既有 `invocationText` 预填 `/skill:<name> `，保证 Pi 实际可执行；D Code 不通过改名伪造新的命令协议。普通命令与 Prompt 模板继续显示 `/name`。

图片粘贴成功以附件 chip 作为直接反馈；解码、数量或体积失败走既有用户可读 notice。当前发送门禁仍要求正文非空，因此“仅图片无文字发送”不是本决定的一部分。
