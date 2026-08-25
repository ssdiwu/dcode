import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

export class DCodeOperationAttemptController {
  private prepareHandler?: (event: ToolCallEvent) => Promise<void>;
  private finishHandler?: (event: ToolResultEvent) => Promise<void>;

  bind(handlers: {
    prepare: (event: ToolCallEvent) => Promise<void>;
    finish: (event: ToolResultEvent) => Promise<void>;
  }): void {
    this.prepareHandler = handlers.prepare;
    this.finishHandler = handlers.finish;
  }

  async prepare(event: ToolCallEvent): Promise<void> {
    if (!this.prepareHandler) throw new Error("D Code Operation Attempt controller is not bound");
    await this.prepareHandler(event);
  }

  async finish(event: ToolResultEvent): Promise<void> {
    if (!this.finishHandler) throw new Error("D Code Operation Attempt controller is not bound");
    await this.finishHandler(event);
  }

  dispose(): void {
    this.prepareHandler = undefined;
    this.finishHandler = undefined;
  }
}

export function createDCodeOperationAttemptExtension(
  controller: DCodeOperationAttemptController,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      await controller.prepare(event);
      return undefined;
    });
    pi.on("tool_result", async (event) => {
      await controller.finish(event);
      return undefined;
    });
  };
}
