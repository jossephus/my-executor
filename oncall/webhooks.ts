import { array, number, object, string, type Webhook } from "apps";
import type { WebhookCtx } from "./context.ts";
import { clearTurns, rememberOwner } from "./operations.ts";
import { secretToken, sendText, telegramCall } from "./telegram.ts";

/** Only these Telegram user IDs may talk to the bot. Everyone else is told their ID and ignored. */
const Config = object({ allowedUserIds: array(number()) });
const State = object({ url: string() });

type Update = {
  update_id: number;
  message?: {
    text?: string;
    location?: { latitude: number; longitude: number };
    chat: { id: number; type: string };
    from?: { id: number };
  };
};

function sameText(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export const telegramMessages = {
  account: "telegram",
  config: Config,
  state: State,
  register: async (ctx, { callbackUrl, secret }) => {
    await telegramCall(ctx.fetch, ctx.accounts.telegram.fields.token, "setWebhook", {
      url: callbackUrl,
      secret_token: await secretToken(secret),
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
    return { url: callbackUrl };
  },
  handle: async (ctx, { request, secret, config }) => {
    const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!sameText(header, await secretToken(secret))) return new Response(null, { status: 401 });
    const update = (await request.json()) as Update;
    const message = update.message;
    if (
      message === undefined ||
      (message.text === undefined && message.location === undefined) ||
      message.from === undefined ||
      message.chat.type !== "private"
    )
      return new Response(null, { status: 200 });

    const token = ctx.accounts.telegram.fields.token;
    const chatId = message.chat.id;
    if (!config.allowedUserIds.includes(message.from.id)) {
      await sendText(ctx.fetch, token, chatId, `Not authorized. Your Telegram user ID is ${message.from.id}.`);
      return new Response(null, { status: 200 });
    }

    await rememberOwner(ctx, chatId);
    if (message.location !== undefined) {
      const { latitude, longitude } = message.location;
      await ctx.db.turns.insert({ chatId, role: "location", text: `${latitude},${longitude}` });
      await telegramCall(ctx.fetch, token, "sendMessage", {
        chat_id: chatId,
        text: "📍 Got your location. Ask me what's nearby.",
        reply_markup: { remove_keyboard: true },
      });
      return new Response(null, { status: 200 });
    }
    const text = (message.text ?? "").trim();
    if (text === "/location") {
      await telegramCall(ctx.fetch, token, "sendMessage", {
        chat_id: chatId,
        text: "Tap the button to share where you are.",
        reply_markup: {
          keyboard: [[{ text: "📍 Share my location", request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return new Response(null, { status: 200 });
    }
    if (text === "/start" || text === "/help") {
      await sendText(ctx.fetch, token, chatId, "Hi! Ask me about your Linear issues, PostHog, Cloudflare and anything else connected to Executor. /location shares where you are. /reset clears our conversation.");
      return new Response(null, { status: 200 });
    }
    if (text === "/reset") {
      const removed = await clearTurns(ctx, chatId);
      await sendText(ctx.fetch, token, chatId, `Forgot ${removed} messages.`);
      return new Response(null, { status: 200 });
    }

    // Telegram redelivers until it gets a 200; the update ID keeps a redelivery from starting a second run.
    await ctx.workflows
      .start({ workflow: "reply", input: { chatId, text, remember: true }, key: `update-${update.update_id}` })
      .catch((error: unknown) => console.warn("reply not started", error));
    return new Response(null, { status: 200 });
  },
  unregister: async (ctx, { callbackUrl }) => {
    const token = ctx.accounts.telegram.fields.token;
    const info = (await telegramCall(ctx.fetch, token, "getWebhookInfo", {})) as { url?: string };
    if (info.url === callbackUrl) await telegramCall(ctx.fetch, token, "deleteWebhook", {});
  },
} satisfies Webhook<WebhookCtx, typeof Config, typeof State>;
