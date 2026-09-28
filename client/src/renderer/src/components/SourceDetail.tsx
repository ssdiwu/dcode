import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, errorText } from "../types";
import type { TaskSourceReadResult, TaskSourceSelector } from "../../../../../host/src/product-store.js";

const unavailable = (reason: TaskSourceReadResult["unavailableReason"]): string => ({
  missing: "来源文件已不存在。",
  symbolic_link: "来源已变成链接，不能安全读取。",
  not_regular_file: "来源不再是普通文件。",
  too_large: "当前文件超过安全读取上限。",
  source_root_unavailable: "来源目录当前不可读取。",
  runtime_cwd_unavailable: "原运行目录当前不可读取。",
  outside_source_root: "来源已离开原登记目录。",
  outside_runtime_cwd: "来源已离开原运行目录。",
  changed_during_read: "读取时文件发生变化，请重试。",
  unreadable: "来源文件当前不可读取。",
  credential_material: "来源含有敏感内容，未展示正文。",
  invalid_utf8: "来源不是可显示的 UTF-8 文本。",
  snapshot_identity_mismatch: "灵感版本标识与保存的摘要不一致。",
})[reason ?? "unreadable"];

export function SourceContent({ selector }: { selector: TaskSourceSelector }) {
  const [result, setResult] = useState<TaskSourceReadResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setResult(null); setError("");
    void api().request<TaskSourceReadResult>("task.source.read", selector)
      .then(value => { if (alive) setResult(value); })
      .catch(reason => { if (alive) setError(errorText(reason)); });
    return () => { alive = false; };
  }, [selector]);
  return <div className="source-content" aria-busy={!result&&!error}>
      {error ? <p role="alert">{error}</p> : !result ? <p role="status">正在核对来源版本…</p> : <>
        <h3>{result.title}</h3>
        {result.version&&<p>第 {result.version} 版{result.currentVersion&&result.currentVersion>result.version?` · 当前节点已到第 ${result.currentVersion} 版`:""}</p>}
        {result.state==="current_match"&&result.content!==undefined
          ? <><p role="status">{"contextSourceId" in selector?"已核对到任务选定版本的内容。":"已核对到本次运行当时使用的内容。"}</p><pre className="source-detail-text">{result.content}</pre></>
          : <p role="status">{result.state==="hash_mismatch"?"当前文件已变化；当时正文没有保存在回执中，不能显示为原版本。":`当时正文当前不可恢复。${unavailable(result.unavailableReason)}`}</p>}
        <details><summary>来源核对信息</summary><p className="source-path">{result.path}</p><p className="source-path">SHA-256：{result.digest}</p></details>
      </>}
  </div>;
}

export function SourceDetail({ selector, onClose }: { selector: TaskSourceSelector; onClose: () => void }) {
  return <aside className="inspector source-detail" aria-label="来源详情">
    <div className="panel-heading"><strong>来源原文</strong><button type="button" className="icon-button" aria-label="关闭来源详情" onClick={onClose}><X size={15}/></button></div>
    <div className="inspector-content"><SourceContent selector={selector}/></div>
  </aside>;
}
