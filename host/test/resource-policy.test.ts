import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createDCodeResourceSettingsManager,
  DCodeResourceLoader,
  isExternalDFastSource,
} from "../src/resource-policy.js";

test("D Code recognizes external pi-dfast package and file sources", () => {
  const external = [
    "pi-dfast",
    "pi-dfast@1.2.3",
    "npm:pi-dfast",
    "npm:pi-dfast@1.2.3",
    "/tmp/extensions/pi-dfast",
    "/tmp/extensions/pi-dfast.ts",
    "/tmp/extensions/pi-dfast.mjs",
    "https://github.com/example/pi-dfast.git#main",
    "C:\\extensions\\pi-dfast.js",
  ];
  for (const source of external) assert.equal(isExternalDFastSource(source), true, source);

  const retained = [
    "/tmp/extensions/pi-dusage.ts",
    "/tmp/extensions/my-pi-dfast-helper.ts",
    "npm:pi-dstatus",
    "https://github.com/example/pi-messenger.git",
  ];
  for (const source of retained) assert.equal(isExternalDFastSource(source), false, source);
});

test("D Code resource settings reload while excluding pi-dfast sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-resource-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultModel: "kept-model",
    packages: [
      "npm:pi-dfast@99.0.0",
      { source: "https://github.com/example/pi-dfast.git", autoload: false },
      "npm:pi-dstatus",
    ],
    extensions: ["/tmp/pi-dfast.ts", "/tmp/retained.ts"],
  }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    extensions: ["/tmp/project-retained.ts", "/tmp/project/pi-dfast.js"],
  }));
  try {
    const filtered = createDCodeResourceSettingsManager({ cwd, agentDir, projectTrusted: true });
    assert.equal(filtered.getDefaultModel(), "kept-model");
    assert.deepEqual(filtered.getPackages(), ["npm:pi-dstatus"]);
    assert.deepEqual(filtered.getExtensionPaths(), ["/tmp/project-retained.ts"]);

    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      extensions: ["/tmp/reloaded.ts", "/tmp/pi-dfast.mjs"],
    }));
    await filtered.reload();
    assert.deepEqual(filtered.getExtensionPaths(), ["/tmp/reloaded.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D Code resource reload discovers normal extensions without ever importing pi-dfast", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-resource-loader-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const extensionsDirectory = join(agentDir, "extensions");
  const retainedMarker = join(root, "retained-called");
  const reloadedMarker = join(root, "reloaded-called");
  const fastMarker = join(root, "fast-called");
  await mkdir(extensionsDirectory, { recursive: true });
  await mkdir(join(agentDir, "skills", "retained-skill"), { recursive: true });
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await writeFile(
    join(agentDir, "skills", "retained-skill", "SKILL.md"),
    "---\nname: retained-skill\ndescription: Retained resource\n---\n# Retained skill\n",
  );
  await writeFile(join(agentDir, "prompts", "retained.md"), "Retained prompt\n");
  const extensionSource = (marker: string) => `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(marker)}, "module\\n");
    export default function activate() { appendFileSync(${JSON.stringify(marker)}, "factory\\n"); }
  `;
  const retainedPath = join(extensionsDirectory, "retained.ts");
  await writeFile(retainedPath, extensionSource(retainedMarker));

  try {
    const sourceSettingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DCodeResourceLoader({
      cwd,
      agentDir,
      sourceSettingsManager,
      extensionFactories: [],
    });
    await loader.reload();
    assert.equal(await readFile(retainedMarker, "utf8"), "module\nfactory\n");
    assert.ok(loader.getExtensions().extensions.some((extension) => extension.path.endsWith("retained.ts")));
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === "retained-skill"));
    assert.ok(loader.getPrompts().prompts.some((prompt) => prompt.name === "retained"));

    await rm(retainedPath);
    await writeFile(join(extensionsDirectory, "reloaded.ts"), extensionSource(reloadedMarker));
    await writeFile(join(extensionsDirectory, "pi-dfast.ts"), extensionSource(fastMarker));
    await loader.reload();

    assert.equal(await readFile(reloadedMarker, "utf8"), "module\nfactory\n");
    await assert.rejects(access(fastMarker));
    const paths = loader.getExtensions().extensions.map((extension) => extension.path);
    assert.ok(paths.some((path) => path.endsWith("reloaded.ts")));
    assert.ok(paths.every((path) => !path.endsWith("retained.ts") && !path.endsWith("pi-dfast.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
