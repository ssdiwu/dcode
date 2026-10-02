import { uiText, localizeUi } from "../../../../shared/ui-language.ts";
import { useEffect, useRef, useState } from "react";
import { api, errorText, type TaskSummaryRecord, type TaskSummarySourceRef } from "../../types";
import type { Workbench } from "../../useWorkbench";

const names = localizeUi({ confirmed: "已确认", pending: "未完成", blocked: "阻塞与待核对", next: "下一步" } as const);
type Section = keyof typeof names;
const sections = Object.keys(names) as Section[];
const sourceLabel = (source: TaskSummarySourceRef) => source.kind === "summary_revision" ? uiText("上版摘要") : source.kind === "user_correction" ? uiText("本次修订") : uiText("查看来源");
type Editor = Record<Section, string>;
const editor = (summary: TaskSummaryRecord): Editor => Object.fromEntries(
  sections.map(key => [key, summary.sections[key].map(claim => claim.text).join("\n")]),
) as Editor;

export function TaskSummary({ work, onSourceOpen }: { work: Workbench; onSourceOpen?: () => void }) {
  const taskId = work.task?.id;
  const latestSummary = work.snapshot?.taskSummaries.find(item => item.taskId === taskId);
  const adoptedReceipt = work.snapshot?.promptReceipts.filter(item => item.taskId === taskId && item.sessionId === work.session?.id && item.taskSummary).at(-1)?.taskSummary;
  const [adoptedRecord, setAdoptedRecord] = useState<TaskSummaryRecord | null>(null);
  const [adoptedResolved, setAdoptedResolved] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const needsOlderVersion = !!adoptedReceipt && (adoptedReceipt.revision !== latestSummary?.revision || adoptedReceipt.digest !== latestSummary?.digest);
  const summary = showLatest || !adoptedReceipt ? latestSummary : needsOlderVersion ? adoptedRecord ?? undefined : latestSummary;
  const failure = work.snapshot?.taskSummaryFailures.find(item => item.taskId === taskId && item.sessionId === work.session?.id);
  const continued = work.snapshot?.sessionProvenance.some(item => item.sessionId === work.session?.id && typeof item.details === "object" && item.details !== null && "continuedFromSessionId" in item.details);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Editor | null>(null);
  const [history, setHistory] = useState<TaskSummaryRecord[] | null>(null);
  const [historySelected, setHistorySelected] = useState<TaskSummaryRecord | null>(null);
  const [source, setSource] = useState<{ title: string; state: string; content?: string } | null>(null);
  const [sourceLoading,setSourceLoading]=useState(false);
  const sourceRequest=useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAdoptedRecord(null); setAdoptedResolved(false); setShowLatest(false); }, [taskId,work.session?.id]);
  useEffect(() => {
    let alive = true; setAdoptedRecord(null); setAdoptedResolved(false);
    if (taskId && adoptedReceipt && (adoptedReceipt.revision !== latestSummary?.revision || adoptedReceipt.digest !== latestSummary?.digest)) {
      void api().request<TaskSummaryRecord[]>("task.summary.history", { taskId }).then(items => {
        if (alive) { setAdoptedRecord(items.find(item => item.revision === adoptedReceipt.revision && item.digest === adoptedReceipt.digest) ?? null); setAdoptedResolved(true); }
      }).catch(reason => { if (alive) { setError(errorText(reason)); setAdoptedResolved(true); } });
    }
    return () => { alive = false; };
  }, [taskId,work.session?.id,adoptedReceipt?.revision,adoptedReceipt?.digest,latestSummary?.revision,latestSummary?.digest]);
  useEffect(() => { if (!editing) setDraft(summary ? editor(summary) : null); }, [summary?.revision, editing]);
  if (taskId && adoptedReceipt && needsOlderVersion && !showLatest && !summary) return <section className="task-summary" role="status"><strong>{adoptedResolved?uiText("本对话采用的第 {0} 版摘要正文暂不可恢复", [adoptedReceipt.revision]):uiText("正在读取本对话实际采用的摘要…")}</strong>{adoptedResolved&&<p>{uiText("采用版本的身份仍保留在运行回执中；不会以任务最新版冒充当时正文。")}</p>}{error&&<p role="alert">{error}</p>}{adoptedResolved&&latestSummary&&<button className="text-button" onClick={()=>setShowLatest(true)}>{uiText("查看任务当前版本")}</button>}</section>;
  if (!taskId || !summary) return continued || failure ? <section className="task-summary" role="status"><strong>{uiText("任务工作摘要暂不可用")}</strong><p>{uiText("这段对话仍可依据原始消息和资料继续；本轮是否采用摘要可在“上下文与运行依据”查看。")}</p>{failure&&<p className="secondary">{uiText("最近一次准备失败：")}{failure.reasonCode === "INPUT_LIMIT" ? uiText("本轮输入已满") : uiText("生成未完成")}。</p>}</section> : null;
  const openSource = async (ref: TaskSummarySourceRef) => {
    const request=++sourceRequest.current;
    onSourceOpen?.();
    setError(null);setSource(null);setSourceLoading(true);
    try {
      const result=await api().request<{ title:string;state:string;content?:string }>("task.summary.source", { taskId, source: ref });
      if(request===sourceRequest.current)setSource(result);
    } catch (reason) { if(request===sourceRequest.current)setError(errorText(reason)); }
    finally{if(request===sourceRequest.current)setSourceLoading(false);}
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      const content = Object.fromEntries(sections.map(key => [key, draft[key].split("\n").map(line => line.trim()).filter(Boolean)]));
      await work.mutateStore("task.summary.correct", { taskId, expectedRevision: summary.revision, sections: content });
      await work.reload();
      setEditing(false);
      setHistory(null);
      setHistorySelected(null);
      setShowLatest(true);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <section className="task-summary" aria-label={uiText("任务工作摘要")}>
    <div className="task-summary-heading"><strong>{adoptedReceipt&&!showLatest?uiText("本对话已采用的任务摘要"):uiText("任务当前摘要")} {uiText(" · 第 ")}{summary.revision} {uiText(" 版")}</strong><span>{new Date(summary.createdAt).toLocaleString("zh-CN")}</span></div>
    {adoptedReceipt&&latestSummary&&needsOlderVersion&&<p className="secondary">{adoptedReceipt.revision!==latestSummary.revision?uiText("任务当前摘要是第 {0} 版；本对话运行时采用第 {1} 版。", [latestSummary.revision, adoptedReceipt.revision]):uiText("任务当前摘要与本对话回执的内容身份不同，不能当作当时采用版本。")}<button className="text-button" onClick={()=>{setEditing(false);setShowLatest(value=>!value);}}>{showLatest?uiText("返回本对话采用版本"):uiText("查看任务当前版本")}</button></p>}
    {!adoptedReceipt&&<p className="secondary">{uiText("这段对话尚未在运行中采用摘要；下次续接会记录实际采用版本。")}</p>}
    {!summary.current && <p className="task-summary-stale" role="status">{uiText("任务事实已有变化，这版摘要需要重新核对。运行时会重新生成，旧版仍可回查。")}</p>}
    {failure && failure.createdAt > summary.createdAt && <p className="task-summary-stale" role="status">{uiText("最近一次续接未采用摘要；原始材料仍保留，请查看运行依据。")}</p>}
    {editing && draft ? <div className="task-summary-editor">
      {sections.map(key => <label key={key}>{names[key]}<textarea value={draft[key]} rows={Math.max(2, Math.min(5, draft[key].split("\n").length + 1))} onChange={event => setDraft(current => current ? { ...current, [key]: event.target.value } : current)} placeholder={uiText("每行一条，可留空")} /></label>)}
      <div className="task-summary-actions"><button className="text-button" disabled={busy} onClick={() => void save()}>{uiText("保存修订")}</button><button className="text-button" onClick={() => { setEditing(false); setError(null); }}>{uiText("取消")}</button></div>
    </div> : <div className="task-summary-sections">
      {sections.map(key => <div key={key}><strong>{names[key]}</strong>{summary.sections[key].length ? <ul>{summary.sections[key].map((claim, index) => <li key={`${key}-${index}`}><span>{claim.text}</span>{claim.sources.map((ref, sourceIndex) => <button key={sourceIndex} type="button" className="text-button" onClick={() => void openSource(ref)}>{sourceLabel(ref)}</button>)}</li>)}</ul> : <p>{uiText("暂无记录")}</p>}</div>)}
    </div>}
    <div className="task-summary-actions">
      {!editing && summary.current && summary.revision===latestSummary?.revision && <button className="text-button" onClick={() => { setDraft(editor(summary)); setEditing(true); }}>{uiText("纠正摘要")}</button>}
      <button className="text-button" onClick={() => void api().request<TaskSummaryRecord[]>("task.summary.history", { taskId }).then(setHistory).catch(reason => setError(errorText(reason)))}>{uiText("历史版本")}</button>
    </div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {sourceLoading&&<p role="status" className="secondary">{uiText("正在核对来源…")}</p>}
    {source && <div className="task-summary-source" role="region" aria-label={uiText("摘要来源：{0}", [source.title])}><div><strong>{source.title}</strong><button className="text-button" onClick={() => setSource(null)}>{uiText("关闭")}</button></div>{source.state === "available" ? <pre>{source.content}</pre> : <p>{uiText("当时的正文已不可恢复；来源身份仍保留。")}</p>}</div>}
    {history && <div className="task-summary-history" role="region" aria-label={uiText("摘要历史版本")}><div><strong>{uiText("修订记录")}</strong><button className="text-button" onClick={() => {setHistory(null);setHistorySelected(null);}}>{uiText("关闭")}</button></div><ol>{history.map(item => <li key={item.revision}>{uiText("第 ")}{item.revision} {uiText(" 版 · ")}{item.trigger === "user_correction" ? uiText("用户修订") : uiText("自动整理")} · {new Date(item.createdAt).toLocaleString("zh-CN")}{item.revision !== summary.revision && <button className="text-button" onClick={() => setHistorySelected(item)}>{uiText("查看")}</button>}</li>)}</ol>{historySelected&&<div className="task-summary-history-detail" role="region" aria-label={uiText("任务摘要第 {0} 版", [historySelected.revision])}><div><strong>{uiText("第 ")}{historySelected.revision} {uiText(" 版的声明与来源")}</strong><button className="text-button" onClick={()=>setHistorySelected(null)}>{uiText("收起")}</button></div>{sections.map(key=><section key={key}><strong>{names[key]}</strong><ul>{historySelected.sections[key].map((claim,index)=><li key={index}><span>{claim.text}</span>{claim.sources.map((ref,refIndex)=><button className="text-button" key={refIndex} onClick={()=>void openSource(ref)}>{sourceLabel(ref)}</button>)}</li>)}</ul></section>)}</div>}</div>}
  </section>;
}
