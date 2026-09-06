import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const keys = ["dcode.appearance", "dcode.appearance.fontScale", "dcode.sidebar.userHidden", "dcode.inspector.userHidden", "dcode.sidebar.width", "dcode.inspector.width", "dcode.notifications.completionEnabled"];

// Read only the existing app's UI preferences; never enumerate its full domain.
export async function readLegacyPreferences(): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  await Promise.all(keys.map(async key => {
    try {
      const { stdout } = await run("/usr/bin/defaults", ["read", "com.diwu.pidcode", key], { timeout: 2000, maxBuffer: 1024 });
      const raw = stdout.trim();
      if (key.endsWith("width")) {
        const value = Number(raw);
        if (Number.isFinite(value)) values[key] = Math.max(180, Math.min(600, Math.round(value)));
      } else if (key.endsWith("userHidden") || key.endsWith("completionEnabled")) {
        if (["0", "1", "true", "false"].includes(raw)) values[key] = raw === "1" || raw === "true";
      } else if ((key.endsWith("fontScale") ? ["compact", "standard", "large"] : ["system", "light", "dark"]).includes(raw)) values[key] = raw;
    } catch { /* A missing preference uses the product default. */ }
  }));
  return values;
}
