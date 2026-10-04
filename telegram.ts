/** Minimal Telegram Bot API calls. Replies are plain text so model output never breaks parse modes. */
type Fetch = typeof fetch;

export async function telegramCall(
  fetch: Fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const result = (await response.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!result.ok) throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
  return result.result;
}

/** Telegram limits a message to 4096 characters; split on line breaks where possible. */
export async function sendText(fetch: Fetch, token: string, chatId: number, text: string) {
  const chunks: string[] = [];
  let rest = text.trim() === "" ? "(empty reply)" : text;
  while (rest.length > 4000) {
    const cut = rest.lastIndexOf("\n", 4000);
    const at = cut > 1000 ? cut : 4000;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  chunks.push(rest);
  for (const chunk of chunks)
    await telegramCall(fetch, token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      link_preview_options: { is_disabled: true },
    });
}

/** Telegram secret tokens allow only [A-Za-z0-9_-]; derive one from Executor's signing secret. */
export async function secretToken(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
