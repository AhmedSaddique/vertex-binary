import type { NextRequest } from "next/server";
import { backtest } from "@/lib/backtest";
import { mockSeries } from "@/lib/mock";
import { detectSignal, sentimentOf } from "@/lib/pattern";
import { fetchCandles, getSymbol, splitForming } from "@/lib/providers";
import { DEFAULT_CONFIG, PatternConfig, SignalResponse } from "@/lib/types";

function num(v: string | null, fallback: number) {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function configFrom(params: URLSearchParams): PatternConfig {
  return {
    minWickRatio: num(params.get("minWickRatio"), DEFAULT_CONFIG.minWickRatio),
    equalTolerance: num(params.get("equalTolerance"), DEFAULT_CONFIG.equalTolerance),
    minBodyRatio: num(params.get("minBodyRatio"), DEFAULT_CONFIG.minBodyRatio),
    requireStrongC3:
      params.get("requireStrongC3") === null
        ? DEFAULT_CONFIG.requireStrongC3
        : params.get("requireStrongC3") === "1",
    avgBodyLookback: num(params.get("avgBodyLookback"), DEFAULT_CONFIG.avgBodyLookback),
    minScore: num(params.get("minScore"), DEFAULT_CONFIG.minScore),
    payout: num(params.get("payout"), DEFAULT_CONFIG.payout),
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = await getSymbol(params.get("symbol") ?? "BTCUSDT");
  if (!symbol) return Response.json({ error: "Unknown symbol" }, { status: 400 });
  if (!symbol.available) {
    return Response.json({ error: symbol.note ?? "Symbol unavailable" }, { status: 503 });
  }
  const limit = Math.min(5000, Math.max(100, num(params.get("limit"), 3000)));
  const config = configFrom(params);
  const mock = params.get("mock");

  try {
    const raw =
      mock === "PUT" || mock === "CALL" ? mockSeries(mock) : await fetchCandles(symbol, limit);
    const { closed, forming } = splitForming(raw);
    const signal = detectSignal(closed, config);
    const payload: SignalResponse = {
      symbol,
      serverTime: Date.now(),
      candles: closed.slice(-120),
      forming,
      signal,
      sentiment: sentimentOf(closed),
      backtest: backtest(closed, config),
      config,
    };
    return Response.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Feed error";
    return Response.json({ error: message }, { status: 502 });
  }
}
