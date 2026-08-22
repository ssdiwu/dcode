import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelProvidersStore } from "../src/model-providers.js";

async function makeStore(): Promise<{ store: ModelProvidersStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-model-providers-"));
  await mkdir(join(root, "agent"), { recursive: true });
  const store = new ModelProvidersStore(join(root, "agent", "models.json"));
  return { store, root };
}

test("model providers list sanitizes secrets and tolerates comments", async () => {
  const { store, root } = await makeStore();
  try {
    await writeFile(store.path, `
      // 用户注释：自定义供应商
      {
        "providers": {
          "my-relay": {
            "name": "Relay",
            "baseUrl": "https://relay.example/v1",
            "apiKey": "sk-secret-value",
            "headers": { "X-Org": "org-token" },
            "models": [
              { "id": "m1", "name": "M1", "reasoning": true, "contextWindow": 128000 }
            ],
            "modelOverrides": {
              "m1": { "headers": { "X-Model-Token": "model-token-secret" } }
            }
          }
        }
      }
    `);
    const list = await store.list();
    assert.equal(list.parseError, null);
    assert.equal(list.providers.length, 1);
    const provider = list.providers[0]!;
    assert.equal(provider.id, "my-relay");
    assert.equal(provider.authMode, "apiKey");
    assert.equal(provider.authConfigured, true);
    assert.deepEqual(provider.headerKeys, ["X-Org"]);
    assert.equal(provider.modelOverridesJson, null, "modelOverrides 恒不回传（可嵌套凭据）");
    assert.equal(JSON.stringify(provider).includes("sk-secret-value"), false, "凭据正文不得进入视图");
    assert.equal(JSON.stringify(provider).includes("org-token"), false, "header 值不得进入视图");
    assert.equal(
      JSON.stringify(provider).includes("model-token-secret"),
      false,
      "modelOverrides.<model>.headers 的值正文不得进入视图（0.0.16 审计 P1）",
    );
    assert.equal(provider.models[0]!.id, "m1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model providers save merges secrets, preserves advanced fields, validates and writes", async () => {
  const { store, root } = await makeStore();
  try {
    await writeFile(store.path, JSON.stringify({
      providers: {
        "my-relay": {
          name: "Relay",
          baseUrl: "https://relay.example/v1",
          apiKey: "sk-existing",
          headers: { "X-Org": "org-token" },
          models: [
            {
              id: "m1",
              name: "Old Name",
              thinkingLevelMap: { high: "max" },
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
            },
          ],
          modelOverrides: { m1: { name: "别名" } },
        },
        "other": { name: "Other", models: [{ id: "x" }] },
      },
    }));

    const result = await store.save({
      id: "my-relay",
      name: "Relay 2",
      baseUrl: "https://relay2.example/v1",
      models: [
        { id: "m1", name: "New Name", contextWindow: 200000 },
        { id: "m2" },
      ],
      compatJson: null,
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    const raw = JSON.parse(await readFile(store.path, "utf8"));
    const provider = raw.providers["my-relay"];
    assert.equal(provider.name, "Relay 2");
    assert.equal(provider.baseUrl, "https://relay2.example/v1");
    assert.equal(provider.apiKey, "sk-existing", "未提交新凭据时既有凭据原样保留");
    assert.equal(provider.headers["X-Org"], "org-token", "headers 整体保留");
    assert.equal(provider.models.length, 2);
    const m1 = provider.models.find((m: { id: string }) => m.id === "m1");
    assert.equal(m1.name, "New Name");
    assert.equal(m1.thinkingLevelMap.high, "max", "模型高级字段保留");
    assert.equal(m1.cost.input, 1, "cost 保留");
    assert.equal(provider.modelOverrides["m1"].name, "别名", "modelOverrides 保留");
    assert.equal(raw.providers.other.name, "Other", "其余供应商不受影响");

    const listed = await store.list();
    assert.equal(listed.providers.find((entry) => entry.id === "my-relay")?.models.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model providers save replaces auth when asked and refuses invalid input without writing", async () => {
  const { store, root } = await makeStore();
  try {
    await writeFile(store.path, JSON.stringify({
      providers: { my: { name: "M", apiKey: "sk-old", models: [{ id: "a" }] } },
    }));
    const before = await readFile(store.path, "utf8");

    const invalid = await store.save({
      id: "my",
      baseUrl: "not a url",
      models: [{ id: "" }, { id: "a" }, { id: "a" }],
    });
    assert.equal(invalid.ok, false);
    const fields = (invalid as { errors: Array<{ field: string }> }).errors.map((error) => error.field);
    assert.ok(fields.includes("baseUrl"));
    assert.ok(fields.includes("models[0].id"));
    assert.ok(fields.includes("models[2].id"), "重复模型 id 报错");
    assert.equal(await readFile(store.path, "utf8"), before, "非法输入零写入");

    const badAdvanced = await store.save({
      id: "my",
      models: [],
      compatJson: "{ not json",
    });
    assert.equal(badAdvanced.ok, false);
    assert.ok((badAdvanced as { errors: Array<{ field: string }> }).errors.some((error) => error.field === "compatJson"));

    const replaced = await store.save({
      id: "my",
      newApiKey: "sk-new",
      models: [{ id: "a" }],
    });
    assert.equal(replaced.ok, true);
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(raw.providers.my.apiKey, "sk-new");

    const oauth = await store.save({ id: "my", oauthRadius: true, models: [] });
    assert.equal(oauth.ok, true);
    const rawOauth = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(rawOauth.providers.my.oauth, "radius");
    assert.equal(rawOauth.providers.my.apiKey, undefined, "切 OAuth 时移除 apiKey");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model providers remove deletes one provider and keeps the rest", async () => {
  const { store, root } = await makeStore();
  try {
    await writeFile(store.path, JSON.stringify({
      providers: {
        a: { name: "A", models: [{ id: "x" }] },
        b: { name: "B" },
      },
    }));
    const result = await store.remove("a");
    assert.equal(result.ok, true);
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(raw.providers.a, undefined);
    assert.equal(raw.providers.b.name, "B");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model providers refuses to write over an unparsable models.json", async () => {
  const { store, root } = await makeStore();
  try {
    await writeFile(store.path, "{ broken json !!");
    const before = await readFile(store.path, "utf8");
    const listed = await store.list();
    assert.notEqual(listed.parseError, null, "解析错误如实上报");
    const result = await store.save({ id: "fresh", models: [{ id: "m" }] });
    assert.equal(result.ok, false);
    assert.ok((result as { errors: Array<{ field: string }> }).errors[0]!.field === "models.json");
    assert.equal(await readFile(store.path, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction info merges project over global and falls back to defaults", async () => {
  const { PiHost } = await import("../src/pi-host.js");
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-compaction-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  try {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: true, reserveTokens: 32768 },
    }));
    const host = new PiHost({ agentDir, emit: () => undefined });
    await host.handle("host.hello", {});
    const first = await host.handle("session.compactionInfo", {}) as {
      enabled: boolean; reserveTokens: number; keepRecentTokens: number;
    };
    assert.equal(first.enabled, true);
    assert.equal(first.reserveTokens, 32768, "全局 reserveTokens 生效");
    assert.equal(first.keepRecentTokens, 20000, "缺省回落 Pi 默认");

    await host.handle("session.compact", {}).then(
      () => assert.fail("无打开会话时必须报错"),
      (error: { code?: string }) => assert.notEqual(error.code, undefined),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model providers serialize concurrent writes so no update is lost", async () => {
  const { store, root } = await makeStore();
  try {
    await writeFile(store.path, JSON.stringify({
      providers: { base: { name: "Base", models: [{ id: "a" }] } },
    }));

    // 并发保存 / 删除：串行化保证每次操作都基于最新文件合并，不出现交错或丢失更新。
    const operations = await Promise.all([
      store.save({ id: "p1", name: "One", models: [{ id: "m1" }] }),
      store.save({ id: "p2", name: "Two", models: [{ id: "m2" }] }),
      store.save({ id: "p1", name: "One Prime", models: [{ id: "m1" }, { id: "m1b" }] }),
      store.remove("base"),
    ]);
    for (const result of operations) assert.equal(result.ok, true, JSON.stringify(result));

    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.deepEqual(Object.keys(raw.providers).sort(), ["p1", "p2"]);
    assert.equal(raw.providers.p1.name, "One Prime", "后写合并胜出且不丢其他结果");
    assert.equal(raw.providers.p1.models.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
