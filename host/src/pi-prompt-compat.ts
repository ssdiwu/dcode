import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getCurrentTools, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";

/** Capacity routing uses the same context boundary as the pinned SDK. */
export function requiredContextTokens(context: TranscriptContext, projectedTokens?: number | null): number {
  // AgentSession accounts for fresh provider usage and subsequent messages,
  // invalidating old measurements after edits/compaction. Ciphertext and JSON
  // framing are not an additional copy of the model's natural-language input.
  const tokens = typeof projectedTokens === "number" && Number.isFinite(projectedTokens) && projectedTokens >= 0
    ? projectedTokens : context.messages.reduce((total, message) => total + estimateTokens(message), 0);
  return Math.ceil(tokens) + 2048;
}

/** Pinned Pi 0.87 keeps prompt options instead of a writable state.systemPrompt.
 * Keep this adapter in one place until the SDK exposes an idle full-prompt setter.
 * forceSystemPrompt is also the public before_agent_start replacement contract.
 */
export function installDCodePrompt(session: AgentSession, text: string): void {
  const adapter = session as unknown as {
    _baseSystemPromptOptions: { forceSystemPrompt?: string };
    _runSystemPromptOptions?: { forceSystemPrompt?: string };
  };
  adapter._baseSystemPromptOptions.forceSystemPrompt = text;
  if (adapter._runSystemPromptOptions) adapter._runSystemPromptOptions.forceSystemPrompt = text;
}

export function replaceRequestPrompt(context: TranscriptContext, text: string): TranscriptContext {
  return normalizeContext({ messages: [
    { role: "system", content: text, toolsAdded: getCurrentTools(context.messages), timestamp: 0 },
    ...context.messages.filter(message => message.role !== "system"),
  ] });
}
