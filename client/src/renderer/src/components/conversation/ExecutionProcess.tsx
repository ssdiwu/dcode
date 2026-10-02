import { uiText } from "../../../../shared/ui-language.ts";
import { useContext } from "react";
import { ChevronRight } from "lucide-react";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";
import { Markdown } from "../Markdown";
import { FileReferenceContext } from "../../workbench/useWorkspaceFiles";
import { processPreview, toolPresentation, type ExecutionTurn } from "../../workbench/execution-process";

export function ExecutionProcess({turn}:{turn:ExecutionTurn}) {
  const openFile = useContext(FileReferenceContext);
  if (!turn.hasResponse) return null;
  const label = turn.status === "running" ? uiText("正在执行") : turn.status === "error" ? uiText("执行失败") : turn.status === "aborted" ? uiText("已停止") : turn.status === "interrupted" ? uiText("执行已中断") : turn.status === "unknown" ? uiText("状态待核对") : uiText("执行完成");
  const preview = processPreview(turn);
  return <details className="execution-process" data-state={turn.status}>
    <summary aria-label={uiText("{0}，展开执行过程", [label])}>
      <ChevronRight size={11} className="execution-chevron"/>
      <ExecutionStatusIcon state={turn.status}/>
      <span className="execution-label">{label}</span>
      {preview && <span className="execution-preview">{preview}</span>}
    </summary>
    <div className="execution-steps">
      {turn.steps.length ? turn.steps.map(step => {
        if (step.kind === "tool") {
          const presentation = toolPresentation(step);
          return <details className="execution-tool" data-state={step.state ?? "unknown"} key={step.id}>
            <summary><ChevronRight size={11} aria-hidden="true"/><ExecutionStatusIcon state={step.state ?? "unknown"}/><span className="execution-tool-name">{presentation.summary}</span><small>{presentation.status}</small></summary>
            <div className="execution-tool-detail">
              {presentation.fileReference && openFile && <button className="text-button" type="button" onClick={() => openFile(presentation.fileReference!)}>{uiText("打开来源文件")}</button>}
              <span className="execution-tool-source">{uiText("工具调用：")}{step.toolName ?? step.title} {uiText(" · 记录 ")}{step.id}</span>
              <strong>{uiText("输入参数")}</strong><pre>{step.text || uiText("未记录输入参数")}</pre>
              <strong>{uiText("工具输出")}</strong><pre className="tool-output">{step.output || (step.state === "running" ? uiText("正在等待工具输出…") : uiText("未记录文本输出"))}</pre>
            </div>
          </details>;
        }
        return <section className={`execution-step ${step.kind}`} key={step.id}>
          <div className="execution-step-label">{step.state && <ExecutionStatusIcon state={step.state}/>}<span className="execution-step-title">{step.title}</span></div>
          {step.kind === "image" ? <img className="message-image" src={`data:${step.mimeType};base64,${step.text}`} alt={uiText("工具输出图片")}/> : <Markdown text={step.text}/>}
        </section>;
      }) : <p className="execution-empty">{turn.running ? uiText("正在等待模型返回内容…") : uiText("本次回复没有可展示的思考或工具记录。")}</p>}
    </div>
  </details>;
}
