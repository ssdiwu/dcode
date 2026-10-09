// 独立的隐藏不可聚焦宿主（ESM）：只做一件事——加载 dist/<variant>/sim.html。
// variant 由 DCODE_SIM_VARIANT 显式注入（current 默认；baseline 为负对照），不读残留 variant.txt。
// userData 隔离到专用目录（DCODE_STATE_DIR 显式注入），不碰默认 profile；
// 窗口 hidden / non-focusable / accessory（后台运行约定）；loadFile 错误向上抛并退出。
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIRNAME = fileURLToPath(new URL(".", import.meta.url));
const VARIANT = process.env.DCODE_SIM_VARIANT ?? "current";
if (!["current", "baseline"].includes(VARIANT)) {
  console.error(`DCODE_SIM_VARIANT 只接受 current|baseline（实际 ${VARIANT}）`);
  app.exit(2);
}

if (process.env.DCODE_STATE_DIR) app.setPath("userData", process.env.DCODE_STATE_DIR);
if (process.platform === "darwin" && app.dock) app.dock.hide();

async function boot() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(join(DIRNAME, "dist", VARIANT, "sim.html"));
}

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (err) {
    console.error("[sim-main] load failed:", err);
    app.exit(1);
    return;
  }
  app.on("window-all-closed", () => app.quit());
});
