// 检查器：全高右栏，按需出现。承载需要持续阅读的文件 diff；关闭后阅读列回到居中。

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
    <aside className="app-inspector flex flex-col border-l border-border bg-panel">
      <header className="titlebar-band flex shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-ui-sm font-medium flex-1">{t("inspector.title", { n: files.length })}</span>
        <IconButton icon={X} label={t("inspector.close")} onClick={onClose} />
      </header>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {files.map((file) => (
          <button
            key={file.path}
            className={`shrink-0 rounded-md px-2 h-6.5 text-ui-xs font-mono cursor-default transition-colors duration-75 ${
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
