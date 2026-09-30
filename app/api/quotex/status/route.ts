import { bridgeStatus } from "@/lib/quotex/store";

export async function GET() {
  return Response.json(await bridgeStatus());
}
