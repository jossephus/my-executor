import {
  defineDatabase,
  defineProvider,
  number,
  oauth2,
  object,
  ProviderError,
  secrets,
  string,
  table,
  type MutationContext,
  type QueryContext,
  type WebhookContext,
  type WorkflowContext,
} from "apps";

/** The bot that receives and sends Telegram messages. */
export const telegram = defineProvider({
  name: "Telegram bot",
  auth: {
    botToken: secrets({
      label: "Bot token from @BotFather",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch(`https://api.telegram.org/bot${account.fields.token}/getMe`, {
      signal,
    });
    if (response.status === 401 || response.status === 404)
      throw new ProviderError({ reason: "unauthorized", status: response.status });
    const body = (await response.json()) as {
      ok: boolean;
      result?: { id: number; username?: string; first_name: string };
    };
    if (!body.ok || body.result === undefined) throw new Error("Telegram did not accept this token.");
    return {
      accountInfo: {
        externalId: String(body.result.id),
        displayName: body.result.first_name,
        ...(body.result.username === undefined ? {} : { username: body.result.username }),
      },
    };
  },
});

/** Any OpenAI-compatible chat completions endpoint; defaults to OpenCode Go. */
export const model = defineProvider({
  name: "Chat model",
  auth: {
    apiKey: secrets({
      label: "OpenAI-compatible API key",
      fields: object({
        apiKey: string({ minLength: 1 }),
        baseUrl: string().default("https://opencode.ai/zen/go/v1"),
        model: string().default("glm-5.3"),
      }),
    }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch(`${account.fields.baseUrl.replace(/\/$/, "")}/models`, {
      signal,
      headers: { Authorization: `Bearer ${account.fields.apiKey}` },
    });
    if (response.status === 401 || response.status === 403)
      throw new ProviderError({ reason: "unauthorized", status: response.status });
    return {};
  },
});

/**
 * A scoped connection on this Executor: the bot reaches only the apps chosen for it.
 * Its OAuth tokens are bound to exactly this URL, and Executor refreshes them.
 */
export const EXECUTOR_MCP =
  "https://executor.jossephus.et/mcp?connection=588e2586-b84e-47aa-bd58-920e28e2de06&elicitation_mode=browser";

export const executor = defineProvider({
  name: "Executor (on-call connection)",
  auth: {
    oauth: oauth2({ discover: EXECUTOR_MCP, scopes: ["mcp", "offline_access"] }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch(EXECUTOR_MCP, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${account.fields.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oncall-health", version: "1.0.0" },
        },
      }),
    });
    if (response.status === 401)
      throw new ProviderError({ reason: "unauthorized", status: response.status });
    if (!response.ok) throw new Error(`Executor answered ${response.status}.`);
    await response.body?.cancel();
    return {};
  },
});

export const database = defineDatabase({
  /** Recent conversation per Telegram chat; only user text and final replies, not tool traces. */
  turns: table({ chatId: number(), role: string(), text: string() }).index("by_chat", ["chatId"]),
  /** The chat that receives scheduled briefs and notifications: the last allowed sender. */
  owner: table({ chatId: number() }),
});

export const requirements = { accounts: { telegram, model, executor }, database };
export type QueryCtx = QueryContext<typeof requirements>;
export type MutationCtx = MutationContext<typeof requirements>;
export type WebhookCtx = WebhookContext<typeof requirements>;
export type WorkflowCtx = WorkflowContext<typeof requirements>;
