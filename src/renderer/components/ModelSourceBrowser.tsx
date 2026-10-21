// 两级模型浏览：先选来源，再选该来源的模型。
//
// 设置页的「自动路由范围」与会话内的「本次会话用哪个模型」共用这一套浏览结构，
// 差别只在选中模型之后的动作（加入范围 / 设为本次会话的选择）。两处不各造一套浏览逻辑。
//
// 两条硬边界：
//  1. 打开、展开、搜索、查看都**不**执行工作：不同步发送、不启动执行、不读额度。
//  2. 「来源 + 模型标识」才是身份；同名模型分属不同来源时分别列出，不合并。

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import type { ModelSourcePick } from "@/contracts";
import { useT } from "../i18n";
import type { CopyKey } from "../i18n";

export interface ModelSourceBrowserProps {
  /** 来源与其模型；来自真实目录读取，不是界面自造 */
  sources: readonly ModelSourcePick[];
  /** 搜索词：命中来源名或该来源下的模型名 */
  query: string;
  onQueryChange: (value: string) => void;
  /** 当前展开的来源；null = 尚未选择来源 */
  activeSourceId: string | null;
  onActiveSourceChange: (sourceId: string) => void;
  /** 模型行的渲染：单选（会话选择）与多选（候选范围）各自实现 */
  renderModel: (source: ModelSourcePick, model: ModelSourcePick["models"][number]) => ReactNode;
  /** 没有匹配时的说明 */
  emptyText: CopyKey;
  searchPlaceholder: CopyKey;
  /** 来源行上的附加说明（如「未配置凭据」） */
  unconfiguredText: CopyKey;
}

export function ModelSourceBrowser({
  sources,
  query,
  onQueryChange,
  activeSourceId,
  onActiveSourceChange,
  renderModel,
  emptyText,
  searchPlaceholder,
  unconfiguredText,
}: ModelSourceBrowserProps) {
  const t = useT();
  const needle = query.trim().toLowerCase();
  // 搜索命中来源名或该来源下的任一模型名；命中模型的来源保留其匹配到的那些模型。
  const matched = sources
    .map((source) => {
      const sourceHit = needle === "" || source.sourceLabel.toLowerCase().includes(needle)
        || source.sourceId.toLowerCase().includes(needle);
      const models = needle === ""
        ? source.models
        : source.models.filter((model) => model.modelLabel.toLowerCase().includes(needle)
          || model.modelId.toLowerCase().includes(needle));
      return { source, models, sourceHit, visible: sourceHit || models.length > 0 };
    })
    .filter((entry) => entry.visible);
  // 有搜索词时列出所有命中的来源及其匹配模型；没有搜索词时只列来源，模型按所选来源展开。
  const listed = needle === ""
    ? matched.map((entry) => ({ source: entry.source, models: entry.source.sourceId === activeSourceId ? entry.source.models : [] }))
    : matched.map((entry) => ({ source: entry.source, models: entry.models }));

  return (
    <div data-slot="model-source-browser">
      <div className="flex items-center gap-1 px-2 py-1">
        <Search className="size-3 opacity-70" strokeWidth={1.75} />
        <input
          data-testid="model-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t(searchPlaceholder)}
          className="w-full bg-transparent text-xs outline-none"
        />
      </div>
      {listed.length === 0 && (
        <p data-testid="model-empty" className="px-2 py-1 text-xs opacity-70">{t(emptyText)}</p>
      )}
      {listed.map(({ source, models }) => (
        <div key={source.sourceId} data-testid={`model-group-${source.sourceId}`}>
          <button
            type="button"
            data-testid={`model-source-${source.sourceId}`}
            onClick={() => onActiveSourceChange(source.sourceId)}
            className="w-full px-2 pt-2 text-left text-[0.68rem] uppercase opacity-60 hover:opacity-90"
          >
            {source.sourceLabel}
            {source.configured ? "" : ` · ${t(unconfiguredText)}`}
          </button>
          {models.map((model) => renderModel(source, model))}
        </div>
      ))}
    </div>
  );
}
