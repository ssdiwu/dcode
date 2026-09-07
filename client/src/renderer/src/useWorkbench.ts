import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  api,
  fetchSnapshot,
  errorText,
  type DCodeSessionPresentation,
  type TaskBundle,
  type TaskRecord,
  type TaskWorkbenchViewStatePatch,
  type PromptImageInput,
  type TaskScope,
  type ClientPreferences,
  type SessionEntryRecord,
  type ManagedAttachment,
  type AttachmentSource,
  type NativeSessionPathAction,
  type ComposerDraftRecord,
} from "./types";
import {
  emptyStream,
  mutationQueue,
  reduceStream,
  selectionPatch,
  type StreamState,
} from "./workbench";

export interface Draft {
  pathAction?:NativeSessionPathAction;
  pathDraftBackup?:ComposerDraftRecord["pathDraftBackup"];
  targetAgentRunId?:string;
  text: string;
  images: PromptImageInput[];
  attachments?: ManagedAttachment[];
}
const blankDraft = (): Draft => ({ text: "", images: [], attachments:[] });
export function useWorkbench() {
  const {
    data: snapshot,
    error: loadError,
    mutate: reload,
  } = useSWR("foundation", fetchSnapshot, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const [selection, setSelection] = useState<{
    taskId: string | null;
    sessionId: string | null;
  } | null>(null);
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>(
    {},
  );
  const pendingAttachments = useRef(new Set<Promise<void>>());
  const quitFlushers = useRef(new Set<()=>Promise<void>>());
  const registerQuitFlush=useCallback((flush:()=>Promise<void>)=>{quitFlushers.current.add(flush);return ()=>{quitFlushers.current.delete(flush);};},[]);
  const pendingReadings = useRef(new Map<string, number>());
  const latestReadings = useRef(new Map<string, number>());
  const readingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [runtimeNotices,setRuntimeNotices]=useState<Record<string,string>>({});
  const [hostDead, setHostDead] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [selectedPaths,setSelectedPaths]=useState<Record<string,string|undefined>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftRef = useRef(drafts);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const saving = useRef(
    new Map<string, { taskId?: string; scope?: TaskScope; text: string; attachmentIds?:string[];targetAgentRunId?:string|null;pathAction?:NativeSessionPathAction|null;pathDraftBackup?:ComposerDraftRecord["pathDraftBackup"]|null }>(),
  );
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const mutateStore = useMemo(() => mutationQueue(api()), []);
  const current = selection ??
    snapshot?.taskWorkbenchViewState.selection ?? {
      taskId: null,
      sessionId: null,
    };
  const currentRef = useRef(current);
  currentRef.current = current;
  const task = snapshot?.tasks.find((t) => t.id === current.taskId) ?? null;
  const session =
    snapshot?.sessions.find(
      (s) => s.id === current.sessionId && s.taskId === task?.id,
    ) ?? null;
  const draftKey = session?.id ?? `new:${newProjectId ?? "user"}`;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const savedDraft = snapshot?.composerDrafts.find((d) =>
    session
      ? d.sessionId === session.id && d.draftKind === "session_path"
      : d.draftKind === "new_task" &&
        (newProjectId
          ? d.scope?.kind === "project" && d.scope.projectId === newProjectId
          : d.scope?.kind === "user"),
  );
  const draft = drafts[draftKey] ?? {
    text: savedDraft?.text ?? "",
    images: [],
    attachments:savedDraft?.attachments??[],
    targetAgentRunId:savedDraft?.targetAgentRunId,
    pathAction:savedDraft?.pathAction,pathDraftBackup:savedDraft?.pathDraftBackup,
  };
  const { data: preferences, mutate: reloadPreferences } = useSWR(
    "clientPreferences",
    () => api().request<ClientPreferences>("clientPreferences.get"),
    { revalidateOnFocus: false },
  );
  const { data: imported, error: importedError } = useSWR(
    session?.lineageStatus === "unknown"
      ? ["importedEntries", session.id]
      : null,
    ([, id]) =>
      api().request<{ entries: SessionEntryRecord[] }>(
        "session.importedEntries",
        { sessionId: id },
      ),
    { revalidateOnFocus: false },
  );
  const {
    data: presented,
    error: presentationError,
    mutate: refreshPresentation,
  } = useSWR(
    session ? ["presentation", session.id,selectedPaths[session.id]] : null,
    ([, id,pathId]) =>
      api().request<DCodeSessionPresentation>("dcodeSession.presentation", {
        dcodeSessionId: id,
        ...(pathId?{pathId}:{}),
      }),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      keepPreviousData: false,
    },
  );
  const presentation =
    presented?.dcodeSession.id === session?.id ? presented : undefined;
  const signalledReady = useRef(false);
  useEffect(() => {
    if (!snapshot || signalledReady.current) return;
    const invalid =
      !!presentationError ||
      !!importedError ||
      presentation?.adapterState === "unavailable";
    if (invalid) {
      signalledReady.current = true;
      void api()
        .signalRestoreFailed()
        .catch((error) => setError(errorText(error)));
      return;
    }
    if (
      session &&
      (!presentation || (session.lineageStatus === "unknown" && !imported))
    )
      return;
    signalledReady.current = true;
    void api()
      .signalReady(current)
      .catch((error) => setError(errorText(error)));
  }, [
    snapshot,
    session,
    presentation,
    presentationError,
    imported,
    importedError,
    current,
  ]);
  const adapterId =
    presentation?.binding?.adapterSessionId ??
    snapshot?.sessionRuntimeBindings.find((b) => b.sessionId === session?.id)
      ?.adapterSessionId;
  const viewingHistory=!!presentation?.selectedNativePathId&&presentation.nativePaths?.find(path=>path.isCurrent)?.id!==presentation.selectedNativePathId;
  const stream = adapterId&&!viewingHistory
    ? (streams[adapterId] ?? emptyStream(adapterId))
    : emptyStream();
  const runs =
    snapshot?.sessionRuns.filter((r) => r.sessionId === session?.id) ?? [];
  const run = runs.at(-1);
  const running = !hostDead && (run?.status === "running" || stream.active);
  const fail = useCallback((e: unknown) => setError(errorText(e)), []);

  const patchView = useCallback(
    async (patch: TaskWorkbenchViewStatePatch) => {
      await mutateStore("taskWorkbenchViewState.patch", { patch });
      await reload();
    },
    [mutateStore, reload],
  );
  const select = useCallback(
    (t: TaskRecord | null, sessionId?: string) => {
      const id =
        sessionId ??
        snapshotRef.current?.sessions.find(
          (s) => s.taskId === t?.id && s.kind === "coordination",
        )?.id ??
        null;
      const next = { taskId: t?.id ?? null, sessionId: id };
      setSelection(next);
      setError(null);
      void patchView(selectionPatch(next.taskId, next.sessionId)).catch(fail);
    },
    [patchView, fail],
  );
  const newTask = useCallback(() => select(null), [select]);

  const flushDrafts = useCallback(async () => {
    const entries = [...saving.current.entries()];
    await Promise.all(
      entries.map(async ([id, value]) => {
        if (value.scope)
          await mutateStore("taskDraft.set", {
            scope: value.scope,
            text: value.text,
            attachmentIds:value.attachmentIds,
          });
        else
          await mutateStore("dcodeSession.composerDraft.set", {
            taskId: value.taskId,
            dcodeSessionId: id,
            targetAgentRunId:value.targetAgentRunId??null,
            pathAction:value.pathAction??null,pathDraftBackup:value.pathDraftBackup??null,
            text: value.text,
            attachmentIds:value.attachmentIds,
          });
        if (saving.current.get(id) === value) saving.current.delete(id);
      }),
    );
    await Promise.all(
      [...pendingReadings.current].map(async ([sessionId, offset]) => {
        await mutateStore("clientPreferences.set", {
          readingPosition: { sessionId, offset },
        });
        if (pendingReadings.current.get(sessionId) === offset)
          pendingReadings.current.delete(sessionId);
      }),
    );
  }, [mutateStore]);
  const saveReading = useCallback(
    (sessionId: string, offset: number) => {
      pendingReadings.current.set(sessionId, offset);
      latestReadings.current.set(sessionId, offset);
      clearTimeout(readingTimer.current);
      readingTimer.current = setTimeout(
        () => void flushDrafts().catch(fail),
        250,
      );
    },
    [flushDrafts, fail],
  );
  useEffect(() => () => clearTimeout(readingTimer.current), []);
  const updateDraft = useCallback((key: string, update: Draft | ((previous: Draft) => Draft)) => {
    const saved = snapshotRef.current?.composerDrafts.find(draft => key.startsWith("new:") ? draft.draftKind === "new_task" && (key === "new:user" ? draft.scope?.kind === "user" : draft.scope?.kind === "project" && draft.scope.projectId === key.slice(4)) : draft.sessionId === key);
    const previous = draftRef.current[key] ?? {text:saved?.text ?? "",images:[],attachments:saved?.attachments??[],targetAgentRunId:saved?.targetAgentRunId,pathAction:saved?.pathAction,pathDraftBackup:saved?.pathDraftBackup};
    const value = typeof update === "function" ? update(previous) : update;
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDrafts(next);
    const owner = snapshotRef.current?.sessions.find((s) => s.id === key);
    if (owner)
      saving.current.set(key, { taskId: owner.taskId, text: value.text, targetAgentRunId:value.targetAgentRunId??null,pathAction:value.pathAction??null,pathDraftBackup:value.pathDraftBackup??null, attachmentIds:value.attachments?.map(item=>item.id)??[] });
    else if (key.startsWith("new:") && snapshotRef.current)
      saving.current.set(key, {
        scope:
          key === "new:user"
            ? { kind: "user", userId: snapshotRef.current.currentUser.id }
            : { kind: "project", projectId: key.slice(4) },
        text: value.text,
        attachmentIds:value.attachments?.map(item=>item.id)??[],
      });
  }, []);
  useEffect(() => {
    if (saving.current.size === 0) return;
    const timer = setTimeout(() => {
      void flushDrafts().catch(fail);
    }, 350);
    return () => clearTimeout(timer);
  }, [drafts, flushDrafts, fail]);

  useEffect(() => {
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let presentationTimer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const scheduleSnapshot = () => {
      if (snapshotTimer) return;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        void reload();
      }, 100);
    };
    const schedulePresentation = () => {
      if (presentationTimer) return;
      presentationTimer = setTimeout(() => {
        presentationTimer = undefined;
        void refreshPresentation();
      }, 150);
    };
    const off = api().subscribe((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.event === "host.exit") {
        setHostDead(true);
        setStreams({});
      }
      if (event.event === "shell.newTask") newTask();
      if (event.event === "shell.quitCancelled") setClosing(false);
      if (event.event === "shell.quitRequested") {
        setClosing(true);
        void Promise.all([...pendingAttachments.current]).then(()=>flushDrafts()).then(()=>Promise.all([...quitFlushers.current].map(flush=>flush())))
          .then(() => {
            const hasImages = Object.values(draftRef.current).some(
              (d) => d.images.length > 0,
            );
            api().readyToQuit(
              hasImages
                ? "文字草稿已保存。还有旧格式图片未暂存，退出后需要重新添加。"
                : undefined,
            );
          })
          .catch((error) => api().readyToQuit(errorText(error)));
      }
      if (
        event.event === "session.promptFailed" ||
        event.event === "session.persistenceError"
      ) {
        const runtime = data.runtime as { dcodeSessionId?: string } | undefined;
        const sessionId = runtime?.dcodeSessionId;
        const message = String(
          data.message ?? "本次执行未能完成，请查看运行记录后重试。",
        );
        if (sessionId)
          setSessionErrors((previous) => ({
            ...previous,
            [sessionId]: message,
          }));
        else fail(message);
        scheduleSnapshot();
        schedulePresentation();
      }
      if (
        event.event === "session.durableRunFinished" ||
        event.event === "session.runStateChanged"
      ) {
        scheduleSnapshot();
        schedulePresentation();
      }
      if(event.event==="extension.notification"){const owner=(data.runtime as {dcodeSessionId?:string})?.dcodeSessionId;if(owner)setRuntimeNotices(previous=>({...previous,[owner]:String(data.message??"")}));}
      if(["extension.request","extension.closed"].includes(event.event)){scheduleSnapshot();schedulePresentation();}
      if(event.event==="extension.unsupported")fail("这个扩展需要终端界面，D Code 已阻止该交互。");
      if(event.event==="extension.error")fail(String(data.error??"扩展未能完成当前操作"));
      if (event.event === "foundation.changed") {
        scheduleSnapshot();
        if (String(data.kind).startsWith("clientPreferences.") || String(data.kind).includes("model")) void reloadPreferences();
        if (
          ![
            "taskWorkbenchViewState.updated",
            "clientPreferences.updated",
            "taskDraft.updated",
          ].includes(String(data.kind)) &&
          !String(data.kind).startsWith("dcodeSession.composerDraft")
        )
          schedulePresentation();
      }
      if (event.event !== "session.event" || typeof data.sessionId !== "string")
        return;
      const id = data.sessionId;
      setStreams((previous) => ({
        ...previous,
        [id]: reduceStream(previous[id] ?? emptyStream(id), event, id),
      }));
      const runtime = data.runtime as { dcodeSessionId?: string } | undefined;
      const selectedAdapter =
        runtime?.dcodeSessionId === currentRef.current.sessionId
          ? id
          : snapshotRef.current?.sessionRuntimeBindings.find(
              (b) => b.sessionId === currentRef.current.sessionId,
            )?.adapterSessionId;
      if (
        selectedAdapter === id &&
        (data.type === "message_end" ||
          data.type === "agent_end" ||
          data.type === "tool_execution_end")
      )
        schedulePresentation();
      if (data.type === "agent_end") {
        scheduleSnapshot();
        // Do not discard completed text on a timer. The durable read is the handoff.
        if (selectedAdapter === id)
          void refreshPresentation()
            .then(() => {
              if (alive)
                setStreams((previous) => ({
                  ...previous,
                  [id]: emptyStream(id),
                }));
            })
            .catch(fail);
      }
    });
    return () => {
      alive = false;
      off();
      clearTimeout(snapshotTimer);
      clearTimeout(presentationTimer);
    };
  }, [
    reload,
    reloadPreferences,
    refreshPresentation,
    newTask,
    flushDrafts,
    fail,
  ]);

  const restoredPathDraft=(value:Draft):Draft=>value.pathDraftBackup?{text:value.pathDraftBackup.text,images:[],targetAgentRunId:value.pathDraftBackup.targetAgentRunId,attachments:value.pathDraftBackup.attachments??[]}:blankDraft();
  const startPath=(kind:NativeSessionPathAction["kind"],entryId:string,text="")=>{
    if(!session||!presentation||running)return;
    if(snapshot?.collaborationMessages?.some(message=>message.targetSessionId===session.id&&["queued","paused","delivering"].includes(message.state))){fail("当前对话还有待发送消息或协作更新，请先在对话下方处理后，再从历史继续。");return;}
    const current=presentation.nativePaths?.find(path=>path.isCurrent);const fromPathId=presentation.selectedNativePathId;
    if(!current||!fromPathId)return;
    const nativeEntry=presentation.nativeEntries?.find(entry=>entry.sourceEntryId===entryId);
    if(!nativeEntry){fail("这条消息尚未完成来源核对，请等待运行收尾后重试。");return;}
    const pathAction={kind,entryId,fromPathId,expectedCurrentPathId:current.id,expectedCurrentPathRevision:current.revision};
    const original=nativeEntry.content as {text?:string;attachmentRefs?:ManagedAttachment[]};
    const attachments=kind==="editUser"?(original.attachmentRefs??[]).filter(item=>typeof item?.id==="string"&&item.id.startsWith("attachment-")):[];
    updateDraft(draftKey,{text:kind==="editUser"?original.text??text:text,images:[],attachments,pathAction,pathDraftBackup:draft.pathDraftBackup??{text:draft.text,attachmentIds:draft.attachments?.map(item=>item.id)??[],attachments:draft.attachments??[],targetAgentRunId:draft.targetAgentRunId}});
    document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus();
  };
  const send = async (targetAgentRunId?: string,deliveryMode?:"steer") => {
    if (
      !snapshot ||
      (!draft.text.trim() && !draft.attachments?.length) ||
      hostDead ||
      inFlight.current.has(draftKey)
    )
      return;
    const sourceKey = draftKey;
    const submitted = draft;
    targetAgentRunId ??= submitted.targetAgentRunId;
    if(viewingHistory&&!submitted.pathAction){fail("正在查看历史路径，请选择一条消息的“从这里继续”。输入内容已保留。");return;}
    const message = submitted.text;

    inFlight.current.add(sourceKey);
    setBusyKeys(new Set(inFlight.current));
    setError(null);
    if (session)
      setSessionErrors((previous) => {
        const next = { ...previous };
        delete next[session.id];
        return next;
      });
    let targetId = session?.id;
    let targetTaskId = task?.id;
    try {
      if (!targetId) {
        const scope = newProjectId
          ? { kind: "project", projectId: newProjectId }
          : { kind: "user", userId: snapshot.currentUser.id };
        const created = await mutateStore<TaskBundle>("task.create", {
          scope,
          title: (submitted.text.trim() || submitted.attachments?.[0]?.name || "新任务").split("\n")[0].slice(0, 60),
          goal: (message.trim() || `查看附件：${submitted.attachments?.map(item=>item.name).join("、")}`).slice(0, 4000),
          acceptance: [],
        });
        targetId = created.coordinationSession.id;
        targetTaskId = created.task.id;
        inFlight.current.add(targetId);
        setBusyKeys(new Set(inFlight.current));
        updateDraft(targetId, submitted);
        // A failed provider must leave one recoverable Task, never create a duplicate on retry.
        await mutateStore("dcodeSession.composerDraft.set", {
          taskId: created.task.id,
          dcodeSessionId: targetId,
          text: submitted.text,
          attachmentIds:submitted.attachments?.map(item=>item.id)??[],
        });
        await reload();
        if (draftKeyRef.current === sourceKey) select(created.task, targetId);
      }
      await api().request("dcodeSession.prompt", {
        dcodeSessionId: targetId,
        ...(targetAgentRunId?{targetAgentRunId}:{}),
        ...(submitted.pathAction?{pathAction:submitted.pathAction}:{}),
        ...(deliveryMode?{deliveryMode,expectedSessionRunId:snapshot.sessionRuns.filter(run=>run.sessionId===(targetAgentRunId?snapshot.agentRuns.find(agent=>agent.id===targetAgentRunId)?.sessionId:targetId)).at(-1)?.id}:{}),
        message,
        attachmentIds:submitted.attachments?.map(item=>item.id)??[],
        promptId: crypto.randomUUID(),
        ...(submitted.images.length ? { images: submitted.images } : {}),
      });

      const latestSource = draftRef.current[sourceKey];
      if (!latestSource || latestSource === submitted)
        updateDraft(sourceKey, restoredPathDraft(submitted));
      const latestTarget = draftRef.current[targetId];
      if (
        sourceKey !== targetId &&
        (!latestTarget || latestTarget === submitted)
      )
        updateDraft(targetId, blankDraft());
      if (targetTaskId && !draftRef.current[targetId]?.text && !draftRef.current[targetId]?.attachments?.length)
        saving.current.set(targetId, { taskId: targetTaskId, text: "", attachmentIds:[] });
      if(submitted.pathAction)setSelectedPaths(values=>({...values,[targetId!]:undefined}));
      await flushDrafts();
      await reload();
      await refreshPresentation();
    } catch (e) {
      fail(e);
    } finally {
      inFlight.current.delete(sourceKey);
      if (targetId) inFlight.current.delete(targetId);
      setBusyKeys(new Set(inFlight.current));
    }
  };
  const addAttachment = async (owner:string,source:AttachmentSource) => {
    await flushDrafts();
    const result=await mutateStore<{attachment:ManagedAttachment}>("attachment.import",{draftKey:owner,source});
    updateDraft(owner,previous=>({...previous,attachments:[...(previous.attachments??[]).filter(item=>item.id!==result.attachment.id),result.attachment]}));
    await flushDrafts();
    await reload();
    return result.attachment;
  };
  const stop = async () => {
    const runtimeId = presentation?.runtime?.runtimeId ?? run?.runtimeId;
    if (!runtimeId) {
      fail("当前没有可停止的运行。");
      return;
    }
    try {
      await api().request("session.abort", { runtimeId });
      await reload();
      await refreshPresentation();
    } catch (e) {
      fail(e);
    }
  };
  const restart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await api().restartHost();
      setStreams({});
      await reload();
      await refreshPresentation();
      setHostDead(false);
    } catch (e) {
      fail(e);
    } finally {
      setRestarting(false);
    }
  };
  return {
    closing,
    notice:session?runtimeNotices[session.id]:undefined,
    dismissNotice:()=>{if(session)setRuntimeNotices(previous=>{const next={...previous};delete next[session.id];return next;});},
    snapshot,
    preferences,
    imported:
      presentation?.nativeEntries?.filter(entry=>entry.sourceKind!=="native")??imported?.entries.filter((entry) => entry.sourceKind !== "native") ?? [],
    loadError,
    reload,
    task,
    session,
    select,
    newTask,
    newProjectId,
    setNewProjectId,
    draft,
    startPath,viewingHistory,
    selectPath:(pathId?:string)=>{if(session)setSelectedPaths(values=>({...values,[session.id]:pathId}));},
    cancelPath:()=>updateDraft(draftKey,restoredPathDraft(draft)),
    draftKey,
    updateDraft,
    addAttachment,
    trackAttachmentImport:(operation:Promise<void>)=>{pendingAttachments.current.add(operation);void operation.then(()=>pendingAttachments.current.delete(operation),()=>pendingAttachments.current.delete(operation));},
    registerQuitFlush,
    previewAttachment:(id:string)=>api().previewAttachment(id).catch(fail),
    presentation,
    presentationError,
    refreshPresentation,
    stream,
    run,
    running,
    sending: busyKeys.has(draftKey),
    send,
    stop,
    error: error ?? sessionErrors[session?.id ?? ""] ?? null,
    setError: (value: string | null) => {
      setError(value);
      if (value === null && session)
        setSessionErrors((previous) => {
          const next = { ...previous };
          delete next[session.id];
          return next;
        });
    },
    fail,
    readingPosition: (sessionId: string) =>
      latestReadings.current.get(sessionId) ??
      preferences?.readingPositions[sessionId],
    saveReading,
    mutateStore,
    patchView,
    hostDead,
    restarting,
    restart,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
