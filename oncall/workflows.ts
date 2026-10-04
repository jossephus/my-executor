import { boolean, number, object, string, workflow } from "apps";
import type { WorkflowCtx } from "./context.ts";
import { callTool, isPending, listTools, resume, type McpOutcome } from "./mcp.ts";
import { complete, type ChatMessage } from "./model.ts";
import { appendTurn, lastLocation, recentTurns } from "./operations.ts";
import { sendText, telegramCall } from "./telegram.ts";

const MAX_ROUNDS = 16;
/** Approvals expire after 15 minutes; each resume waits up to ~25 seconds for an answer. */
const MAX_WAITS = 40;

const SYSTEM = `You are an on-call assistant that the user talks to over Telegram.
You act only through Executor's MCP tools: \`execute\` runs JavaScript over the user's connected apps,
and \`skills\` reads instructions apps ship.
At the start of a conversation, read your playbook with skills({ app: "oncall", name: "oncall" }) and follow it.
Approvals are handled outside your tools: when a call needs one, the user gets a link and the call
continues once they answer. Never retry a call because it paused for approval.
Reply in short plain text suitable for a phone screen; no Markdown tables.`;

const OUT_OF_STEPS = `You have used all your tool steps for this message. Without calling tools, reply with
what you found so far, what you tried that failed, and the next step to take if the user says "continue".`;

const noRetry = { retries: { limit: 0, delay: "1 second" }, timeout: "20 minutes" } as const;

export const reply = workflow(
  {
    description: "Answer one Telegram message using Executor tools",
    input: object({ chatId: number(), text: string(), remember: boolean().default(true) }),
  },
  async (ctx: WorkflowCtx, { chatId, text, remember }) => {
    const { step } = ctx;
    const send = (name: string, body: string) =>
      step.do(name, async (s) => {
        await sendText(s.fetch, s.accounts.telegram.fields.token, chatId, body);
        return null;
      });

    let answer: string | undefined;
    try {
      const history = await step.runQuery("history", recentTurns, { chatId, limit: 20 });
      const location = (await step.runQuery("location", lastLocation, { chatId })) as {
        latitude: number;
        longitude: number;
        sharedAt: string;
      } | null;
      // Time reads belong in a step so a replayed run sees the same value.
      const now = await step.do("now", async () => new Date().toISOString());
      if (remember)
        await step.runMutation("save question", appendTurn, { chatId, role: "user", text });

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${SYSTEM}\n\n${
            location === null
              ? "The owner has not shared a location. If a request needs one, ask them to send /location."
              : `The owner's last shared location: ${location.latitude}, ${location.longitude} (shared at ${location.sharedAt}; now is ${now}). If it is more than a few hours old, mention that and suggest /location to refresh.`
          }`,
        },
        ...history.map((turn): ChatMessage =>
          turn.role === "assistant"
            ? { role: "assistant", content: turn.text }
            : { role: "user", content: turn.text },
        ),
        { role: "user", content: text },
      ];

      const tools = await step.do(
        "list tools",
        { retries: { limit: 2, delay: "2 seconds" }, timeout: "1 minute" },
        (s) => listTools(s.fetch, s.accounts.executor),
      );

      for (let round = 0; round < MAX_ROUNDS && answer === undefined; round++) {
        await step.do(`typing ${round}`, async (s) => {
          await telegramCall(s.fetch, s.accounts.telegram.fields.token, "sendChatAction", {
            chat_id: chatId,
            action: "typing",
          }).catch(() => undefined);
          return null;
        });
        const message = await step.do(
          `model ${round}`,
          {
            retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
            timeout: "3 minutes",
          },
          (s) => complete(s.fetch, s.accounts.model, messages, tools, `oncall-${chatId}`, s.signal),
        );
        messages.push({ role: "assistant", ...message });
        if (message.tool_calls === undefined) {
          answer = message.content ?? "";
          break;
        }

        for (const [index, call] of message.tool_calls.entries()) {
          const id = `${round}.${index}`;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Invalid JSON arguments.",
            });
            continue;
          }
          // Side effects must not repeat: tool calls are never retried.
          let result: McpOutcome = await step.do(`tool ${id}`, noRetry, (s) =>
            callTool(s.fetch, s.accounts.executor, call.function.name, args),
          );
          let linked: string | undefined;
          for (let wait = 0; isPending(result) && result.requestId !== undefined; wait++) {
            if (wait >= MAX_WAITS) break;
            if (result.approvalUrl !== undefined && result.requestId !== linked) {
              linked = result.requestId;
              await send(
                `approval ${id}.${wait}`,
                `${result.message ?? "Executor needs your approval to continue."}\n\nReview it here: ${result.approvalUrl}`,
              );
            }
            const requestId = result.requestId;
            result = await step.do(`resume ${id}.${wait}`, noRetry, (s) =>
              resume(s.fetch, s.accounts.executor, requestId),
            );
          }
          if (isPending(result)) result = { text: "The approval expired before it was answered." };
          messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
        }
      }
      // Out of steps: summarize without tools, so the reply (and the saved history) carries the findings.
      answer ??= await step.do(
        "summary",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async (s) => {
          const summary = await complete(
            s.fetch,
            s.accounts.model,
            [...messages, { role: "user", content: OUT_OF_STEPS }],
            [],
            `oncall-${chatId}`,
            s.signal,
          );
          return summary.content ?? "I ran out of steps before finding an answer.";
        },
      );
    } catch (error) {
      await send(
        "failure",
        `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    await send("reply", answer);
    if (remember)
      await step.runMutation("save answer", appendTurn, {
        chatId,
        role: "assistant",
        text: answer,
      });
    return null;
  },
);
