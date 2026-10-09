# 第三方材料

当前重新设计工作区包含原创设计文档、架构检查工具、Electron 客户端与 Pi 运行切片。TypeScript 5.9.3 使用 Apache-2.0；新增 `@earendil-works/pi-durable`、`@earendil-works/pi-ai`、`@earendil-works/chord` 均固定 1.0.0、MIT，npm gitHead 均为 `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`。仅使用公开依赖入口，未复制或修改其源码；发行包许可证保留在各安装目录。精确版本、传递依赖与下载完整性由 package-lock.json 记录。shadcn/ui 的菜单/弹窗/提示基础原语已按下方「本片移植的组件文件」逐文件移植并登记；ai-elements 与 ZCode 业务组件尚未移植，未引入其品牌资产。

新增 ESLint、typescript-eslint、tsx 与 Node.js 类型声明按 package-lock.json 固定，使用 MIT，仅用于验证；各安装包保留原许可。后续实际分发仍须保留分发依赖的许可声明。

## 客户端实际引入的依赖

以下版本与当前安装包及锁文件核对，未修改包内实现；分发时保留各依赖自带的许可与第三方声明。共享控件来自本项目独立 UI 实现，不因设计参考相同就登记为上游移植。

| 包 | 版本 | 包声明许可 | 用途 |
|---|---|---|---|
| react / react-dom | 19.2.0 | MIT | 界面渲染 |
| lucide-react | 0.545.0 | ISC | 图标 |
| @radix-ui/react-dropdown-menu / @radix-ui/react-dialog / @radix-ui/react-tooltip | 2.1.25 / 1.2.0 / 1.3.0 | MIT | 菜单、模态弹窗与提示的宿主原语（经下方 vendored 适配层组合，实际使用规则见 architecture-policy 的 renderer externals 登记） |
| electron | 41.0.3 | MIT | Mac 客户端壳；其运行文件另附第三方许可 |
| electron-vite / vite / @vitejs/plugin-react | 4.0.1 / 7.1.9 / 5.0.4 | MIT | 构建与开发启动 |
| tailwindcss / @tailwindcss/vite | 4.1.14 | MIT | 共享样式 |
| playwright-core | 1.56.1 | Apache-2.0 | Electron 端到端验证 |
| esbuild | 0.25.12 | MIT | 构建与契约验证 |
| eslint-plugin-react-hooks | 7.1.1 | MIT | React Hooks 规则，兼容主树 ESLint 10.12.0 |
| @types/react / @types/react-dom | 19.2.2 / 19.2.1 | MIT | 开发类型声明 |

## 本片移植的组件文件（2026-10-07 组件接续第一片）

基础原语按已确认策略取自 shadcn/ui 上游（不搬 ZCode 本地改本；ZCode 固定研究副本只作适配参照，其 provenance 的 `referenceRevision` 只作许可参照，未记录初始复制版本，本表不登记为 importRevision）。固定来源：`github.com/shadcn-ui/ui @ e8c3143b1cd191280befcd6c9538284bb43399a8`（`apps/v4/registry/new-york-v4/ui/`），许可证 MIT（Copyright (c) 2023 shadcn，完整原文保留于 [licenses/shadcn-ui/LICENSE.md](licenses/shadcn-ui/LICENSE.md)，SHA-256 `1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f`）。每个移植文件保留原作者与许可归属、在文件头追加 D Code 本地修改说明。

| D Code 文件 | 上游文件 SHA256 | 主要本地修改 |
|---|---|---|
| src/renderer/components/ui/dropdown-menu.tsx | d954efb735f13734751207ad22cb0cddd7f6ec53c59d16675d103dae08cb61fb | cn() 改模板拼接；Radix 改按组件分包导入；颜色/圆角/字号映射 D Code DESIGN token；去 tw-animate-css 动画类（减少动态效果遵守）；仅导出本片使用的子组件；RadioItem 选中圆点显式 block，避免空 inline span 零尺寸 |
| src/renderer/components/ui/dialog.tsx | 2ade6074e5fad0a4eb171ead44c43d3301a3c83d186d7236fb1fdbea80ee556b | 同上；另：去内建右上角关闭钮与内部 button.tsx 依赖（退出动作由使用处显式给出）；位置沿用 D Code 贴窗 18vh 与 app-dialog 宽度类 |
| src/renderer/components/ui/tooltip.tsx | 611e4305879b2773eafe76bf3c5caa69d8e47367fd97887a71634a27828f4433 | 同上；delayDuration 定 400ms |

ai-elements 与 ZCode 业务组件本片未移植（工具块只借投影/分层结论，消息正文、编辑器、附件等不纳入）；`@radix-ui/react-slot` 安装后经核对无直接消费者，已移除。

[DESIGN.md](DESIGN.md#组件来源) 记录组件来源方案，[规范借鉴说明](doc/规范借鉴说明.md#参考材料的使用层次) 记录参考材料分层。实际引入时逐文件登记上游路径、采用的固定版本、适用许可、保留的声明及本地修改；候选组件和书签不登记为已采用代码。

旧实现的第三方声明保留在 [0.0.37 封档](https://github.com/ssdiwu/dcode/blob/7c97a7526ba5bca4527c98db85375dc4403edd9c/THIRD_PARTY_NOTICES.md)，不表示这些组件已进入新工作区。
