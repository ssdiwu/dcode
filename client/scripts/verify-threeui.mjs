import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../src/renderer/src/vendor/threeui/", import.meta.url));
const manifest = JSON.parse(await readFile(join(root,"manifest.json"),"utf8"));
for (const file of manifest.registeredFiles) {
  const actual = createHash("sha256").update(await readFile(join(root,file.path))).digest("hex");
  if (actual !== file.sha256) throw new Error(`ThreeUI registered source changed: ${file.path}`);
}
console.log(`ThreeUI: ${manifest.registeredFiles.length} original source hashes verified.`);
