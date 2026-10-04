/**
 * Reach this Executor's scoped on-call connection with its OAuth token, in browser approval mode.
 * A small streamable HTTP client: the MCP SDK's default validator does not load in app isolates.
 */
type Fetch = typeof fetch;
import { EXECUTOR_MCP } from "./context.ts";

export type ExecutorAccount = { fields: { access_token: string } };

/** The parts of an execute/resume result the bot acts on. */
export type McpOutcome = {
  text: string;
  status?: string;
  requestId?: string;
  approvalUrl?: string;
  message?: string;
};

const PROTOCOL = "2025-06-18";

type RpcResponse = { id?: number; result?: unknown; error?: { message: string } };

/** A response is either one JSON body or an SSE stream carrying the reply among other messages. */
async function readResponse(response: Response, id: number): Promise<unknown> {
  if (!response.ok) throw new Error(`Executor MCP answered HTTP ${response.status}.`);
  const type = response.headers.get("content-type") ?? "";
  let message: RpcResponse | undefined;
  if (type.includes("text/event-stream")) {
    const text = await response.text();
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data === "") continue;
      const parsed = JSON.parse(data) as RpcResponse;
      if (parsed.id === id) message = parsed;
    }
  } else {
    message = (await response.json()) as RpcResponse;
  }
  if (message === undefined) throw new Error("Executor MCP sent no reply.");
  if (message.error !== undefined) throw new McpError(message.error.message);
  return message.result;
}

/** Paused runs belong to the grant, not the HTTP session, so every call can open a fresh session. */
async function session(fetch: Fetch, account: ExecutorAccount) {
  const url = EXECUTOR_MCP;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.fields.access_token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  let next = 0;
  const post = (body: object) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

  const initId = ++next;
  const init = await post({
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "oncall-telegram", version: "1.0.0" },
    },
  });
  const sessionId = init.headers.get("mcp-session-id");
  const negotiated = (await readResponse(init, initId)) as { protocolVersion?: string };
  if (sessionId !== null) headers["Mcp-Session-Id"] = sessionId;
  headers["MCP-Protocol-Version"] = negotiated.protocolVersion ?? PROTOCOL;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });

  // No DELETE on completion: a paused run must outlive this request until it is resumed.
  return async (method: string, params: object) => {
    const id = ++next;
    return readResponse(await post({ jsonrpc: "2.0", id, method, params }), id);
  };
}

async function withSession<T>(
  fetch: Fetch,
  account: ExecutorAccount,
  run: (request: (method: string, params: object) => Promise<unknown>) => Promise<T>,
) {
  return run(await session(fetch, account));
}

export type ToolDefinition = { name: string; description: string; parameters: unknown };

/** The model drives execute and skills; the workflow answers resume itself after browser approval. */
export const listTools = (fetch: Fetch, account: ExecutorAccount) =>
  withSession(fetch, account, async (request) => {
    const { tools } = (await request("tools/list", {})) as {
      tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
    };
    return tools
      .filter((tool) => tool.name !== "resume")
      .map(
        (tool): ToolDefinition => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema,
        }),
      );
  });

const LIMIT = 24_000;

function outcome(result: unknown): McpOutcome {
  const value = result as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  const structured = value.structuredContent;
  let text =
    structured !== undefined
      ? JSON.stringify(structured)
      : (value.content ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
          .join("\n");
  if (text.length > LIMIT)
    text = `${text.slice(0, LIMIT)}\n…(truncated ${text.length - LIMIT} characters)`;
  const read = (key: string) => {
    const field = structured?.[key];
    return typeof field === "string" ? field : undefined;
  };
  const elicitation = structured?.["elicitation"] as { message?: unknown } | undefined;
  const found: McpOutcome = { text };
  const status = read("status");
  const requestId = read("requestId");
  const approvalUrl = read("approvalUrl");
  if (status !== undefined) found.status = status;
  if (requestId !== undefined) found.requestId = requestId;
  if (approvalUrl !== undefined) found.approvalUrl = approvalUrl;
  if (typeof elicitation?.message === "string") found.message = elicitation.message;
  return found;
}

/** A protocol error, such as invalid arguments, goes back to the model so it can correct the call. */
export class McpError extends Error {}

export const callTool = (
  fetch: Fetch,
  account: ExecutorAccount,
  name: string,
  args: Record<string, unknown>,
) =>
  withSession(fetch, account, async (request) =>
    outcome(await request("tools/call", { name, arguments: args })),
  ).catch((error: unknown) => {
    if (error instanceof McpError) return { text: `Tool call rejected: ${error.message}` };
    throw error;
  });

/** In browser mode resume waits up to ~25s for the answer, then reports the run's current state. */
export const resume = (fetch: Fetch, account: ExecutorAccount, requestId: string) =>
  withSession(fetch, account, async (request) =>
    outcome(await request("tools/call", { name: "resume", arguments: { requestId } })),
  );

export const isPending = (result: McpOutcome) =>
  result.status === "approval-required" || result.status === "input-required";
