import { Candle } from "../types";

const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

async function page(symbol: string, limit: number, endTime?: number): Promise<Candle[]> {
  let lastErr: unknown;
  for (const host of HOSTS) {
    try {
      const url =
        `${host}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}` +
        (endTime ? `&endTime=${endTime}` : "");
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Binance ${res.status}`);
      const rows = (await res.json()) as (string | number)[][];
      return rows.map((r) => ({
        time: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Binance unavailable");
}

/**
 * Free, key-less 1-minute klines. Includes the currently forming candle as the
 * last row. Pages backwards (1000 per request) when more history is requested.
 */
export async function fetchBinance(symbol: string, limit = 500): Promise<Candle[]> {
  let out: Candle[] = [];
  let endTime: number | undefined;
  while (out.length < limit) {
    const want = Math.min(1000, limit - out.length);
    const rows = await page(symbol, want, endTime);
    if (rows.length === 0) break;
    out = [...rows, ...out];
    endTime = rows[0].time - 1;
    if (rows.length < want) break;
  }
  return out;
}
