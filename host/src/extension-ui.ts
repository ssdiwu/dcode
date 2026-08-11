import { randomUUID } from "node:crypto";
import type {
  ExtensionUIDialogOptions,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

type Emit = (event: string, data?: unknown) => void;

interface PendingDialog {
  finish: (response: unknown) => void;
  cancel: () => void;
}

function responseRecord(response: unknown): Record<string, unknown> {
  return typeof response === "object" && response !== null && !Array.isArray(response)
    ? response as Record<string, unknown>
    : {};
}

export class ExtensionUIBridge {
  private readonly pendingDialogs = new Map<string, PendingDialog>();
  private readonly reportedWidgets = new Set<string>();
  private editorText = "";
  readonly context: ExtensionUIContext;

  constructor(private readonly emit: Emit) {
    this.context = this.createContext();
  }

  respond(requestId: string, response: unknown): boolean {
    const dialog = this.pendingDialogs.get(requestId);
    if (!dialog) return false;
    dialog.finish(response);
    return true;
  }

  cancelAll(_reason?: string): void {
    for (const dialog of [...this.pendingDialogs.values()]) dialog.cancel();
    this.reportedWidgets.clear();
  }

  private requestDialog<T>(
    method: string,
    payload: Record<string, unknown>,
    fallback: T,
    parse: (response: Record<string, unknown>) => T,
    options?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (options?.signal?.aborted) return Promise.resolve(fallback);
    const requestId = randomUUID();
    return new Promise<T>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        this.pendingDialogs.delete(requestId);
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.emit("extension.closed", { requestId, method });
        resolve(value);
      };
      const cancel = () => settle(fallback);
      this.pendingDialogs.set(requestId, {
        finish: (response) => {
          const record = responseRecord(response);
          settle(record.cancelled === true ? fallback : parse(record));
        },
        cancel,
      });
      if (options?.timeout) timer = setTimeout(cancel, options.timeout);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      this.emit("extension.request", {
        requestId,
        method,
        ...payload,
        ...(options?.timeout ? { timeout: options.timeout, expiresAt: Date.now() + options.timeout } : {}),
      });
    });
  }

  private reportUnsupported(
    capability: string,
    behavior: "blocked" | "ignored",
    details: Record<string, unknown> = {},
  ): void {
    this.emit("extension.unsupported", {
      capability,
      behavior,
      message: behavior === "blocked"
        ? `D Code blocked unsupported extension UI capability: ${capability}`
        : `D Code ignored unsupported extension UI capability: ${capability}`,
      ...details,
    });
  }

  private blockUnsupported(capability: string): never {
    this.reportUnsupported(capability, "blocked");
    const error = new Error(`D Code does not support extension UI capability: ${capability}`) as Error & { code: string };
    error.name = "UnsupportedExtensionUIError";
    error.code = "EXTENSION_UI_UNSUPPORTED";
    throw error;
  }

  private createContext(): ExtensionUIContext {
    const bridge = this;
    return {
      select: (title, options, dialogOptions) => bridge.requestDialog(
        "select",
        { title, options },
        undefined,
        (response) => typeof response.value === "string" ? response.value : undefined,
        dialogOptions,
      ),
      confirm: (title, message, dialogOptions) => bridge.requestDialog(
        "confirm",
        { title, message },
        false,
        (response) => response.confirmed === true,
        dialogOptions,
      ),
      input: (title, placeholder, dialogOptions) => bridge.requestDialog(
        "input",
        { title, placeholder },
        undefined,
        (response) => typeof response.value === "string" ? response.value : undefined,
        dialogOptions,
      ),
      editor: (title, prefill) => bridge.requestDialog(
        "editor",
        { title, prefill },
        undefined,
        (response) => typeof response.value === "string" ? response.value : undefined,
      ),
      notify(message, type) {
        bridge.emit("extension.notification", { message, level: type ?? "info" });
      },
      onTerminalInput() {
        bridge.reportUnsupported("onTerminalInput", "ignored");
        return () => undefined;
      },
      setStatus(key, text) { bridge.emit("extension.status", { key, text: text ?? null }); },
      setWorkingMessage(message) { bridge.emit("extension.working", { message: message ?? null }); },
      setWorkingVisible() { bridge.reportUnsupported("setWorkingVisible", "ignored"); },
      setWorkingIndicator() { bridge.reportUnsupported("setWorkingIndicator", "ignored"); },
      setHiddenThinkingLabel() { bridge.reportUnsupported("setHiddenThinkingLabel", "ignored"); },
      setWidget(key, content, options) {
        if (content === undefined) {
          bridge.reportedWidgets.delete(key);
          return;
        }
        if (bridge.reportedWidgets.has(key)) return;
        bridge.reportedWidgets.add(key);
        bridge.reportUnsupported("setWidget", "ignored", {
          key,
          placement: options?.placement ?? "aboveEditor",
        });
      },
      setFooter() { bridge.reportUnsupported("setFooter", "ignored"); },
      setHeader() { bridge.reportUnsupported("setHeader", "ignored"); },
      setTitle() { bridge.reportUnsupported("setTitle", "ignored"); },
      custom: async <T>(): Promise<T> => bridge.blockUnsupported("custom"),
      pasteToEditor(text) {
        bridge.editorText = text;
        bridge.emit("extension.editorText", { text, mode: "paste" });
      },
      setEditorText(text) {
        bridge.editorText = text;
        bridge.emit("extension.editorText", { text, mode: "replace" });
      },
      getEditorText() { return bridge.editorText; },
      addAutocompleteProvider() { bridge.reportUnsupported("addAutocompleteProvider", "ignored"); },
      setEditorComponent() { bridge.reportUnsupported("setEditorComponent", "ignored"); },
      getEditorComponent() { return bridge.blockUnsupported("getEditorComponent"); },
      get theme() { return bridge.blockUnsupported("theme"); },
      getAllThemes() { return bridge.blockUnsupported("getAllThemes"); },
      getTheme() { return bridge.blockUnsupported("getTheme"); },
      setTheme() {
        bridge.reportUnsupported("setTheme", "ignored");
        return { success: false, error: "Theme switching is controlled by the native app" };
      },
      // Match Pi's RPC UI contract: native clients have no global TUI expansion
      // state, so extensions observe the safe collapsed default and writes are a
      // no-op. This is a presentation hint, not an unsupported user action.
      getToolsExpanded() { return false; },
      setToolsExpanded() {},
    } as ExtensionUIContext;
  }
}
