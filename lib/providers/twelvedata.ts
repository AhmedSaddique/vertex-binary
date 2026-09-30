import { Candle } from "../types";

interface TDValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

/**
 * Twelve Data 1-minute forex/metals candles. Free tier: 8 requests/min, 800/day.
 * Set TWELVEDATA_API_KEY in .env.local. The newest row is the in-progress bar.
 */
export async function fetchTwelveData(symbol: string, limit = 500): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY is not set");
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1min&outputsize=${limit}&timezone=UTC&apikey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json()) as {
    status?: string;
    message?: string;
    values?: TDValue[];
  };
  if (json.status === "error" || !json.values) {
    throw new Error(json.message || "Twelve Data error");
  }
  return json.values
    .map((v) => ({
      time: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
    }))
    .reverse();
}
