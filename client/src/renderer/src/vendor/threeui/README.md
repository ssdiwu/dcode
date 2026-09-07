# Structure Flow 注册源码

这 5 个注册文件从 507 提供的 [ThreeUI source bundle](https://threeui.com/source-code/structure-flow.json) 原样引入，完整 SHA-256 与给定值一致，身份记录见 `manifest.json`。禁止直接修改这些文件；宿主主题、可见性和降级在 `components/NewTaskScene.tsx` 与 `StructureFlowScene.tsx` 中适配。

选中 renderer 使用 `three128`（Three.js 0.128.0），其余 collection 懒加载分支由 Vite 解析到锁定的官方 `@designcodeio/threeui@1.2.0` 实现。TypeScript `rootDirs` 使用同一包的原始类型声明补全未选变体的类型引用，不伪造空组件。所选 `structure-flow` 不加载其他变体。

原版共享 CSS 中含其他组件的字体 URL `./fonts/fragment-mono.woff2`，该资产没有进入提供的注册 bundle；保持原文，所选场景不引用此字体。构建时存在未解析字体声明提示；新任务页验证须确认没有该字体或任何外部请求。

MIT 许可见 `LICENSE`。常规客户端构建和测试先运行 `scripts/verify-threeui.mjs`。新任务在减少动态效果、页面隐藏或 WebGL 不可用时使用静态底色，不更改原始文件与配置参数来模拟停帧。
