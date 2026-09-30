import { ingest } from "@/lib/quotex/store";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Receives raw socket messages forwarded by the Quotex bridge userscript. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { messages?: unknown[]; page?: string };
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 2000) : [];
    ingest(messages, typeof body.page === "string" ? body.page : "");
    return Response.json({ ok: true, received: messages.length }, { headers: CORS });
  } catch {
    return Response.json({ ok: false }, { status: 400, headers: CORS });
  }
}
