import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("../../host/scripts/generate-license-manifest.mjs", import.meta.url));
test("candidate notices retain full dependency text and fail on unknown missing or unsupported licenses", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-license-test-"));
  try {
    const modules = join(root, "node_modules"), output = join(root, "packages.txt"), archive = join(root, "licenses");
    const pkg = join(modules, "fixture"); await mkdir(pkg, { recursive: true });
    const manifest = license => writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", license }));
    const run = () => spawnSync(process.execPath, [generator, modules, output, archive], { encoding: "utf8" });
    await manifest("MIT");
    assert.notEqual(run().status, 0, "an unreviewed archive without a license cannot ship");
    const text = "Fixture copyright and complete license text";
    await writeFile(join(pkg, "LICENSE"), text);
    let result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(archive, "fixture%401.0.0", "LICENSE"), "utf8"), text);
    assert.match(await readFile(output, "utf8"), /fixture@1\.0\.0\tMIT\tLICENSE/);
    await manifest("UNREVIEWED-LICENSE");
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /unreviewed license/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
