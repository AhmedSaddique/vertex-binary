import { analyze } from "./analyze";
import { BacktestBucket, Candle, Direction, Mode, PatternConfig, Sentiment, Signal } from "./types";

/**
 * Multi-asset scan: evaluates every bridged asset with all engines (A+ confluence,
 * SnR setups, wick sweep, every-candle model) and grades how much the backtest on
 * that asset supports the current call, so the assets can be ranked side by side.
 */

export type Grade = "A+" | "A" | "B" | "C" | "-";

export interface ScanRow {
  id: string; // symbol id, e.g. QX:EURUSD_otc
  asset: string;
  label: string;
  live: boolean;
  candles: number;
  lastPrice: number;
  sentiment: Sentiment;
  /** call for the candle that is forming now (A+ / setup direction when one is live, else the model) */
  direction: Direction | null;
  probability: number;
  strength: number;
  qualified: boolean;
  entryTime: number;
  expiryTime: number;
  /** wick sweep setup currently live on this asset (may be unqualified) */
  pattern: Signal | null;
  /** SnR setup currently live on this asset (may be unqualified) */
  setup: Signal | null;
  /** best-of-best candidate currently live; qualified = A+ */
  best: Signal | null;
  /** backtest support for calls like this one on this asset */
  support: BacktestBucket | null;
  supportLabel: string;
  breakEven: number;
  patternWinRate: BacktestBucket | null;
  setupWinRate: BacktestBucket | null;
  grade: Grade;
  /** true when the board would tell you to take this trade now, in the current mode */
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
  mode: Mode,
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
    setup: null,
    best: null,
    support: null,
    supportLabel: "",
    breakEven: 1 / (1 + cfg.payout),
    patternWinRate: null,
    setupWinRate: null,
    grade: "-",
    actionable: false,
    rank: -1000,
    reason: "collecting candles",
  };
  if (closed.length < 30) return base;

  const a = analyze(closed, cfg);
  const { prediction, predictionBacktest: pbt, sentiment } = a;
  const fresh = (s: Signal | null) => (s && now < s.expiryTime ? s : null);
  const pattern = fresh(a.signal);
  const setup = fresh(a.setup);
  const best = fresh(a.best);

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

  let modelGrade: Grade = "-";
  let reason = `model leans ${prediction.direction === "CALL" ? "UP" : "DOWN"} at ${Math.round(prediction.probability * 100)}%, below your minimum`;
  if (prediction.qualified) {
    if (supported) {
      modelGrade = "A";
      reason = `${Math.round(prediction.probability * 100)}% call and ${supportLabel} won ${Math.round(support.winRate * 100)}% here (${support.signals} trades)`;
    } else if (!enough) {
      modelGrade = "B";
      reason = `${Math.round(prediction.probability * 100)}% call, but only ${support.signals} graded trades on this asset so far`;
    } else {
      modelGrade = "C";
      reason = `${Math.round(prediction.probability * 100)}% call, but ${supportLabel} only won ${Math.round(support.winRate * 100)}% here, below break-even`;
    }
  }

  // strongest qualified rule-based setup live right now (wick sweep or SnR)
  const rule = [pattern, setup]
    .filter((s): s is Signal => Boolean(s?.qualified))
    .sort((x, y) => y.score - x.score)[0] ?? null;
  const aplus = Boolean(best?.qualified);
  if (aplus) {
    reason = `A+ ${best!.setupLabel}: confluence ${best!.score}/10, model agrees, not counter-trend`;
  } else if (rule) {
    reason = `${rule.setupLabel}, score ${rule.score}/10 (${rule.direction === "PUT" ? "SELL" : "BUY"})`;
    const failed = best?.gates?.filter((g) => !g.pass).map((g) => g.label.toLowerCase());
    if (failed?.length) reason += ` · not A+: ${failed.join(", ")}`;
  }

  const p = prediction.probability;
  let rank: number;
  if (aplus) rank = 2000 + best!.score * 10;
  else if (rule) rank = 1000 + rule.score * 10;
  else if (modelGrade === "A") rank = 300 + p * 100 + (support.winRate - be) * 200;
  else if (modelGrade === "B") rank = 200 + p * 100;
  else if (modelGrade === "C") rank = 100 + p * 100;
  else rank = p * 100;
  if (!live) rank -= 5000;

  const actionableIn: Record<Mode, boolean> = {
    best: aplus,
    setups: Boolean(setup?.qualified),
    pattern: Boolean(pattern?.qualified),
    every: Boolean(pattern?.qualified) || modelGrade === "A" || modelGrade === "B",
  };

  return {
    ...base,
    sentiment,
    direction: aplus ? best!.direction : rule ? rule.direction : prediction.direction,
    probability: p,
    strength: prediction.strength,
    qualified: prediction.qualified,
    entryTime: prediction.entryTime,
    expiryTime: prediction.expiryTime,
    pattern,
    setup,
    best,
    support,
    supportLabel,
    breakEven: be,
    patternWinRate: a.backtest.all.signals ? a.backtest.all : null,
    setupWinRate: a.setupBacktest.all.signals ? a.setupBacktest.all : null,
    grade: aplus ? "A+" : modelGrade,
    actionable: live && actionableIn[mode],
    rank,
    reason,
  };
}

export function rankRows(rows: ScanRow[]): ScanRow[] {
  return [...rows].sort((a, b) => b.rank - a.rank || b.probability - a.probability);
}
