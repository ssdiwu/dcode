# D Code 对抗测试最终报告

**范围**：基线 out/main/index.js=4ec4bc00，隐藏隔离窗口，正常装配（ASSEMBLY=''、SAMPLE='0'）；两次实测均 BASELINE STABLE=true，证据在 report 工作目录（focus/settings-observations.json、12+张截图）。

## 已实测——产品不通过点

1. **Composer 双框（基线上确认，已复现）**：深/浅×13/14px×鼠标/真实Tab 八组全中。textarea 点击或 Tab 后 `:focus-visible=true`，自身 2px 直角（radius=0）内描边（深色 #ececee 即“白框”），与外壳 1px 弱描边叠加。根因：styles.css:177 全局焦点规则选择器含 textarea，而 .input-surface 的 `:not(:focus-visible)` 守卫（styles.css:191）测试的是永不可聚焦的壳，无法抑制；与 Composer.tsx:2“textarea 无焦点框”声明直接冲突。主会话新构建 81a3331b 已修（实测 textarea shadow=none、壳升 2px）。

2. **首次完整路径失败（新旧构建均在）**：设置→模型页 0 个输入框、仅 5 个导航按钮，无添加/保存/密钥入口；桥面 11 操作无 configureModel；Settings 契约白名单仅 theme/fontSize/coldStart/language（contracts/ui.ts:267 拒绝其余键）；持久化文件无凭据字段；重开仍 unavailable（草稿保留属实）。用户无法经产品配置模型并发起任何请求——“发送禁用”与“无密钥框”是缺失而非完成。

## 已实测——测试误放行

cold-start.test.mjs:27-32 将“无配置入口、无 configureModel”断言为正确（“无假表单”），只证诚实禁用；全部功能测试经 mock/pi-controlled 装配绕过正常路径，无一条证明用户可自行配置并完成请求。

## 建议（未执行，供后续实现）

补可执行反例：空字段/非法 URL 拒存可重试；凭据失败如实呈现；保存失败不假成功；重开后配置在且密钥不明文落盘（state JSON 现无此字段）；经设置页配置后真实 SDK 请求往返成功。