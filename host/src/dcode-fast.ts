import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export const FAST_SERVICE_TIER = "priority" as const;
export const FAST_STATE_ENTRY_TYPE = "pi-dfast-state";
const TARGET_PROVIDER = "openai-codex";
const SUPPORTED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

export type DCodeFastReason = "disabled" | "no-model" | "unsupported-provider" | "unsupported-model" | "supported";

export interface DCodeFastSnapshot {
  version: 1;
  enabled: boolean;
  active: boolean;
  provider?: string;
  model?: string;
  requestedServiceTier: typeof FAST_SERVICE_TIER;
  reason: DCodeFastReason;
  updatedAt: number;
}

interface ModelRef {
  provider?: string;
  id?: string;
}

interface FastStateEntry {
  version: 1;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fastModeReason(enabled: boolean, model: ModelRef | undefined): DCodeFastReason {
  if (!enabled) return "disabled";
  if (!model?.provider || !model.id) return "no-model";
  if (model.provider !== TARGET_PROVIDER) return "unsupported-provider";
  if (!SUPPORTED_MODELS.has(model.id)) return "unsupported-model";
  return "supported";
}

export function createFastSnapshot(enabled: boolean, model: ModelRef | undefined): DCodeFastSnapshot {
  const reason = fastModeReason(enabled, model);
  return {
    version: 1,
    enabled,
    active: reason === "supported",
    ...(model?.provider ? { provider: model.provider } : {}),
    ...(model?.id ? { model: model.id } : {}),
    requestedServiceTier: FAST_SERVICE_TIER,
    reason,
    updatedAt: Date.now(),
  };
}

export function applyFastServiceTier(payload: unknown): unknown {
  return isRecord(payload) ? { ...payload, service_tier: FAST_SERVICE_TIER } : payload;
}

export function shouldApplyFastMode(enabled: boolean, model: ModelRef | undefined, payload: unknown): boolean {
  return fastModeReason(enabled, model) === "supported"
    && isRecord(payload)
    && payload.model === model?.id;
}

export function restoreFastMode(entries: readonly unknown[]): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY_TYPE) continue;
    const state = entry.data;
    if (isRecord(state) && state.version === 1 && typeof state.enabled === "boolean") enabled = state.enabled;
  }
  return enabled;
}

export class DCodeFastController {
  private setter?: (enabled: boolean) => DCodeFastSnapshot;
  private current = createFastSnapshot(false, undefined);

  get snapshot(): DCodeFastSnapshot { return this.current; }

  bind(setter: (enabled: boolean) => DCodeFastSnapshot): void {
    this.setter = setter;
  }

  update(snapshot: DCodeFastSnapshot): void {
    this.current = snapshot;
  }

  setEnabled(enabled: boolean): DCodeFastSnapshot {
    if (!this.setter) throw new Error("D Code fast mode is not ready");
    const snapshot = this.setter(enabled);
    this.current = snapshot;
    return snapshot;
  }

  dispose(): void {
    this.setter = undefined;
    this.current = createFastSnapshot(false, undefined);
  }
}

export function createDCodeFastExtension(controller: DCodeFastController): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let enabled = false;
    let currentContext: ExtensionContext | undefined;

    const publish = (context: ExtensionContext | undefined = currentContext): DCodeFastSnapshot => {
      const snapshot = createFastSnapshot(enabled, context?.model);
      controller.update(snapshot);
      try { pi.events.emit("pi-dfast/updated", snapshot); }
      catch { /* Optional consumers cannot block request control. */ }
      return snapshot;
    };

    const restore = (context: ExtensionContext): DCodeFastSnapshot => {
      currentContext = context;
      enabled = restoreFastMode(context.sessionManager.getBranch());
      return publish(context);
    };

    const setEnabled = (next: boolean): DCodeFastSnapshot => {
      pi.appendEntry<FastStateEntry>(FAST_STATE_ENTRY_TYPE, { version: 1, enabled: next });
      enabled = next;
      return publish();
    };

    controller.bind(setEnabled);

    pi.events.on("pi-dfast/subscribe", () => { publish(); });

    pi.registerCommand("fast", {
      description: "控制 D Code 极速模式：/fast [on|off|status]",
      handler: async (args, context) => {
        const action = args.trim().toLowerCase() || "toggle";
        if (action === "status") {
          const snapshot = publish(context);
          context.ui.notify(
            snapshot.active
              ? "极速已开启并适用于当前模型。"
              : snapshot.enabled ? "极速已开启，但当前模型不支持。" : "极速已关闭。",
            snapshot.enabled && !snapshot.active ? "warning" : "info",
          );
          return;
        }
        if (!new Set(["toggle", "on", "off"]).has(action)) {
          context.ui.notify("用法：/fast [on|off|status]", "warning");
          return;
        }
        currentContext = context;
        const snapshot = setEnabled(action === "toggle" ? !enabled : action === "on");
        context.ui.notify(
          snapshot.active
            ? "极速已开启并适用于当前模型。"
            : snapshot.enabled ? "极速已开启，但当前模型不支持。" : "极速已关闭。",
          snapshot.enabled && !snapshot.active ? "warning" : "info",
        );
      },
    });

    pi.on("session_start", (_event, context) => { restore(context); });
    pi.on("session_tree", (_event, context) => { restore(context); });
    pi.on("session_before_switch", () => {
      enabled = false;
      currentContext = undefined;
      publish();
    });
    pi.on("model_select", (_event, context) => {
      currentContext = context;
      publish(context);
    });
    pi.on("before_provider_request", (event, context) => {
      currentContext = context;
      publish(context);
      if (!shouldApplyFastMode(enabled, context.model, event.payload)) return undefined;
      return applyFastServiceTier(event.payload);
    });
    pi.on("session_shutdown", () => {
      enabled = false;
      currentContext = undefined;
      publish();
      controller.dispose();
    });
  };
}
