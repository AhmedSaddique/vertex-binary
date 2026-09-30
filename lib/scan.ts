import { backtest } from "./backtest";
import { detectSignal, sentimentOf } from "./pattern";
import { predictNext } from "./predict";
import { BacktestBucket, Candle, Direction, PatternConfig, Sentiment, Signal } from "./types";

/**
 * Multi-asset scan: evaluates every bridged asset with both engines (pattern
 * setup + every-candle model) and grades how much the backtest on that asset
 * supports the current call, so the assets can be ranked side by side.
 */

export type Grade = "A" | "B" | "C" | "-";

export interface ScanRow {
  id: string; // symbol id, e.g. QX:EURUSD_otc
  asset: string;
  label: string;
  live: boolean;
  candles: number;
  lastPrice: number;
  sentiment: Sentiment;
  /** model call for the candle that is forming now */
  direction: Direction | null;
  probability: number;
  strength: number;
  qualified: boolean;
  entryTime: number;
  expiryTime: number;
  /** pattern setup currently live on this asset (may be unqualified) */
  pattern: Signal | null;
  /** backtest support for calls like this one on this asset */
  support: BacktestBucket | null;
  supportLabel: string;
  breakEven: number;
  patternWinRate: BacktestBucket | null;
  grade: Grade;
  /** true when the board would tell you to take this trade now */
  actionable: boolean;
  rank: number;
  reason: string;
}

const MIN_SUPPORT = 30;

export function scanAsset(
  id: string,
  asset: string,
  label: string,
  raw: Candle[],
  cfg: PatternConfig,
  live: boolean,
  now = Date.now(),
): ScanRow {
  const last = raw[raw.length - 1];
  const forming = last && last.time + 60_000 > now ? last : null;
  const closed = forming ? raw.slice(0, -1) : raw;
  const base: ScanRow = {
    id,
    asset,
    label,
    live,
    candles: closed.length,
    lastPrice: last?.close ?? 0,
    sentiment: "RANGING",
    direction: null,
    probability: 0.5,
    strength: 0,
    qualified: false,
    entryTime: 0,
    expiryTime: 0,
    pattern: null,
    support: null,
    supportLabel: "",
    breakEven: 1 / (1 + cfg.payout),
    patternWinRate: null,
    grade: "-",
    actionable: false,
    rank: -1000,
    reason: "collecting candles",
  };
  if (closed.length < 30) return base;

  const sentiment = sentimentOf(closed);
  const { prediction, backtest: pbt } = predictNext(closed, cfg);
  const patternSig = detectSignal(closed, cfg);
  const pattern = patternSig && now < patternSig.expiryTime ? patternSig : null;
  const patternBt = backtest(closed, cfg);

  if (!prediction) return { ...base, sentiment };

  // which backtest bucket describes calls like this one?
  let support: BacktestBucket = pbt.byStrength[prediction.strength - 1];
  let supportLabel = `calls at ${support.label}`;
  if (support.signals < MIN_SUPPORT) {
    support = pbt.qualified;
    supportLabel = `calls ≥ ${cfg.minScore * 10}%`;
  }
  if (support.signals < MIN_SUPPORT) {
    support = pbt.all;
    supportLabel = "all calls";
  }
  const be = 1 / (1 + cfg.payout);
  const enough = support.signals >= MIN_SUPPORT;
  const supported = enough && support.winRate > be;

  let grade: Grade = "-";
  let reason = `model leans ${prediction.direction === "CALL" ? "UP" : "DOWN"} at ${Math.round(prediction.probability * 100)}%, below your minimum`;
  if (prediction.qualified) {
    if (supported) {
      grade = "A";
      reason = `${Math.round(prediction.probability * 100)}% call and ${supportLabel} won ${Math.round(support.winRate * 100)}% here (${support.signals} trades)`;
    } else if (!enough) {
      grade = "B";
      reason = `${Math.round(prediction.probability * 100)}% call, but only ${support.signals} graded trades on this asset so far`;
    } else {
      grade = "C";
      reason = `${Math.round(prediction.probability * 100)}% call, but ${supportLabel} only won ${Math.round(support.winRate * 100)}% here, below break-even`;
    }
  }

  const patternQualified = Boolean(pattern?.qualified);
  if (patternQualified) {
    reason = `Wick Liquidity Sweep setup, score ${pattern!.score}/10 (${pattern!.direction === "PUT" ? "SELL" : "BUY"})`;
  }

  const p = prediction.probability;
  let rank: number;
  if (patternQualified) rank = 1000 + pattern!.score * 10;
  else if (grade === "A") rank = 300 + p * 100 + (support.winRate - be) * 200;
  else if (grade === "B") rank = 200 + p * 100;
  else if (grade === "C") rank = 100 + p * 100;
  else rank = p * 100;
  if (!live) rank -= 500;

  return {
    ...base,
    sentiment,
    direction: patternQualified ? pattern!.direction : prediction.direction,
    probability: p,
    strength: prediction.strength,
    qualified: prediction.qualified,
    entryTime: prediction.entryTime,
    expiryTime: prediction.expiryTime,
    pattern,
    support,
    supportLabel,
    breakEven: be,
    patternWinRate: patternBt.all.signals ? patternBt.all : null,
    grade,
    actionable: live && (patternQualified || grade === "A" || grade === "B"),
    rank,
    reason,
  };
}

export function rankRows(rows: ScanRow[]): ScanRow[] {
  return [...rows].sort((a, b) => b.rank - a.rank || b.probability - a.probability);
}
