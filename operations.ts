import { array, json, mutation, number, object, query, string } from "apps";
import type { MutationCtx, QueryCtx } from "./context.ts";
import { sendText } from "./telegram.ts";

const Turn = object({ role: string(), text: string() });

/** Oldest first, for the model's context. */
export const recentTurns = query(
  {
    description: "Read the last turns of a Telegram conversation with the on-call bot",
    input: object({ chatId: number(), limit: number().default(20) }),
    output: array(Turn),
  },
  async (ctx: QueryCtx, { chatId, limit }) => {
    const rows = await ctx.db.turns
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(Math.min(limit, 100));
    return [...rows]
      .reverse()
      .filter((row) => row.role !== "location")
      .map(({ role, text }) => ({ role, text }));
  },
);

/** Shared locations live in the turns table as role "location", text "lat,lon": no schema change. */
export const lastLocation = query(
  {
    description: "Read the owner's last location shared on Telegram",
    input: object({ chatId: number() }),
    output: json(),
  },
  async (ctx: QueryCtx, { chatId }) => {
    const rows = await ctx.db.turns
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(500);
    const row = rows.find((turn) => turn.role === "location");
    if (row === undefined) return null;
    const [latitude, longitude] = row.text.split(",").map(Number);
    return { latitude, longitude, sharedAt: row.createdAt };
  },
);

export const appendTurn = mutation(
  {
    description: "Record one turn of a Telegram conversation",
    input: object({ chatId: number(), role: string(), text: string() }),
    output: object({}),
  },
  async (ctx: MutationCtx, turn) => {
    await ctx.db.turns.insert({ ...turn, text: turn.text.slice(0, 16_000) });
    return {};
  },
);

/** Forget a chat's conversation for /reset; its shared location is kept. */
export async function clearTurns(ctx: Pick<MutationCtx, "db">, chatId: number) {
  const rows = await ctx.db.turns.withIndex("by_chat", (q) => q.eq("chatId", chatId)).take(500);
  const conversation = rows.filter((row) => row.role !== "location");
  for (const row of conversation) await ctx.db.turns.delete(row.id);
  return conversation.length;
}

export async function rememberOwner(ctx: Pick<MutationCtx, "db">, chatId: number) {
  const current = await ctx.db.owner.withIndex("by_creation").first();
  if (current === null) await ctx.db.owner.insert({ chatId });
  else if (current.chatId !== chatId) await ctx.db.owner.update(current.id, { chatId });
}

async function ownerChat(ctx: Pick<QueryCtx, "db">) {
  const owner = await ctx.db.owner.withIndex("by_creation").first();
  if (owner === null) throw new Error("No owner chat yet. Send the bot a message on Telegram first.");
  return owner.chatId;
}

/** Lets any agent on this Executor ping you on Telegram. */
export const notify = mutation(
  {
    description: "Send a plain-text Telegram message to the on-call bot's owner",
    input: object({ text: string({ minLength: 1 }) }),
    output: object({}),
  },
  async (ctx: MutationCtx, { text }) => {
    await sendText(ctx.fetch, ctx.accounts.telegram.fields.token, await ownerChat(ctx), text);
    return {};
  },
);

/** Scheduled: run the playbook's morning brief and deliver it to the owner chat. */
export const morningBrief = mutation(
  {
    description: "Start the on-call morning brief and send it to the owner on Telegram",
    input: object({}),
    output: object({ run: string() }),
  },
  async (ctx: MutationCtx) => {
    const chatId = await ownerChat(ctx);
    const run = await ctx.workflows.start({
      workflow: "reply",
      input: {
        chatId,
        text: "Run the morning brief from your on-call playbook.",
        remember: false,
      },
    });
    return { run: run.id };
  },
);
