import { detectSignal, sessionOf } from "./pattern";
import {
  BacktestBucket,
  BacktestResult,
  BacktestTrade,
  Candle,
  DEFAULT_CONFIG,
  Outcome,
  PatternConfig,
} from "./types";

function bucket(label: string, trades: BacktestTrade[]): BacktestBucket {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const ties = trades.length - wins - losses;
  const decided = wins + losses;
  return {
    label,
    signals: trades.length,
    wins,
    losses,
    ties,
    winRate: decided === 0 ? 0 : wins / decided,
  };
}

export function outcomeOf(direction: "CALL" | "PUT", c4: Candle): Outcome {
  if (c4.close === c4.open) return "TIE";
  const up = c4.close > c4.open;
  return (direction === "CALL") === up ? "WIN" : "LOSS";
}


export function backtest(
  candles: Candle[],
  cfg: PatternConfig = DEFAULT_CONFIG,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  for (let i = 7; i < candles.length - 1; i++) {
    const sig = detectSignal(candles, cfg, i);
    if (!sig) continue;
    const c4 = candles[i + 1];
    // skip gaps in the feed (C4 must be the very next minute)
    if (c4.time - sig.c3Time > 90_000) continue;
    trades.push({
      entryTime: sig.entryTime,
      direction: sig.direction,
      score: sig.score,
      strength: sig.strength,
      qualified: sig.qualified,
      outcome: outcomeOf(sig.direction, c4),
      c4,
    });
  }

  const byStrength = [1, 2, 3, 4, 5].map((s) =>
    bucket(`${s}/5`, trades.filter((t) => t.strength === s)),
  );
  const sessionNames = Array.from(new Set(trades.map((t) => sessionOf(t.entryTime).name)));
  const bySession = sessionNames.map((n) =>
    bucket(n, trades.filter((t) => sessionOf(t.entryTime).name === n)),
  );

  return {
    candles: candles.length,
    from: candles[0]?.time ?? 0,
    to: candles[candles.length - 1]?.time ?? 0,
    breakEven: 1 / (1 + cfg.payout),
    all: bucket("All signals", trades),
    qualified: bucket(`Score >= ${cfg.minScore}`, trades.filter((t) => t.qualified)),
    byStrength,
    bySession,
    trades: trades.slice(-100),
  };
}
