import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelProvidersStore } from "../src/model-providers.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerCatalogProviders } from "../src/model-catalog-configuration.js";
import { PiHost } from "../src/pi-host.js";
import { validateMethodParams, type HostMethod } from "../src/protocol.js";
import type {
  FoundationSnapshot,
  TaskBundle,
  ClientPreferences,
} from "../src/product-store.js";

test("settings preferences, native providers and archive actions survive restart without rewriting Pi settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-settings-"));
  const agent = join(root, "agent"),
    home = join(root, "home");
  await mkdir(agent);
  await mkdir(home);
  await writeFile(join(agent, "settings.json"), "{}\n");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "collision-source": {baseUrl:"https://collision.invalid/v1",api:"openai-completions",apiKey:"fixture-only",models:[{id:"collision-model",name:"Collision model",reasoning:false,contextWindow:100000,maxTokens:4096}]},
        "legacy-settings": {
          name: "Existing provider",
          baseUrl: "https://legacy.invalid/v1",
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "legacy-model",
              name: "Existing model",
              compat: { supportsStore: true },
              reasoning: false,
              contextWindow: 100000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  const configBefore = await readFile(join(agent, "models.json"), "utf8");
  const settingsBefore = await readFile(join(agent, "settings.json"), "utf8");
  let host = new PiHost({
    agentDir: agent,
    sessionsDirectory: join(agent, "sessions"),
    dataRoot: join(root, ".dcode"),
    userHome: home,
    emit: () => {},
  });
  let serial = 0;
  const snapshot = () =>
    host.handle("foundation.snapshot", {}) as Promise<FoundationSnapshot>;
  const mutate = async (
    method: HostMethod,
    params: Record<string, unknown>,
  ) => {
    const body = {
      ...params,
      requestId: `settings-${++serial}`,
      expectedStoreRevision: (await snapshot()).storeRevision,
    };
    validateMethodParams(method, body);
    return host.handle(method, body);
  };
  try {
    await host.start();
    const initial = await snapshot();
    await mutate("clientPreferences.importLegacy", {values:{"dcode.appearance":"dark","dcode.appearance.fontScale":"large","dcode.sidebar.width":280,"dcode.inspector.userHidden":true,"dcode.notifications.completionEnabled":false,"not-allowed":"ignored"}});
    const inherited = await host.handle("clientPreferences.get", {}) as ClientPreferences;
    assert.equal(inherited.appearance,"dark");
    assert.equal(inherited.fontScale,"large");
    assert.equal(inherited.sidebarWidth,280);
    assert.equal(inherited.overviewVisible,false);
    assert.equal(inherited.notificationsEnabled,false);
    await mutate("clientPreferences.set", {appearance:"light"});
    await mutate("clientPreferences.importLegacy", {values:{"dcode.appearance":"dark"}});
    assert.equal((await host.handle("clientPreferences.get", {}) as ClientPreferences).appearance,"light");
    await mutate("dcodeModelProvider.save", {
      provider: {
        id: "legacy-settings",
        name: "Adopted provider",
        baseUrl: "https://legacy.invalid/v1",
        apiKind: "openai-completions",
        credentialEnv: "",
        keepExistingAuth: true,
        adoptExisting: true,
        compatJson: '{"supportsStore":false}',
        models: [
          {
            modelId: "legacy-model",
            name: "Existing model",
            reasoning: false,
            contextWindow: 100000,
            maxTokens: 4096,
          },
        ],
      },
    });
    const adopted = (await snapshot()).modelProviders.find(
      (p) => p.id === "legacy-settings",
    )!;
    assert.equal(
      (adopted.nonsecret as { source: string }).source,
      "dcode_custom",
    );
    assert.ok(
      (await snapshot()).credentialReferences.find(
        (c) => c.providerId === "legacy-settings",
      )?.configured,
    );
    const checkRuntime=await ModelRuntime.create({authPath:join(agent,"auth.json"),modelsPath:join(agent,"models.json"),modelsStorePath:join(agent,"models-store.json"),allowModelNetwork:false});
    await registerCatalogProviders(checkRuntime, await snapshot());
    const adoptedModel=checkRuntime.getModels().find(model=>model.provider==="legacy-settings"&&model.id==="legacy-model");
    assert.equal((adoptedModel?.compat as {supportsStore?:boolean})?.supportsStore,true);
    await mutate("clientPreferences.set", {
      appearance: "dark",
      fontScale: "large",
      sidebarWidth: 300,
      inspectorWidth: 400,
      overviewVisible: false,
      enabledModels: ["test::model"],
      defaultThinking: "high",
    });
    const prefs = (await host.handle(
      "clientPreferences.get",
      {},
    )) as ClientPreferences;
    assert.equal(prefs.appearance, "dark");
    assert.equal(prefs.sidebarWidth, 300);
    await assert.rejects(
      mutate("clientPreferences.set", { appearance: "invalid" }),
      /Invalid appearance/,
    );
    const provider = {
      id: "settings-test",
      name: "本地设置测试",
      baseUrl: "https://settings.invalid/v1",
      apiKind: "openai-completions",
      credentialEnv: "DCODE_TEST_SETTINGS_KEY",
      models: [
        {
          modelId: "a",
          name: "Model A",
          reasoning: false,
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
    };
    await mutate("dcodeModelProvider.save", { provider });
    const existingProvider = (await snapshot()).modelProviders.find(
      (p) => p.id === "collision-source",
    );
    assert.ok(existingProvider);
      await assert.rejects(
        mutate("dcodeModelProvider.save", {
          provider: { ...provider, id: existingProvider.id },
        }),
        /已被内置或导入/,
      );
    await assert.rejects(
      mutate("dcodeModelProvider.save", {
        provider: { ...provider, credentialEnv: "", keepExistingAuth: true },
      }),
      /已有认证来源/,
    );
    let snap = await snapshot();
    assert.ok(
      snap.modelCatalogEntries.some((m) => m.providerId === provider.id),
    );
    assert.equal(
      snap.credentialReferences.find((c) => c.providerId === provider.id)
        ?.configured,
      false,
    );
    const previousEnv = process.env.DCODE_TEST_SETTINGS_KEY;
    process.env.DCODE_TEST_SETTINGS_KEY = "fixture-only";
    assert.equal(
      (await snapshot()).credentialReferences.find(
        (c) => c.providerId === provider.id,
      )?.configured,
      true,
    );
    if (previousEnv === undefined) delete process.env.DCODE_TEST_SETTINGS_KEY;
    else process.env.DCODE_TEST_SETTINGS_KEY = previousEnv;

    await mutate("dcodeModelProvider.save", {
      provider: {
        ...provider,
        models: [{ ...provider.models[0]!, modelId: "b", name: "Model B" }],
      },
    });
    snap = await snapshot();
    assert.deepEqual(
      snap.modelCatalogEntries
        .filter((m) => m.providerId === provider.id)
        .map((m) => m.modelId),
      ["b"],
    );
    await mutate("dcodeModelProvider.remove", { providerId: provider.id });
    assert.equal(
      (await snapshot()).modelCatalogEntries.filter(
        (m) => m.providerId === provider.id,
      ).length,
      0,
    );
    const task = (await mutate("task.create", {
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Task before",
      goal: "keep history",
    })) as TaskBundle;
    await mutate("task.manage", {
      taskId: task.task.id,
      action: "rename",
      title: "Task after",
    });
    assert.equal(
      (await snapshot()).sessions.find(
        (s) => s.id === task.coordinationSession.id,
      )?.title,
      "Task after",
    );
    await mutate("task.manage", { taskId: task.task.id, action: "archive" });
    assert.equal(
      (await snapshot()).tasks.find((t) => t.id === task.task.id)?.state,
      "archived",
    );
    await mutate("task.manage", { taskId: task.task.id, action: "restore" });
    assert.equal(
      (await snapshot()).tasks.find((t) => t.id === task.task.id)?.state,
      "draft",
    );
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.DCODE_TEST_SETTINGS_KEY;
    process.env.DCODE_TEST_SETTINGS_KEY = "fixture-only";
    let requestedModel = "";
    globalThis.fetch = (async (_url, init) => {
      requestedModel = JSON.parse(String(init?.body)).model;
      const chunk = {
        id: "settings-reply",
        object: "chat.completion.chunk",
        created: 1,
        model: "a",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Native provider works" },
            finish_reason: null,
          },
        ],
      };
      const end = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      await mutate("dcodeModelProvider.save", { provider });
      // The earlier preference test enabled only test::model. Native provider
      // execution must explicitly enable its model before selecting it.
      await mutate("clientPreferences.set", { enabledModels: ["test::model", "settings-test::a"] });
      await mutate("runtimeModelSelection.set", {
        providerId: provider.id,
        modelId: "a",
      });
      await host.handle("dcodeSession.prompt", {
        dcodeSessionId: task.coordinationSession.id,
        promptId: "native-provider-prompt",
        message: "Validate native provider",
      });
      const deadline = Date.now() + 8000;
      while (
        !(await snapshot()).sessionRuns.some(
          (r) =>
            r.sessionId === task.coordinationSession.id &&
            r.status === "completed",
        )
      ) {
        if (Date.now() > deadline)
          throw new Error(`Native provider did not complete: ${JSON.stringify((await snapshot()).sessionRuns.filter(r=>r.sessionId===task.coordinationSession.id))}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(requestedModel, "a");
      await assert.rejects(
        mutate("dcodeModelProvider.remove", { providerId: provider.id }),
        /默认供应商/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.DCODE_TEST_SETTINGS_KEY;
      else process.env.DCODE_TEST_SETTINGS_KEY = originalKey;
    }
    const copy = (await mutate("dcodeSession.copy", {
      dcodeSessionId: task.coordinationSession.id,
    })) as TaskBundle;
    assert.notEqual(copy.task.id, task.task.id);
    assert.equal(copy.task.title, "Task after 副本");
    assert.equal(
      (await snapshot()).sessions.filter((s) => s.taskId === copy.task.id)
        .length,
      1,
    );
    const route = [{providerId:"settings-test",modelId:"a"},{providerId:"legacy-settings",modelId:"legacy-model"}];
    const routed = await mutate("agentProfile.create", {name:"按序候选",roleContract:"Review assigned work",enabled:true,modelCandidates:route}) as {agentProfile: FoundationSnapshot["agentProfiles"][number]};
    assert.deepEqual(routed.agentProfile.modelCandidates,route);
    const beforeInvalid = await snapshot();
    await assert.rejects(mutate("agentProfile.update", {profileId:routed.agentProfile.id,expectedProfileRevision:routed.agentProfile.revision,name:"must rollback",roleContract:"Review assigned work",enabled:true,modelCandidates:[{providerId:"missing",modelId:"missing"}]}),/不在目录/);
    assert.equal((await snapshot()).storeRevision,beforeInvalid.storeRevision);
    assert.equal((await snapshot()).agentProfiles.find(p=>p.id===routed.agentProfile.id)?.name,"按序候选");
    await mutate("agentProfile.update",{profileId:routed.agentProfile.id,expectedProfileRevision:routed.agentProfile.revision,name:"按序候选",roleContract:"Updated contract",enabled:true});
    assert.deepEqual((await snapshot()).agentProfiles.find(p=>p.id===routed.agentProfile.id)?.modelCandidates,route);
    const profile = (await snapshot()).agentProfiles[0]!;
    await mutate("agentProfile.update", {
      profileId: profile.id,
      expectedProfileRevision: profile.revision,
      name: profile.name,
      roleContract: profile.roleContract,
      enabled: false,
    });
    assert.equal(
      (await snapshot()).agentProfiles.find((p) => p.id === profile.id)
        ?.enabled,
      false,
    );
    assert.equal(
      await readFile(join(agent, "models.json"), "utf8"),
      configBefore,
    );
    assert.equal(
      await readFile(join(agent, "settings.json"), "utf8"),
      settingsBefore,
    );
    await host.close();
    host = new PiHost({
      agentDir: agent,
      sessionsDirectory: join(agent, "sessions"),
      dataRoot: join(root, ".dcode"),
      userHome: home,
      emit: () => {},
    });
    await host.start();
    assert.equal(
      ((await host.handle("clientPreferences.get", {})) as ClientPreferences)
        .appearance,
      "dark",
    );
    assert.equal((await snapshot()).tasks.length, 2);
    const restoredRoute = (await snapshot()).agentProfiles.find(p=>p.id===routed.agentProfile.id)!;
    assert.deepEqual(restoredRoute.modelCandidates,route);
    await mutate("agentProfile.update",{profileId:restoredRoute.id,expectedProfileRevision:restoredRoute.revision,name:restoredRoute.name,roleContract:restoredRoute.roleContract,enabled:true,modelCandidates:null});
    assert.equal((await snapshot()).agentProfiles.find(p=>p.id===restoredRoute.id)?.modelCandidates,undefined);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("legacy model adoption refuses nested credential fields without exposing their values", async () => {
  const root=await mkdtemp(join(tmpdir(),"dcode-model-metadata-"));
  const path=join(root,"models.json");
  try {
    await writeFile(path,JSON.stringify({providers:{fixture:{baseUrl:"https://fixture.invalid/v1",api:"openai-completions",models:[{id:"a",samplingParams:{nested:{apiKey:"private-value"}}}]}}}));
    const source=new ModelProvidersStore(path);
    await assert.rejects(source.modelMetadata("fixture"), error=>error instanceof Error && error.message.includes("凭据字段") && !error.message.includes("private-value"));
  } finally {await rm(root,{recursive:true,force:true});}
});
