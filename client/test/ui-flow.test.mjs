import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import { PiHost } from "../../host/dist/src/pi-host.js";
import { validateMethodParams } from "../../host/dist/src/protocol.js";
import { createServer } from "vite";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Node",
  "Element",
  "MutationObserver",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "getComputedStyle",
])
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.PointerEvent = window.MouseEvent;
globalThis.PointerEvent = window.MouseEvent;
window.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
window.HTMLElement.prototype.scrollTo = function ({ top }) {
  this.scrollTop = top;
};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
const React = await import("react");
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
const { SWRConfig } = await import("swr");
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { middlewareMode: true },
  appType: "custom",
});
const { useWorkbench } = await server.ssrLoadModule("/src/useWorkbench.ts");
const { App } = await server.ssrLoadModule("/src/App.tsx");
await server.close();
function providerResponse(signal, delay = 100) {
  const chunk = (content, finish = null) =>
    `data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } } : {}) })}\n\n`;
  let timer;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk("已完成隔离验证")));
        timer = setTimeout(() => {
          try {
            controller.enqueue(
              new TextEncoder().encode(chunk("", "stop") + "data: [DONE]\n\n"),
            );
            controller.close();
          } catch {}
        }, delay);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            try {
              controller.error(new Error("aborted"));
            } catch {}
          },
          { once: true },
        );
      },
      cancel() {
        clearTimeout(timer);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test(
  "real Host: create, stream, switch drafts, stop and restore without a paid Provider",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dcode-ui-flow-"));
    const agent = join(root, "agent"),
      home = join(root, "home");
    await mkdir(join(agent, "sessions"), { recursive: true });
    await mkdir(home);
    await writeFile(join(home,"selected-context.md"),"已选择的测试资料。\n");
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        defaultProvider: "local-test",
        defaultModel: "model-a",
        enabledModels: ["local-test/model-a", "local-test/model-b"],
      }),
    );
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          "local-test": {
            baseUrl: "https://dcode-test.invalid/v1",
            api: "openai-completions",
            apiKey: "test-key",
            models: [
              {
                id: "model-a",
                name: "Test model",
                reasoning: false,
                contextWindow: 100000,
                maxTokens: 4096,
              },
              {
                id: "model-b",
                name: "Test model B",
                reasoning: false,
                contextWindow: 100000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    const listeners = new Set();
    const originalFetch = globalThis.fetch;
    let responseDelay = 600;
    let providerCalls = 0;
    const providerModels = [];
    globalThis.fetch = async (input, init) => {
      if(String(input).startsWith("https://pi.dev/api/models/providers/")) return new Response("[]",{status:200,headers:{"content-type":"application/json","last-modified":"Fri, 04 Sep 2026 20:10:40 GMT"}});
      assert.match(String(input), /dcode-test.invalid/);
      providerCalls++;
      providerModels.push(JSON.parse(init.body).model);
      return providerResponse(init?.signal, responseDelay);
    };
    const hostOptions = {
      agentDir: agent,
      sessionsDirectory: join(agent, "sessions"),
      dataRoot: join(root, ".dcode"),
      userHome: home,
      leaseQuietWindowMs: 1,
      emit: (event, data) => {
        for (const handler of listeners)
          handler({ version: 1, type: "event", event, data });
      },
    };
    let host = new PiHost(hostOptions);
    await host.start();
    window.dcode = {
      request: async (method, params = {}) => {
        validateMethodParams(method, params);
        return await host.handle(method, params);
      },
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      notify: async () => true,
      signalRestoreFailed: async () => {},
      signalReady: async () => {},
      switchCandidate: async () => true,
      diagnostics: async () => ({
        version: "0.0.30",
        hostReady: true,
        events: [],
      }),
      clearDiagnostics: async () => true,
      openNotificationSettings: async () => {},
      revealCandidate: async () => {},
      readyToQuit() {},
      restartHost: async () => true,
      chooseDirectory: async () => null,
      chooseContextFiles: async () => [join(home,"selected-context.md")],
      getPathForFile: (file) => file.name,
      openExternal: async () => {},
    };
    let work;
    function Harness() {
      work = useWorkbench();
      return React.createElement(
        "div",
        null,
        React.createElement("input", {
          "aria-label": "draft",
          value: work.draft.text,
          onChange: (e) =>
            work.updateDraft(work.draftKey, {
              ...work.draft,
              text: e.target.value,
            }),
        }),
        React.createElement(
          "button",
          { onClick: () => void work.send() },
          "send",
        ),
        React.createElement("button", { onClick: work.newTask }, "new"),
        React.createElement(
          "button",
          { onClick: () => void work.stop() },
          "stop",
        ),
        React.createElement(
          "pre",
          null,
          JSON.stringify({
            task: work.task?.title,
            running: work.running,
            live: work.stream.messages,
            entries: work.presentation?.inspection?.entries,
            error: work.error,
          }),
        ),
      );
    }
    const mount = () =>
      render(
        React.createElement(
          SWRConfig,
          { value: { provider: () => new Map(), dedupingInterval: 0 } },
          React.createElement(Harness),
        ),
      );
    try {
      mount();
      await waitFor(() => assert.ok(work.snapshot));
      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "任务 A" },
      });
      fireEvent.click(screen.getByText("send"));
      await waitFor(() => assert.equal(work.task?.title, "任务 A"));
      await waitFor(
        () =>
          assert.match(
            work.stream.messages.map((m) => m.text).join(""),
            /已完成隔离验证/,
          ),
        { timeout: 10000 },
      );
      await waitFor(
        () =>
          assert.match(
            JSON.stringify(work.presentation?.inspection?.entries),
            /已完成隔离验证/,
          ),
        { timeout: 10000 },
      );
      await waitFor(() => assert.equal(work.running, false), {
        timeout: 10000,
      });
      await waitFor(() => assert.equal(work.draft.text, ""));
      const taskA = work.task,
        sessionA = work.session.id;
      const copySnapshot = await host.handle("foundation.snapshot", {});
      const copied = await host.handle("dcodeSession.copy", {
        requestId: "copy-full-history",
        expectedStoreRevision: copySnapshot.storeRevision,
        dcodeSessionId: sessionA,
      });
      const copiedPresentation = await host.handle(
        "dcodeSession.presentation",
        { dcodeSessionId: copied.coordinationSession.id },
      );
      assert.match(
        JSON.stringify(copiedPresentation.inspection.entries),
        /已完成隔离验证/,
      );
      assert.notEqual(
        copiedPresentation.binding.adapterSessionId,
        work.presentation.binding.adapterSessionId,
      );
      const beforeConflict = await host.handle("session.list", {});
      await assert.rejects(
        host.handle("dcodeSession.copy", {
          requestId: "copy-stale",
          expectedStoreRevision: 0,
          dcodeSessionId: sessionA,
        }),
        { code: "REVISION_CONFLICT" },
      );
      assert.equal(
        (await host.handle("session.list", {})).sessions.length,
        beforeConflict.sessions.length,
        "A rejected native copy must not leave adapter files",
      );

      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "A 独有的草稿" },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 600));
      });
      fireEvent.click(screen.getByText("new"));
      await waitFor(() => assert.equal(work.task, null));
      assert.equal(work.draft.text, "");
      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "新任务未提交草稿" },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 600));
      });
      await act(async () => work.select(taskA, sessionA));
      await waitFor(() => assert.equal(work.draft.text, "A 独有的草稿"));
      responseDelay = 1500;
      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "第二轮测试停止" },
      });
      fireEvent.click(screen.getByText("send"));
      await waitFor(() => assert.equal(work.running, true));
      // Test cancellation after Provider arrival; process startup is a separate boundary.
      await waitFor(() => assert.equal(providerCalls, 2));
      fireEvent.click(screen.getByText("stop"));
      await waitFor(() => assert.equal(work.running, false), {
        timeout: 10000,
      });
      assert.ok(!work.error, work.error);
      assert.equal(providerCalls, 2);
      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "重启后恢复 A 草稿" },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      const snap = await host.handle("foundation.snapshot", {});
      assert.equal(snap.tasks.length, 2);
      assert.equal(
        snap.composerDrafts.find((d) => d.sessionId === sessionA).text,
        "重启后恢复 A 草稿",
      );
      assert.ok(
        snap.composerDrafts.some(
          (d) => d.draftKind === "new_task" && d.text === "新任务未提交草稿",
        ),
      );
      cleanup();
      await host.close();
      host = new PiHost(hostOptions);
      await host.start();
      mount();
      await waitFor(() => assert.equal(work.session?.id, sessionA));
      await waitFor(() => assert.equal(work.draft.text, "重启后恢复 A 草稿"));
      cleanup();
      render(
        React.createElement(
          SWRConfig,
          { value: { provider: () => new Map(), dedupingInterval: 0 } },
          React.createElement(App),
        ),
      );
      await waitFor(() =>
        assert.ok(screen.getByRole("textbox", { name: "任务消息" })),
      );
      assert.equal(
        screen.getByRole("textbox", { name: "任务消息" }).value,
        "重启后恢复 A 草稿",
      );
      responseDelay = 200;
      fireEvent.change(screen.getByRole("textbox", { name: "任务消息" }), {
        target: { value: "恢复运行后测试模型切换" },
      });
      await waitFor(()=>assert.equal(screen.getByRole("button", {name:"发送"}).disabled,false),{timeout:10000});
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await waitFor(
        () =>
          assert.equal(
            providerModels.length,
            3,
            JSON.stringify({
              alerts: screen.queryAllByRole("alert").map((e) => e.textContent),
              disabled: screen.queryByRole("button", { name: "发送" })
                ?.disabled,
              input: screen.getByRole("textbox", { name: "任务消息" }).value,
            }),
          ),
        { timeout: 10000 },
      );
      await waitFor(async () => {
        const presentation=await host.handle("dcodeSession.presentation",{dcodeSessionId:sessionA});
        assert.equal(presentation.runtime.state.isStreaming,false);
        assert.equal(presentation.runtime.state.runState.phase,"completed");
      },{timeout:10000});
      fireEvent.click(screen.getByRole("button",{name:"文件与 Git"}));await waitFor(()=>assert.ok(screen.getByRole("tab",{name:"对话"})));fireEvent.click(screen.getByRole("tab",{name:"对话"}));
      fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), {
        button: 0,
        ctrlKey: false,
      });
      await waitFor(() =>
        assert.ok(screen.getByRole("menuitem", { name: "Test model B" })),
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Test model B" }));
      await waitFor(async () => {
        const p = await host.handle("dcodeSession.presentation", {
          dcodeSessionId: sessionA,
        });
        assert.equal(p.inspection.context.model.modelId, "model-b");
      });
      await waitFor(()=>assert.equal(screen.getByRole("button",{name:"选择模型"}).disabled,false),{timeout:10000});
      fireEvent.click(screen.getByRole("button",{name:"上下文与运行依据"}));
      fireEvent.click(screen.getByRole("button",{name:"添加文件"}));await waitFor(()=>assert.ok(screen.getByRole("button",{name:"移除资料 selected-context.md"})));
      fireEvent.click(screen.getByRole("button",{name:"保存选择"}));await waitFor(()=>assert.ok(screen.getByText("已保存，下次运行开始使用。")));
      fireEvent.click(screen.getByRole("button",{name:"关闭上下文"}));fireEvent.click(screen.getByRole("button",{name:"上下文与运行依据"}));assert.ok(screen.getByRole("button",{name:"移除资料 selected-context.md"}));fireEvent.click(screen.getByRole("button",{name:"关闭上下文"}));
      const priorLateKey=process.env.DCODE_UI_LATE_PROVIDER;process.env.DCODE_UI_LATE_PROVIDER="fixture-only";
      try {
        await work.mutateStore("dcodeModelProvider.save",{provider:{id:"late-provider",name:"Late provider",apiKind:"openai-completions",baseUrl:"https://dcode-test.invalid/v1",credentialEnv:"DCODE_UI_LATE_PROVIDER",models:[{modelId:"model-c",name:"Late model C",reasoning:false,contextWindow:100000,maxTokens:4096}]}});
        const lateView=await host.handle("dcodeModels.get",{dcodeSessionId:sessionA});
        assert.equal(lateView.models.find(model=>model.key==="late-provider::model-c").available,true,"new provider auth is registered for the existing session");
        await assert.rejects(host.handle("dcodeModels.select",{requestId:"disabled-late-provider",expectedStoreRevision:(await host.handle("foundation.snapshot",{})).storeRevision,dcodeSessionId:sessionA,providerId:"late-provider",modelId:"model-c"}),/已停用/);
        await work.mutateStore("clientPreferences.set",{enabledModels:[...lateView.models.filter(model=>model.enabled).map(model=>model.key),"late-provider::model-c"]});
        await work.mutateStore("dcodeModels.select",{dcodeSessionId:sessionA,providerId:"late-provider",modelId:"model-c"});
        assert.equal((await host.handle("dcodeSession.presentation",{dcodeSessionId:sessionA})).inspection.context.model.modelId,"model-c");
      } finally {if(priorLateKey===undefined)delete process.env.DCODE_UI_LATE_PROVIDER;else process.env.DCODE_UI_LATE_PROVIDER=priorLateKey;}
      const selectWithCurrentRevision=async input=>{let params={...input};for(let attempt=0;;attempt++){try{return await host.handle("dcodeModels.select",params);}catch(error){if(attempt>=7||error?.code!=="REVISION_CONFLICT"||typeof error.details?.expectedStoreRevision!=="number"||typeof error.details?.currentStoreRevision!=="number")throw error;params={...params,expectedStoreRevision:(await host.handle("foundation.snapshot",{})).storeRevision};}}};
      const selectA={requestId:"replay-select-a",expectedStoreRevision:(await host.handle("foundation.snapshot",{})).storeRevision,dcodeSessionId:sessionA,providerId:"local-test",modelId:"model-a"};
      await selectWithCurrentRevision(selectA);
      await selectWithCurrentRevision({...selectA,requestId:"replay-select-b",modelId:"model-b",expectedStoreRevision:(await host.handle("foundation.snapshot",{})).storeRevision});
      await selectWithCurrentRevision(selectA);
      assert.equal((await host.handle("dcodeModels.get",{dcodeSessionId:sessionA})).selectedKey,"local-test::model-b");
      await assert.rejects(host.handle("dcodeModels.select",{...selectA,modelId:"model-b"}),/requestId|REQUEST_ID|different/i);
      fireEvent.change(screen.getByRole("textbox", { name: "任务消息" }), {
        target: { value: "确认使用模型 B" },
      });
      await waitFor(()=>assert.equal(screen.getByRole("button", {name:"发送"}).disabled,false),{timeout:10000});
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await waitFor(() => assert.equal(providerModels.at(-1), "model-b"));
      await waitFor(
        () => assert.ok(screen.getByRole("button", { name: "发送" })),
        { timeout: 10000 },
      );
      fireEvent.click(screen.getByRole("button", { name: "搜索" }));
      fireEvent.change(
        screen.getByRole("textbox", { name: "搜索任务与消息" }),
        { target: { value: "任务" } },
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "搜索任务与消息" }),
        { target: { value: "任务 A" } },
      );
      await waitFor(() =>
        assert.ok(screen.getByRole("dialog", { name: "搜索任务" })),
      );
      fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
      fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
      await waitFor(() =>
        assert.equal(
          screen.getByRole("textbox", { name: "任务消息" }).value,
          "新任务未提交草稿",
        ),
      );
      const callsBeforeIME = providerCalls;
      fireEvent.keyDown(screen.getByRole("textbox", { name: "任务消息" }), {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
      });
      assert.equal(providerCalls, callsBeforeIME);
      fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
      assert.ok(screen.getByRole("dialog", { name: "新建项目" }));
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      const projectSource=join(home,"managed-project"),projectTarget=join(home,"moved-project");await mkdir(projectSource);await mkdir(projectTarget);await writeFile(join(projectSource,"keep.md"),"实际项目文件");
      const managed=await work.mutateStore("project.create",{title:"界面目录维护",directory:projectSource});await waitFor(()=>assert.ok(screen.getByRole("button",{name:"编辑项目 界面目录维护"})));
      fireEvent.click(screen.getByRole("button",{name:"编辑项目 界面目录维护"}));fireEvent.change(screen.getByRole("textbox",{name:"项目名称"}),{target:{value:"已修改的项目名称"}});fireEvent.click(screen.getByRole("button",{name:"保存项目"}));await waitFor(()=>assert.ok(!screen.queryByRole("dialog",{name:"编辑项目"})));
      assert.equal((await host.handle("foundation.snapshot",{})).projects.find(project=>project.id===managed.project.id).title,"已修改的项目名称");
      fireEvent.click(screen.getByRole("button",{name:"编辑项目 已修改的项目名称"}));window.dcode.chooseDirectory=async()=>projectTarget;fireEvent.click(screen.getByRole("button",{name:"项目文件夹"}));await waitFor(()=>assert.ok(screen.getByRole("checkbox",{name:"同时移动项目文件"})));fireEvent.click(screen.getByRole("checkbox",{name:"同时移动项目文件"}));fireEvent.click(screen.getByRole("button",{name:"保存项目"}));await waitFor(()=>assert.ok(!screen.queryByRole("dialog",{name:"编辑项目"})),{timeout:10000});
      assert.equal((await host.handle("foundation.snapshot",{})).projects.find(project=>project.id===managed.project.id).directory,await realpath(projectTarget));assert.equal(await readFile(join(projectTarget,"keep.md"),"utf8"),"实际项目文件");assert.deepEqual(await readdir(projectSource),[]);window.dcode.chooseDirectory=async()=>null;
      fireEvent.click(screen.getByRole("button", { name: "设置" }));
      await waitFor(() =>
        assert.ok(screen.getByRole("navigation", { name: "设置分类" })),
      );
      for (const label of [
        "模型",
        "自定义供应商",
        "本机资源",
        "智能体档案",
        "外观",
        "工作台",
        "已归档任务",
        "自进化",
        "通知",
        "Host 诊断",
        "关于 D Code",
      ])
        assert.ok(screen.getByRole("button", { name: label, exact: true }));
      fireEvent.click(
        screen.getByRole("button", { name: "外观", exact: true }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "深色", exact: true }),
      );
      await waitFor(async () =>
        assert.equal(
          (await host.handle("clientPreferences.get", {})).appearance,
          "dark",
        ),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "工作台", exact: true }),
      );
      fireEvent.change(screen.getByRole("slider", { name: "导航区宽度" }), {
        target: { value: 300 },
      });
      await waitFor(async () =>
        assert.equal(
          (await host.handle("clientPreferences.get", {})).sidebarWidth,
          300,
        ),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "智能体档案", exact: true }),
      );
      const profileCheckbox = screen.getAllByRole("checkbox")[0];
      fireEvent.click(profileCheckbox);
      await waitFor(async () =>
        assert.equal(
          (await host.handle("foundation.snapshot", {})).agentProfiles[0]
            .enabled,
          false,
        ),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "关于 D Code", exact: true }),
      );
      assert.ok(screen.getByRole("button", { name: "打开项目 GitHub" }));
      fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
      assert.ok(screen.getByRole("button", { name: "新建任务" }));
      cleanup();
      const restoreSnapshot = await host.handle("foundation.snapshot", {});
      await host.handle("taskWorkbenchViewState.patch", {
        requestId: "restore-selected-for-readiness",
        expectedStoreRevision: restoreSnapshot.storeRevision,
        expectedViewStateRevision:
          restoreSnapshot.taskWorkbenchViewState.revision,
        patch: { selection: { taskId: taskA.id, sessionId: sessionA } },
      });
      const realRequest = window.dcode.request;
      let readyCount = 0,
        failedCount = 0,
        releasePresentation;
      window.dcode.signalReady = async () => {
        readyCount++;
      };
      window.dcode.signalRestoreFailed = async () => {
        failedCount++;
      };
      window.dcode.request = async (method, params) =>
        method === "dcodeSession.presentation"
          ? await new Promise((resolve) => {
              releasePresentation = resolve;
            })
          : realRequest(method, params);
      mount();
      await waitFor(() => assert.equal(work.session?.id, sessionA));
      assert.equal(
        readyCount,
        0,
        "Snapshot alone must not confirm restored transcript",
      );
      await act(async () => {
        releasePresentation(
          await realRequest("dcodeSession.presentation", {
            dcodeSessionId: sessionA,
          }),
        );
      });
      await waitFor(() => assert.equal(readyCount, 1));
      cleanup();
      readyCount = 0;
      window.dcode.request = async (method, params) => {
        if (method === "dcodeSession.presentation")
          throw new Error("Unreadable adapter fixture");
        return realRequest(method, params);
      };
      mount();
      await waitFor(() => assert.equal(failedCount, 1));
      assert.equal(
        readyCount,
        0,
        "Failed presentation must not send a ready marker",
      );
      window.dcode.request = realRequest;
    } finally {
      cleanup();
      listeners.clear();
      await host.close();
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  },
);
