import { backtest } from "./backtest";
import { bestOfBest, ModelCall } from "./best";
import { detectSignal, sentimentOf } from "./pattern";
import { predictNext } from "./predict";
import { backtestSetups, detectSetups, setupContext } from "./snr";
import { Candle, PatternConfig, SignalResponse } from "./types";

export type Analysis = Omit<SignalResponse, "symbol" | "serverTime" | "candles" | "forming" | "config">;

/** Runs every engine on the closed candles. Browser-safe: used by the API route, the relay path and the scanner. */
export function analyze(closed: Candle[], cfg: PatternConfig): Analysis {
  const ctx = setupContext(closed, cfg);
  const { prediction, backtest: predictionBacktest, calls } = predictNext(closed, cfg);
  const callMap = new Map<number, ModelCall>(
    calls.map((t) => [t.entryTime, { direction: t.direction, probability: t.score / 10 }]),
  );
  if (prediction) {
    callMap.set(prediction.entryTime, { direction: prediction.direction, probability: prediction.probability });
  }
  const { best, backtest: bestBacktest } = bestOfBest(ctx, callMap);
  return {
    sentiment: sentimentOf(closed),
    signal: detectSignal(closed, cfg),
    backtest: backtest(closed, cfg),
    setup: detectSetups(ctx, closed.length - 1)[0] ?? null,
    setupBacktest: backtestSetups(ctx),
    best,
    bestBacktest,
    prediction,
    predictionBacktest,
  };
}
