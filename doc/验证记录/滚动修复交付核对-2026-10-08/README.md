# 滚动修复与视觉矩阵交付核对

2026-10-08，主会话收到原协调者最终 r5。这里核对交付文件与既有证据，没有在主目录运行或集成该候选。

- [交付核验](/Users/diwu/Workspace/Archives/dcode-scroll-and-matrix-delivery-2026-10-08/交付核验.md) 明确最终对象 r5；[候选](/Users/diwu/Workspace/Archives/dcode-scroll-and-matrix-candidate-2026-10-08-r5/README.md) 保持固定。
- manifest SHA256 `89ca195a3f31957a20350b634421683a128cde98dee40bdf02ad2c74775b6e23`，source 集合 SHA256 `e0d4e6fb605db33014e0e27a147b7be790071b97cbed3d9843bfb077f157e988` 均与交付相符；447 项 source 文件全部匹配，36 张矩阵图的字节数与 SHA256 全部匹配。
- 读取了九份 r5 原始 exit JSON 与对应 log：架构 28/28、运行31/31、契约4/4、产品阅读路径2/2、当前 fixture及资源3/3，类型/Lint/构建退出0。基线负对照退出1、2过1失败，是预期失败，不记整体通过。
- 36 图来自12组合，r5沿用未变化的矩阵/Timeline对应证据，不伪造重新运行。父版46/46仍只属于父版，本片没有重跑完整当前E2E。
- 独立聚焦报告SHA256 `cc4928b696fae6d67c6feaca9be48a514a1f7e93d941a0dff5a8160506ab388e` 与交付一致；原报告的细节校准留在交付说明，不把源代码复核冒充实际执行。

检查数据见 [handoff-integrity.json](handoff-integrity.json)。当前状态是已固定、已独立复核、主会话交付完整性核对通过，主目录选择性集成与目标目录复验仍未完成。新的品牌图标接入为下一独立片，不写回r5固定包。
