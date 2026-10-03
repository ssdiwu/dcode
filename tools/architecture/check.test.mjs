import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkArchitecture } from "./check.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const checker = fileURLToPath(new URL("./check.mjs", import.meta.url));
const policy = JSON.parse(fs.readFileSync(path.join(repository, "architecture-policy.json"), "utf8"));
const tsconfig = fs.readFileSync(path.join(repository, "tsconfig.json"), "utf8");

function fixture(t, files, transform = (value) => value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-architecture-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "architecture-policy.json"), JSON.stringify(transform(structuredClone(policy))));
  fs.writeFileSync(path.join(root, "tsconfig.json"), tsconfig);
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return root;
}

const contracts = { "src/contracts/index.ts": "export interface View { title: string }\n" };
function rejects(t, files, rule, transform) {
  const result = checkArchitecture(fixture(t, { ...contracts, ...files }, transform));
  assert.ok(result.violations.some((violation) => violation.rule === rule), JSON.stringify(result, null, 2));
}

test("legal composition and renderer type imports use public contracts", (t) => {
  const root = fixture(t, {
    ...contracts,
    "src/renderer/index.tsx": 'import type { View } from "@/contracts"; import React from "react"; import "./style.css"; export const title = (v: View) => v.title;',
    "src/renderer/style.css": ":root { color: black; }",
    "src/application/index.ts": 'export interface ExecutionPort { submit(text: string): void }',
    "src/adapters/mock/index.ts": 'import type { ExecutionPort } from "@/application"; export const mock: ExecutionPort = { submit() {} };',
    "src/main/index.ts": 'import { mock } from "@/adapters/mock"; import { app } from "electron"; import fs from "node:fs";',
    "src/preload/index.ts": 'import type { View } from "@/contracts"; import { contextBridge } from "electron";',
  });
  const result = checkArchitecture(root);
  assert.equal(result.files, 6);
  assert.deepEqual(result.violations, []);
});

test("empty bootstrap is explicitly reported as zero product sources", (t) => {
  const root = fixture(t, {});
  assert.deepEqual(checkArchitecture(root), { files: 0, modules: [], violations: [] });
  const command = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(command.status, 0);
  assert.match(command.stdout, /No product source yet/u);
});

for (const dependency of ["node:fs", "fs/promises", "electron", "@earendil-works/pi-durable"]) {
  test(`renderer rejects host dependency ${dependency}`, (t) => {
    rejects(t, { "src/renderer/index.ts": `import x from ${JSON.stringify(dependency)};` }, "EXTERNAL");
  });
}

test("renderer cannot reach application even through a configured path alias", (t) => {
  rejects(t, { "src/renderer/index.ts": 'import { app } from "@/application";', "src/application/index.ts": "export const app = {};" }, "DIRECTION");
});
test("allowed module direction still rejects private implementation imports", (t) => {
  rejects(t, { "src/renderer/index.ts": 'import type { Secret } from "../contracts/private";', "src/contracts/private.ts": "export interface Secret {}" }, "PRIVATE_IMPORT");
});
test("re-exports cannot launder host access through the contract module", (t) => {
  rejects(t, { "src/contracts/index.ts": 'export * from "../adapters/storage";', "src/adapters/storage/index.ts": "export const store = {};" }, "DIRECTION");
});
test("literal dynamic imports are checked", (t) => {
  rejects(t, { "src/renderer/index.ts": 'export const load = () => import("../adapters/pi");', "src/adapters/pi/index.ts": "export const pi = {};" }, "DIRECTION");
});
test("computed module names fail instead of silently reducing coverage", (t) => {
  rejects(t, { "src/renderer/index.ts": 'const name = "react"; export const load = () => import(name);' }, "DYNAMIC_IMPORT");
});
test("CommonJS require cannot bypass renderer restrictions", (t) => {
  rejects(t, { "src/renderer/index.cjs": 'const fs = require("fs");' }, "EXTERNAL");
});
test("module.require cannot bypass renderer restrictions", (t) => {
  rejects(t, { "src/renderer/index.cjs": 'const fs = module.require("node:fs");' }, "EXTERNAL");
});
test("bracket-form require is checked", (t) => {
  rejects(t, { "src/renderer/index.cjs": 'const fs = window["require"]("node:fs");' }, "EXTERNAL");
});
test("TypeScript import-equals is checked", (t) => {
  rejects(t, { "src/renderer/index.cts": 'import fs = require("node:fs");' }, "EXTERNAL");
});
test("TypeScript import types are checked", (t) => {
  rejects(t, { "src/renderer/index.ts": 'type Private = import("../application/private").Private;', "src/application/private.ts": "export interface Private {}" }, "DIRECTION");
});
test("same-module file cycles fail", (t) => {
  rejects(t, { "src/renderer/a.ts": 'import { b } from "./b"; export const a = b;', "src/renderer/b.ts": 'import { a } from "./a"; export const b = a;' }, "CYCLE");
});
test("unknown source module fails instead of becoming uninspected code", (t) => {
  rejects(t, { "src/misc/unowned.ts": "export const value = 1;" }, "UNMANAGED");
});
test("source outside src also fails", (t) => {
  rejects(t, { "runtime/hidden.ts": "export const value = 1;" }, "UNMANAGED");
});
test("product imports cannot reach excluded test implementations", (t) => {
  rejects(t, { "src/renderer/index.ts": 'import { value } from "../../test/fake";', "test/fake.ts": "export const value = 1;" }, "UNMANAGED_IMPORT");
});
test("missing internal imports fail", (t) => {
  rejects(t, { "src/renderer/index.ts": 'import { value } from "@/contracts/missing";' }, "UNRESOLVED");
});
test("syntax errors fail", (t) => {
  rejects(t, { "src/renderer/index.ts": "export const = ;" }, "SYNTAX");
});
test("source directory symlinks cannot escape the audit", (t) => {
  const root = fixture(t, contracts);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "hidden.ts"), "export const value = 1;");
  fs.symlinkSync(outside, path.join(root, "src/renderer"));
  assert.ok(checkArchitecture(root).violations.some((item) => item.rule === "SOURCE_SYMLINK"));
});
test("module policy cannot exclude the source root", (t) => {
  rejects(t, {}, "POLICY", (value) => ({ ...value, excludedDirectories: [...value.excludedDirectories, "src"] }));
});
test("product source cannot be disguised as configuration", (t) => {
  rejects(t, {}, "POLICY", (value) => ({ ...value, configurationFiles: [...value.configurationFiles, "src/renderer/index.ts"] }));
});
test("policy dependencies must name real modules", (t) => {
  rejects(t, {}, "POLICY", (value) => { value.modules[0].allows = ["unknown"]; return value; });
});
test("mock and Pi implementations cannot depend on each other", (t) => {
  rejects(t, { "src/adapters/mock/index.ts": 'export * from "../pi";', "src/adapters/pi/index.ts": "export const value = 1;" }, "DIRECTION");
});
test("CLI returns a failing exit code for an illegal dependency", (t) => {
  const root = fixture(t, { "src/renderer/index.ts": 'import fs from "node:fs";' });
  const command = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(command.status, 1);
  assert.match(command.stderr, /\[EXTERNAL\]/u);
});
