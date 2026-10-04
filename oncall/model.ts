/** OpenAI-compatible chat completions with function tools. */
import { NonRetryableError } from "apps";
import type { ToolDefinition } from "./mcp.ts";

type Fetch = typeof fetch;
export type ModelAccount = { fields: { apiKey: string; baseUrl: string; model: string } };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export async function complete(
  fetch: Fetch,
  account: ModelAccount,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  session: string,
  signal?: AbortSignal,
): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const response = await fetch(`${account.fields.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.fields.apiKey}`,
      "Content-Type": "application/json",
      // OpenCode Go routes and caches by a stable per-conversation session and a named client.
      "User-Agent": "executor-oncall/1.0",
      "x-opencode-session": session,
    },
    body: JSON.stringify({
      model: account.fields.model,
      messages,
      ...(tools.length === 0
        ? {}
        : { tools: tools.map((tool) => ({ type: "function", function: tool })), tool_choice: "auto" }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    const message = `Model request failed with HTTP ${response.status}: ${detail}`;
    // Rate limits and server errors may pass; other client errors will not.
    if (response.status >= 400 && response.status < 500 && response.status !== 429)
      throw new NonRetryableError(message);
    throw new Error(message);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  };
  const message = body.choices?.[0]?.message;
  if (message === undefined) throw new Error("Model returned no message.");
  const toolCalls = message.tool_calls?.filter((call) => call.type === "function");
  return {
    content: message.content ?? null,
    ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}
