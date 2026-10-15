import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { launchApp, ready, cleanup, killApp } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

test("macOS Dock：实际 setIcon 消费平台图，圆角外沿透明且保留视觉留白", { skip: process.platform !== "darwin" }, async () => {
  const root = join(import.meta.dirname, "../..");
  const temp = mkdtempSync(join(tmpdir(), "dcode-dock-icon-"));
  const bootstrap = join(temp, "observe.cjs");
  // 从真正消费者截取输入，旧测试仅解码母版，即使 Dock 读错文件也会通过。
  writeFileSync(bootstrap, `
    const { app } = require("electron");
    const applyIcon = app.dock.setIcon.bind(app.dock);
    app.dock.setIcon = image => {
      globalThis.__observedDockIcon = image;
      return applyIcon(image);
    };
    import(${JSON.stringify(pathToFileURL(join(root, "out/main/index.js")).href)});
  `);
  let handle;
  try {
    handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" }, bootstrap);
    await ready(handle.page);
    const result = await handle.app.evaluate(({ nativeImage }, platformPath) => {
      const actual = globalThis.__observedDockIcon;
      if (!actual || actual.isEmpty()) return { received: false };
      const expected = nativeImage.createFromPath(platformPath);
      const { width, height } = actual.getSize();
      const data = actual.toBitmap();
      const alpha = (x, y) => data[(y * width + x) * 4 + 3];
      let minX = width, minY = height, maxX = 0, maxY = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (alpha(x, y) < 128) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      return {
        received: true, width, height, matchesPlatform: actual.toPNG().equals(expected.toPNG()),
        corners: [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)],
        center: alpha(Math.floor(width / 2), Math.floor(height / 2)),
        bounds: { minX, minY, maxX, maxY },
      };
    }, join(root, "resources/brand/dcode-macos.png"));
    assert.equal(result.received, true, "主进程必须实际调用 Dock 图标入口");
    assert.equal(result.matchesPlatform, true, "实际 Dock 输入必须是平台资产，而不是满幅直角母版");
    assert.deepEqual(result.corners, [0, 0, 0, 0]);
    assert.ok(result.center >= 250);
    for (const margin of [result.bounds.minX / result.width, result.bounds.minY / result.height, 1 - result.bounds.maxX / result.width, 1 - result.bounds.maxY / result.height]) {
      assert.ok(margin >= 0.07 && margin <= 0.12, `平台图应有适当透明外边距，实际 ${margin}`);
    }
    const evidence = evidenceDir("dock-icon");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "actual-consumer.json"), JSON.stringify(result, null, 2));
  } finally {
    if (handle) { try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); } }
    rmSync(temp, { recursive: true, force: true });
  }
});
