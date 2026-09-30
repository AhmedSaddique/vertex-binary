/**
 * Optional Telegram alert relay. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in
 * .env.local; without them the endpoint reports sent:false and does nothing.
 */
export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Response.json({ sent: false, reason: "not configured" });

  const { text } = (await request.json()) as { text?: string };
  if (!text) return Response.json({ sent: false, reason: "empty" }, { status: 400 });

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  return Response.json({ sent: res.ok });
}
