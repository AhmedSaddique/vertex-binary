import { listSymbols } from "@/lib/providers";

export async function GET() {
  return Response.json({ symbols: listSymbols() });
}
