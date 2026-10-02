import { outcomeOf, summarize } from "./backtest";
import { detectSignal } from "./pattern";
import { detectSetups, SETUP_MIN_HISTORY, SETUP_NAMES, SetupContext } from "./snr";
import { BacktestResult, BacktestTrade, Check, Direction, Signal, StrategyId } from "./types";

/**
 * Best of best: an A+ trade is a rule-based setup (wick sweep or SnR setup 1-3) where
 * every independent check lines up at once:
 *
 *  1. the setup itself scores 8/10 or more (or your minimum, if higher)
 *  2. it does not fight the 30-candle trend
 *  3. the every-candle model, which knows nothing about the setup, calls the same direction
 *  4. no other setup points the opposite way on the same candle
 *  5. that setup has not been losing on this pair: once it has 20+ graded trades here,
 *     its walk-forward win rate must be above break-even
 *
 * Expect very few signals. The backtest grades both every qualified setup and the A+
 * subset, so you can see whether the filter actually earns its keep on this pair.
 */

export const STRATEGY_NAMES: Record<StrategyId, string> = {
  wick: "Wick liquidity sweep",
  ...SETUP_NAMES,
};

export const BEST_MIN_SCORE = 8;
const MIN_RECORD = 20;

export interface ModelCall {
  direction: Direction;
  probability: number;
}

interface Tally {
  wins: number;
  losses: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const word = (d: Direction) => (d === "CALL" ? "UP" : "DOWN");

function judge(
  candidates: Signal[],
  call: ModelCall | undefined,
  tallies: Map<StrategyId, Tally>,
  breakEven: number,
  minScore: number,
): Signal {
  const top = candidates[0];
  const strategy = top.strategy ?? "wick";
  const agreeing = candidates.filter((s) => s.direction === top.direction);
  const opposing = candidates.filter((s) => s.direction !== top.direction);
  const up = top.direction === "CALL";
  const counter = (up && top.sentiment === "BEARISH") || (!up && top.sentiment === "BULLISH");
  const modelAgrees = call?.direction === top.direction;
  const t = tallies.get(strategy) ?? { wins: 0, losses: 0 };
  const decided = t.wins + t.losses;
  const rate = decided ? t.wins / decided : 0;
  const proven = decided >= MIN_RECORD;

  const gate = (id: string, label: string, pass: boolean, detail: string): Check => ({
    id,
    label,
    pass,
    points: 0,
    max: 0,
    detail,
  });
  const gates: Check[] = [
    gate(
      "setup",
      "Rule-based setup fired",
      true,
      agreeing.map((s) => `${s.setupLabel} ${s.score}/10`).join(" + "),
    ),
    gate("score", `Setup score ≥ ${minScore}`, top.score >= minScore, `${top.setupLabel} scored ${top.score}/10`),
    gate(
      "trend",
      "Not against the trend",
      !counter,
      counter
        ? `${word(top.direction)} trade into a ${top.sentiment.toLowerCase()} market`
        : `${top.sentiment.toLowerCase()} 30-candle context`,
    ),
    gate(
      "model",
      "Every-candle model agrees",
      modelAgrees,
      call ? `model calls ${word(call.direction)} at ${pct(call.probability)}` : "no model call yet",
    ),
    gate(
      "conflict",
      "No setup pointing the other way",
      opposing.length === 0,
      opposing.length ? opposing.map((s) => `${s.setupLabel} says ${word(s.direction)}`).join(", ") : "all setups agree",
    ),
    gate(
      "record",
      "Setup's own record on this pair",
      !proven || rate > breakEven,
      proven
        ? `${pct(rate)} over ${decided} graded trades vs break-even ${pct(breakEven)}`
        : `unproven here: ${decided} graded trade${decided === 1 ? "" : "s"} so far`,
    ),
  ];

  const confluence =
    top.score +
    0.5 * (agreeing.length - 1) +
    (modelAgrees && call ? clamp((call.probability - 0.5) * 10, 0, 1) : 0) +
    (proven && rate > breakEven ? 0.5 : 0);
  const score = Math.round(clamp(confluence, 0, 10) * 10) / 10;
  return {
    ...top,
    score,
    strength: clamp(Math.ceil(score / 2), 1, 5),
    qualified: gates.every((g) => g.pass),
    gates,
  };
}

/**
 * Walks every closed candle in order. Per-setup track records only ever include trades
 * whose result was known before the candle being judged, so the A+ backtest is walk-forward.
 */
export function bestOfBest(
  ctx: SetupContext,
  calls: Map<number, ModelCall>,
): { best: Signal | null; backtest: BacktestResult } {
  const { candles, cfg } = ctx;
  const n = candles.length;
  const breakEven = 1 / (1 + cfg.payout);
  const minScore = Math.max(cfg.minScore, BEST_MIN_SCORE);
  const tallies = new Map<StrategyId, Tally>();
  const trades: BacktestTrade[] = [];
  let best: Signal | null = null;

  for (let i = SETUP_MIN_HISTORY; i < n; i++) {
    const wick = detectSignal(candles, cfg, i);
    const candidates = [...(wick ? [wick] : []), ...detectSetups(ctx, i)]
      .filter((s) => s.qualified)
      .sort((a, b) => b.score - a.score);
    if (candidates.length === 0) continue;

    const pick = judge(candidates, calls.get(candidates[0].entryTime), tallies, breakEven, minScore);
    if (i === n - 1) best = pick;

    const next = candles[i + 1];
    if (!next || next.time - candles[i].time > 90_000) continue;
    trades.push({
      entryTime: pick.entryTime,
      direction: pick.direction,
      score: pick.score,
      strength: pick.strength,
      qualified: pick.qualified,
      outcome: outcomeOf(pick.direction, next),
      c4: next,
      strategy: pick.strategy,
    });
    // only now does the result of candle i+1 become part of each setup's record
    for (const s of candidates) {
      const id = s.strategy ?? "wick";
      const t = tallies.get(id) ?? { wins: 0, losses: 0 };
      const o = outcomeOf(s.direction, next);
      if (o === "WIN") t.wins++;
      else if (o === "LOSS") t.losses++;
      tallies.set(id, t);
    }
  }

  return {
    best,
    backtest: summarize(
      candles,
      cfg,
      trades,
      { all: "Every qualified setup", qualified: "A+ only" },
      STRATEGY_NAMES,
    ),
  };
}
