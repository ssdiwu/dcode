import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  DisabledPackageStore,
  collectResourcesSnapshot,
  packageSourceKey,
} from "../src/resources.js";
import {
  DCODE_FACTS_TOOL_NAME,
  createDCodeFactsExtension,
  type DCodeFactsContext,
} from "../src/dcode-facts.js";
import type { DCodeResourceLoader } from "../src/resource-policy.js";

test("package source keys accept strings and object entries", () => {
  assert.equal(packageSourceKey("npm:pi-mcp-adapter"), "npm:pi-mcp-adapter");
  assert.equal(packageSourceKey({ source: "../../pi-dgoal" }), "../../pi-dgoal");
  assert.equal(packageSourceKey({ autoload: true }), undefined);
  assert.equal(packageSourceKey(42), undefined);
});

test("disabled package store round-trips original entries atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-resources-store-"));
  try {
    const store = new DisabledPackageStore(join(root, "pi-dcode", "disabled-packages.json"));
    assert.deepEqual(await store.load(), [], "缺失文件按空清单处理");
    const original = [{ source: "../../pi-dgoal", autoload: true }, "npm:pi-mcp-adapter"];
    await store.save(original);
    assert.deepEqual(await store.load(), original, "对象条目原样保留");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeLoader(): DCodeResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [
        {
          path: "/root/node_modules/pi-dgoal/index.ts",
          resolvedPath: "/root/node_modules/pi-dgoal/index.ts",
          hidden: false,
          sourceInfo: { source: "package" },
          tools: new Map([["dgoal_plan", {}]]),
          commands: new Map([["dgoal", { name: "dgoal", description: "目标管理" }]]),
        },
        {
          path: "/root/inline.ts",
          resolvedPath: "/root/inline.ts",
          hidden: true,
          sourceInfo: { source: "builtin" },
          tools: new Map(),
          commands: new Map(),
        },
      ],
      errors: [{ path: "/root/broken.ts", error: "syntax error" }],
      runtime: {},
    }),
    getSkills: () => ({
      skills: [
        {
          name: "llm-wiki",
          description: "知识库构建",
          filePath: "/root/skills/llm-wiki/SKILL.md",
          sourceInfo: { source: "package" },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    }),
    getPrompts: () => ({
      prompts: [
        {
          name: "review",
          description: "代码评审",
          argumentHint: "目标",
          filePath: "/root/prompts/review.md",
          sourceInfo: { source: "agent" },
        },
      ],
      diagnostics: [],
    }),
  } as unknown as DCodeResourceLoader;
}

test("resource snapshot lists facts, hides inline extensions and marks disabled packages", () => {
  const settingsManager = SettingsManager.inMemory({
    packages: ["npm:pi-mcp-adapter", { source: "../../pi-dgoal" }],
  } as Parameters<typeof SettingsManager.inMemory>[0]);

  const snapshot = collectResourcesSnapshot({
    loader: fakeLoader(),
    settingsManager,
    disabled: ["npm:pi-mcp-adapter"],
  });

  assert.deepEqual(
    snapshot.packages,
    [
      { source: "npm:pi-mcp-adapter", kind: "npm", enabled: false },
      { source: "../../pi-dgoal", kind: "path", enabled: true },
    ],
    "停用包来自影子清单并按来源分类",
  );
  assert.equal(snapshot.extensions.length, 1, "隐藏的内联扩展不进用户面");
  assert.equal(snapshot.extensions[0]!.toolCount, 1);
  assert.equal(snapshot.extensions[0]!.commandCount, 1);
  assert.equal(snapshot.skills[0]!.name, "llm-wiki");
  assert.equal(snapshot.prompts[0]!.name, "review");
  const commandNames = snapshot.commands.map((command) => command.name);
  assert.ok(commandNames.includes("dgoal"), "扩展命令进入命令列表");
  assert.ok(commandNames.includes("review"), "prompt 模板进入命令列表");
  assert.ok(commandNames.includes("skill:llm-wiki"), "skill 命令进入命令列表");
  assert.ok(snapshot.diagnostics.some((entry) => entry.message.includes("broken.ts")));
});

interface CapturedTool {
  name: string;
  parameters: unknown;
  execute: (id: string, params: { kind: string }) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function captureFactsTool(context: DCodeFactsContext, factsDir: string): CapturedTool {
  let captured: CapturedTool | undefined;
  createDCodeFactsExtension(context, { factsDir })({
    registerTool: (tool: unknown) => {
      captured = tool as CapturedTool;
    },
  } as never);
  assert.ok(captured, "工具必须被注册");
  return captured!;
}

test("dcode_facts reads ledgers and reports missing files honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-facts-"));
  const factsDir = join(root, "facts");
  await mkdir(factsDir, { recursive: true });
  try {
    await writeFile(
      join(factsDir, "session-changes-v1.json"),
      JSON.stringify({
        version: 1,
        records: [
          {
            recordId: "r1",
            sessionId: "session-a",
            filePath: "/repo/a.swift",
            additions: 3,
            deletions: 1,
            firstChangedLine: 12,
            source: "dcode",
          },
          { recordId: "r2", sessionId: "session-b", filePath: "/repo/b.swift", additions: 1, deletions: 0 },
        ],
      }),
      "utf8",
    );
    // 夹具使用 Swift 侧真实编码形状（0.0.16 审计 P1：此前夹具自造数组/枚举导致假绿）：
    // VerificationEvidenceDocument { version, records } + exitKind ∈ ok/failure/unknown；
    // ProjectStore 写 projects-v1.json 的 { version, projects }。
    await writeFile(
      join(factsDir, "verification-evidence-v1.json"),
      JSON.stringify({
        version: 1,
        records: [
          { recordId: "e1", sessionId: "session-a", command: "npm test", exitKind: "ok", gitRevision: "abc1234def" },
          { recordId: "e2", sessionId: "session-a", command: "swift test", exitKind: "failure", exitCode: 65 },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(factsDir, "projects-v1.json"),
      JSON.stringify({
        version: 1,
        projects: [{ id: "11111111-2222-3333-4444-555555555555", name: "D Code", sourceFolders: [{ path: "/repo" }] }],
      }),
      "utf8",
    );

    const context: DCodeFactsContext = {
      sessionId: () => "session-a",
      cwd: () => "/repo",
      paths: () => [
        { id: "root", title: "主路径", isCurrent: true, entryCount: 12 },
        { id: "leaf:9", title: "重构尝试", isCurrent: false, entryCount: 3 },
      ],
    };
    const tool = captureFactsTool(context, factsDir);
    assert.equal(tool.name, DCODE_FACTS_TOOL_NAME);

    const changes = await tool.execute("t1", { kind: "changes" });
    assert.ok(changes.content[0]!.text.includes("/repo/a.swift"));
    assert.ok(changes.content[0]!.text.includes("+3 −1"));
    assert.ok(!changes.content[0]!.text.includes("b.swift"), "只归因当前会话");

    const evidence = await tool.execute("t2", { kind: "evidence" });
    assert.ok(evidence.content[0]!.text.includes("npm test → 成功"));
    assert.ok(evidence.content[0]!.text.includes("swift test → 失败（退出码 65）"));
    assert.ok(evidence.content[0]!.text.includes("revision abc1234def".slice(0, 16)));

    const lineage = await tool.execute("t3", { kind: "lineage" });
    assert.ok(lineage.content[0]!.text.includes("主路径"));
    assert.ok(lineage.content[0]!.text.includes("当前路径"));

    const project = await tool.execute("t4", { kind: "project" });
    assert.ok(project.content[0]!.text.includes("D Code"));
    assert.ok(project.content[0]!.text.includes("/repo"));

    const noSession = captureFactsTool(
      { sessionId: () => undefined, cwd: () => undefined, paths: () => [] },
      factsDir,
    );
    const unavailable = await noSession.execute("t5", { kind: "changes" });
    assert.ok(unavailable.content[0]!.text.includes("没有打开的 D Code 会话"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dcode_facts reports unavailable instead of empty success when ledgers are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-facts-missing-"));
  try {
    const tool = captureFactsTool(
      { sessionId: () => "session-a", cwd: () => "/repo", paths: () => [] },
      join(root, "empty-facts"),
    );
    const changes = await tool.execute("t1", { kind: "changes" });
    assert.ok(changes.content[0]!.text.includes("不可用"), "账本缺失如实报不可用");
    const evidence = await tool.execute("t2", { kind: "evidence" });
    assert.ok(evidence.content[0]!.text.includes("不可用"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources.setPackageEnabled disables and restores a package via Pi settings", async () => {
  const { PiHost } = await import("../src/pi-host.js");
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-pi-host-resources-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const packageSource = "./no-such-pkg";
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [packageSource] })}\n`);
  try {
    const host = new PiHost({ agentDir, emit: () => undefined });
    await host.handle("host.hello", {});

    const first = await host.handle("resources.list", {}) as {
      packages: Array<{ source: string; enabled: boolean }>;
    };
    assert.equal(first.packages[0]?.source, packageSource);
    assert.equal(first.packages[0]?.enabled, true);

    await host.handle("resources.setPackageEnabled", { source: packageSource, enabled: false });
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: string[] };
    assert.equal(settings.packages?.includes(packageSource), false, "停用即从 Pi 配置移除");
    const shadow = JSON.parse(await readFile(join(agentDir, "pi-dcode", "disabled-packages.json"), "utf8")) as string[];
    assert.deepEqual(shadow, [packageSource], "原始条目进入影子清单");

    const second = await host.handle("resources.list", {}) as {
      packages: Array<{ source: string; enabled: boolean }>;
    };
    assert.equal(second.packages[0]?.enabled, false, "影子条目显示为已停用");

    await host.handle("resources.setPackageEnabled", { source: packageSource, enabled: true });
    const restored = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: string[] };
    assert.deepEqual(restored.packages, [packageSource], "启用按原始条目恢复");
    const shadowAfter = JSON.parse(await readFile(join(agentDir, "pi-dcode", "disabled-packages.json"), "utf8")) as string[];
    assert.deepEqual(shadowAfter, [], "影子清单清空");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
