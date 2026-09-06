# D Code 品牌资源

507 于 2026-09-06 选定 **C-A 黑白变色龙**：头部空心、卷尾实心，保留 `</>` 形四肢与 D 形外轮廓。带底板图标用于系统；透明标志用于界面，不使用彩色候选或头部实心方案。

`DCodeMark.svg` 是唯一造型母版。`export.swift` 使用 macOS 自带 AppKit/CoreGraphics 从母版同步生成以下资源，无第三方依赖：

| 资源 | 使用位置 |
| --- | --- |
| `AppIcon.png` | Electron 窗口与 Dock；本地候选安装包资源 |
| `AppIcon.icns` | Swift/Electron 安装包、Finder；Swift 的“关于”读取系统应用图标 |
| `../Sources/PiDCode/Resources/DCodeLogo.png` | Swift 首页品牌区，template 图像随主题变色 |
| `../../client/src/renderer/src/assets/logo.png` | Web 导航品牌区、新任务/空对话、“关于”，通过 CSS mask 随主题变色 |

从项目根目录重新导出：

```bash
swift app/Resources/export.swift
```

母版与透明标志为 1024 × 1024；带底板 PNG 的画布也是 1024 × 1024，底板范围为 102–922，周围保持透明，避免在 Dock 中比相邻应用大一圈。ICNS 含 16、32、64、128、256、512、1024 像素档位。修改母版后须一次运行导出，避免 Web、Swift 和系统图标分叉。

导出只修改静态资源。构建、候选安装、运行中应用重启和正式发布仍分别执行。
