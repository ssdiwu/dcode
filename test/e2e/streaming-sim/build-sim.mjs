// 一次性构建模拟 fixture：esbuild 打包 sim-entry，并从已构建产品入口发现真实 CSS 产物。
// 不硬编码带 hash 文件名；CSS 在运行前用 existsSync 断言存在，测试里再断言实际加载与 overflowY=auto。
// 变体隔离：current（默认）与 baseline（负对照）各自写入独立 dist 目录 dist/<variant>/，
// 不互相覆盖、不由残留 variant.txt 决定来源。
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../");
const VARIANT = process.env.SIM_TIMELINE_VARIANT ?? "current";
if (!["current", "baseline"].includes(VARIANT)) {
  throw new Error(`SIM_TIMELINE_VARIANT 只接受 current|baseline（实际 ${VARIANT}）`);
}
const OUT = join(import.meta.dirname, "dist", VARIANT);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const TIMELINE_VARIANT = process.env.SIM_TIMELINE_VARIANT ?? "current";
// 对照构建：SIM_TIMELINE_VARIANT=baseline 用基线 source 中的 Timeline 替换当前树版本，复现旧无条件 count effect
// （基线目录与固定包保持只读——构建只读基线源码，不写回去）
const timelinePath = TIMELINE_VARIANT === "baseline"
  ? "/Users/diwu/Workspace/Archives/dcode-scroll-and-matrix-baseline-2026-10-08/source/src/renderer/views/Timeline.tsx"
  : join(ROOT, "src/renderer/views/Timeline.tsx");
const tooltipPath = join(ROOT, "src/renderer/components/ui/tooltip.tsx");

await build({
  entryPoints: [join(import.meta.dirname, "sim-entry.tsx")],
  bundle: true,
  format: "iife",
  outfile: join(OUT, "sim-bundle.js"),
  jsx: "automatic",
  platform: "browser",
  target: "chrome120",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "@": join(ROOT, "src"),
    "sim-timeline": timelinePath,
    "sim-tooltip": tooltipPath,
  },
  // 基线源码在 Archives 目录无 node_modules；从工作树的依赖解析（字节内容与基线清单登记一致）
  nodePaths: [join(ROOT, "node_modules")],
  logLevel: "warning",
});
writeFileSync(join(OUT, "variant.txt"), TIMELINE_VARIANT + "\n");

// 从已构建产品入口发现真实 CSS 产物（同一构建管线，hash 变化也能定位），同字节复制入本变体目录。
// 已证实的旧故障是 href 曾指向不存在的 test/out/...——产品 CSS 从未加载，overflow-y:auto 未生效；
// 复制进 dist/<variant>/ 后以 ./product.css 引用，不存在跨目录解析问题。
const productIndex = join(ROOT, "out/renderer/index.html");
if (!existsSync(productIndex)) {
  throw new Error(`缺少已构建产品入口 ${productIndex}；先运行 npm run build`);
}
const html = readFileSync(productIndex, "utf8");
const cssMatch = html.match(/<link[^>]+rel="stylesheet"[^>]+href="\.\/(assets\/[^"]+\.css)"/);
if (!cssMatch) throw new Error("无法从产品入口解析 CSS 产物路径");
const absCss = join(ROOT, "out/renderer", cssMatch[1]);
if (!existsSync(absCss)) throw new Error(`解析到的 CSS 产物不存在：${absCss}`);
copyFileSync(absCss, join(OUT, "product.css"));

writeFileSync(join(OUT, "sim.html"), `<!doctype html><html><head><meta charset="utf-8"><title>同块流式模拟</title>
<link id="product-css" rel="stylesheet" href="./product.css">
<style>
:root { --ui-font-size-num: 13; }
html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui; }
body { height: 100vh; display: flex; flex-direction: column; }
/* Timeline 根 main 需要 flex 父链支撑高度限制，否则 overflow 失效 */
#root { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
</style></head><body><div id="root"></div><script src="./sim-bundle.js"></script></body></html>`);
console.log("built", OUT, "css:", cssMatch[1]);
