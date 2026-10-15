// 检查器：全高右栏，按需出现。承载需要持续阅读的文件 diff；关闭后阅读列回到居中。
// 与侧栏对称的架子式表面：磨砂 + 极弱左缘，内部层级由标签、字重与差异语义承担。

import { X } from "lucide-react";
import type { FileChange } from "@/contracts";
import { IconButton } from "../components/Button";
import { DiffView } from "../components/DiffView";
import { useT } from "../i18n";

export function Inspector({
  files,
  activeFile,
  onSelectFile,
  onClose,
}: {
  files: FileChange[];
  activeFile: string;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const active = files.find((f) => f.path === activeFile) ?? files[0];
  return (
    <aside className="app-inspector glass glass-bar flex flex-col border-l border-[var(--edge)]">
      <header className="titlebar-band flex shrink-0 items-center gap-2 border-b border-[var(--edge)] px-3">
        <span className="flex-1 truncate text-ui-sm font-medium">{t("inspector.title", { n: files.length })}</span>
        <IconButton icon={X} label={t("inspector.close")} onClick={onClose} />
      </header>
      {/* 文件标签：选中用 selected + 前景色，与悬停可辨；不额外描边 */}
      <div className="flex shrink-0 gap-1 overflow-x-auto px-2 py-1.5">
        {files.map((file) => (
          <button
            key={file.path}
            title={file.path}
            className={`h-6.5 shrink-0 cursor-default rounded-md px-2 font-mono text-ui-xs transition-colors duration-75 ${
              (active?.path ?? "") === file.path
                ? "bg-selected text-foreground"
                : "text-subtle hover:bg-hover hover:text-foreground"
            }`}
            onClick={() => onSelectFile(file.path)}
          >
            {file.path.split("/").pop()}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{active && <DiffView file={active} />}</div>
    </aside>
  );
}
