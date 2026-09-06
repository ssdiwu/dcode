import { ChevronRight, LoaderCircle } from "lucide-react";
import { Markdown } from "../Markdown";
import { processPreview, type ExecutionTurn } from "../../workbench/execution-process";

export function ExecutionProcess({turn}:{turn:ExecutionTurn}) {
  if (!turn.hasResponse) return null;
  const label = turn.status === "running" ? "正在执行" : turn.status === "error" ? "执行失败" : turn.status === "aborted" ? "已停止" : "执行完成";
  const preview = processPreview(turn);
  return <details className="execution-process">
    <summary aria-label={`${label}，展开执行过程`}>
      {turn.running ? <LoaderCircle size={13} className="spinner"/> : <ChevronRight size={13} className="execution-chevron"/>}
      <span className="execution-label">{label}</span>
      {preview && <span className="execution-preview">{preview}</span>}
    </summary>
    <div className="execution-steps">
      {turn.steps.length ? turn.steps.map(step=><section className={`execution-step ${step.kind}`} key={step.id}>
        <div className="execution-step-label">{step.state === "running" && <LoaderCircle size={12} className="spinner"/>}{step.title}{step.state && <span>{step.state === "running" ? "进行中" : step.state === "error" ? "失败" : "已完成"}</span>}</div>
        {step.kind === "tool" ? <><pre>{step.text || "无需输入参数"}</pre>{step.output && <pre className="tool-output">{step.output}</pre>}</> : step.kind === "image" ? <img className="message-image" src={`data:${step.mimeType};base64,${step.text}`} alt="工具输出图片"/> : <Markdown text={step.text}/>}
      </section>) : <p className="execution-empty">{turn.running ? "正在等待模型返回内容…" : "本次回复没有可展示的思考或工具记录。"}</p>}
    </div>
  </details>;
}
