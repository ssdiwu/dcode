# 首次使用对抗测试 · 2026-10-09

507 在实际客户端指出三项问题：Dock 图标是满幅直角方图；点击 Composer 会多出直角白色内框；设置页无法添加模型，不能开始工作。随后明确要求使用 ZCode CLI／MiniMax CLI 进行对抗性测试。本轮继续使用主目录 `0.1.0-dev`，没有另立用户版本、工作树或发布。

## 当前结论

| 问题 | 证据与状态 |
|---|---|
| Composer 双框 | 旧构建已独立复现；主目录局部补修后，正常入口下鼠标／Tab、深浅主题、13／14px 共 8 组读回通过；按钮焦点保留 |
| 无模型添加路径 | ZCode 实际打开正常设置页并重开：没有输入、添加／保存按钮或配置桥；正常装配只能保持 unavailable。**首次配置到发送路径不通过**，后续模型实现已由既有 Claude Code＋K3 修正并集成，正常入口及隔离真实协议复验见 [模型配置与入口更新](../模型首次添加-2026-10-09/README.md) |
| Dock 直角 | 已保留母版并接入透明圆角平台图；新定向测试从实际 `app.dock.setIcon` 消费者截取输入验证，1/1 通过。当前窗口已刷新，真实 Dock 像素观感仍未取得核验截图 |

## 两个 CLI 实际做了什么

### ZCode CLI

- 实测本机 `zcode 0.16.9`，使用 `--cwd` 指定独立临时测试目录、`--json -p`，禁止产品源码写入；会话为 `sess_5825c70e-48e2-4c16-b4d1-ddd4486e9247`。
- 正常装配显式清空 `DCODE_VALIDATION_ASSEMBLY`、关闭 `DCODE_VALIDATION_SAMPLE`，只用隐藏、不可聚焦、隔离数据的 Electron 测试窗口。没有操作 507 已打开窗口或读取真实凭据。
- [焦点实测日志](zcode-focus-run.log) 与 [设置实测日志](zcode-settings-run.log) 均完成；实际点击／Tab、设置导航和重开由 ZCode 编写临时脚本并执行。脚本保留为只读附件：[焦点脚本](focus-repro.mjs.txt)、[设置脚本](settings-model-audit.mjs.txt)。
- 首次长调用在 900 秒监督时限到达时结束，但两段实测及截图已产出。随后用原会话 `--resume` 只整理报告，退出 0，见 [初次时限记录](zcode-exit.json)、[接续退出记录](zcode-summary-exit.json) 和 [正式报告](zcode-report.md)。不将初次超时改写成正常完成。
- 原始焦点观测与 12 张图在 [focus-observations.json](zcode-evidence/focus/focus-observations.json) 所在目录；模型、发送不可用、持久化与重开观测在 [settings-observations.json](zcode-evidence/settings/settings-observations.json)。脚本进程退出 0只说明观测完成，其产品结论仍是失败。

### MiniMax CLI

- 实際调用 `mmx text chat --messages-file … --output json --non-interactive`，模型返回 `MiniMax-M2.7`，见 [调用元数据](minimax-evidence.json) 和 [退出记录](minimax-exit.json)。输入只含本次源码／规格和测试节选，不含用户凭据。
- 该 CLI 在本机是模型服务入口，没有自动执行本机测试的循环。因此其贡献是独立静态质疑，不冒称它操作过界面。
- [首轮报告](minimax-report-original.md) 抓到模型配置入口与普通装配缺失，但错误声称 `:focus-visible` 会沿祖先继承、所有测试都用 mock，并给出不可执行脚本。主会话核对实际 CSS 和 helper 覆盖顺序，明确退回。
- [更正报告](minimax-report-corrected.md) 撤回上述错误；其测试片段仍有错误和预置 mock，不直接复制入库或作为执行证据。保留有源码和 ZCode 实测共同支持的缺陷：Composer 内外同时画框；正常模型配置到发送路径缺失。外部 AI 的正文是审查材料，不自动成为权威结论。
- 模型实施树出现新 E2E 草稿后，另外调用 MiniMax 进行 [测试草稿复核](minimax-model-test-review.md)。采纳有代码依据的重开缺失、401 无错误断言、请求 model 匹配过宽；不采纳“waitFor 不构成断言”“close 未 await”等错误说法。主会话还发现 `.test.ts` 不在现有 `*.test.mjs` 正式入口，以及首个失败路径可能删除活进程数据目录，均已交回实施者，当前不宣称已修。

## 焦点根因、补修与红绿证据

全局 `textarea:focus-visible` 规则在文字框被鼠标点击或 Tab 进入时均生效，为 textarea 绘制 2px 内阴影。圆角 `.input-surface` 同时绘制 1px 组反馈；子元素的焦点没有继承给外壳，两个选择器实际分别命中不同元素。

补修只在 Composer 增加两个局部类：文字编辑区不再绘制自己的阴影，由圆角外壳承担 2px 焦点反馈；壳内按钮与其他输入框的全局键盘反馈保持。对应规则写入 [DESIGN](../../../DESIGN.md#浮层键盘与焦点)。

- 新 [正常入口回归](../../../test/e2e/composer-focus.test.mjs) 在旧构建实际失败，见 [失败日志](focus-before.log)、[旧读回](focus-before.json)、[旧截图](focus-before.png)。失败是实际出现 `rgb(236, 236, 238) … 2px inset`，没有用静态类名判断替代。
- 新构建 [复验 1/1](focus-after.log)，八组观测均为 textarea 阴影 none、圆角外壳 2px；Tab 可达菜单，菜单有独立焦点，切焦后草稿保留。见 [新读回](focus-after.json)、[新截图](focus-after.png)。
- 经固定入口正常退出后重开一次当前开发客户端，见 [刷新日志](desktop-refresh.log)，新进程 PID 33724。原生窗口返回 Home 并实际点击 textarea，已看到只有圆角外框；截图触发了系统自动填充私人提示，已从项目移除，只保留不含个人信息的后台截图。没有重跑可见测试矩阵。
- 测试工装初次使用错误的主题 data 属性导致等待超时；已按实际 `.dark` 类修正，单独保留 [工装诊断](focus-harness-diagnostic.log)，不将其冒充产品失败。

## Dock 验证补充

旧品牌测试只解码 `dcode-owl-master.png`，主进程现在读取 `dcode-macos.png`，旧结果不足以验证新消费者。新 [Dock 定向测试](../../../test/e2e/dock-icon.test.mjs) 通过隔离启动包装拦截真正 `setIcon` 输入，随后仍调用原方法并运行正式主进程；验证该图与平台资产一致、四角透明、中心可见、外边距适当。结果 [1/1 通过](dock-consumer.log)。

此测试不修改产品桥，不增加测试专用业务分支。新平台图保留低透明度抗锯齿外缘，原尺寸曾看到部分毛边；缩小后的真实 Dock 观感另行核对。PNG 解码与消费者检查不等于系统视觉验收。

## 工程与未完成边界

[架构](architecture.log)、[全范围类型](typecheck.log)、[Lint](lint.log)、[构建](build.log) 均通过。`507-review` 独立只读复核已确认 Composer 修复无阻塞；补测后另核确认实际 Dock 消费者验证已填补旧资产错配缺口，未发现本片剩余阻塞，系统像素观感仍未验。上述结论对应当时首用检查。后续配置、凭据安全、请求失败、重开与保存互斥已在主目录组合验证；现行证据见 [模型配置与入口更新](../模型首次添加-2026-10-09/README.md)，原失败材料继续保留。

截至本记录，尚未修改用户真实模型配置、发起实际服务商请求、合并 main、提交或发布。当前窗口已刷新并核实输入框；尝试原生 Dock 状态读取超时，不据此宣称其像素视觉验收通过。
