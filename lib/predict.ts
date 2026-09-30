import { sessionOf } from "./pattern";
import {
  BacktestBucket,
  BacktestResult,
  BacktestTrade,
  Candle,
  DEFAULT_CONFIG,
  Direction,
  PatternConfig,
} from "./types";

/**
 * Every-candle mode: predicts the direction of the NEXT 1-minute candle on every
 * candle close, using an adaptive ensemble of simple voters (momentum, mean
 * reversion, RSI, EMA trend, Bollinger, wick rejection, exhaustion, streaks).
 *
 * Each voter's recent accuracy is tracked walk-forward with exponential decay;
 * votes are combined with log-odds weights, so voters that have been working
 * lately count more and voters that have been wrong count against their vote.
 * The backtest here is strictly walk-forward: the weights used to predict
 * candle i+1 only ever see candles <= i.
 *
 * Honest expectation: single-candle direction is close to a coin flip. The
 * backtest buckets show whether higher-probability calls beat break-even.
 */

export interface Vote {
  id: string;
  label: string;
  /** +1 up, -1 down, 0 abstain */
  vote: -1 | 0 | 1;
  /** recent accuracy of this voter (0-1) */
  accuracy: number;
  /** weight applied to the vote (log-odds) */
  weight: number;
  detail: string;
}

export interface Prediction {
  direction: Direction;
  /** probability of the predicted direction (0.5 - 1) */
  probability: number;
  /** open time of the candle being predicted (= entry) */
  entryTime: number;
  expiryTime: number;
  votes: Vote[];
  /** probability * 10, comparable to the pattern confidence score */
  score: number;
  /** 1-5 from probability: <55% =1, <60% =2, <65% =3, <70% =4, else 5 */
  strength: number;
  qualified: boolean;
}

interface Indicators {
  ema5: number[];
  ema20: number[];
  rsi: (number | null)[];
  mean20: number[];
  std20: number[];
  avgBody10: number[];
}

const DECAY = 0.993; // effective memory ~140 candles

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function indicators(c: Candle[]): Indicators {
  const closes = c.map((x) => x.close);
  const ema5 = ema(closes, 5);
  const ema20 = ema(closes, 20);
  const rsi: (number | null)[] = new Array(c.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < c.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= 14) {
      gain += Math.max(d, 0);
      loss += Math.max(-d, 0);
      if (i === 14) {
        gain /= 14;
        loss /= 14;
        rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * 13 + Math.max(d, 0)) / 14;
      loss = (loss * 13 + Math.max(-d, 0)) / 14;
      rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  const mean20: number[] = [];
  const std20: number[] = [];
  const avgBody10: number[] = [];
  let sum = 0;
  let sumSq = 0;
  let bodySum = 0;
  for (let i = 0; i < c.length; i++) {
    sum += closes[i];
    sumSq += closes[i] ** 2;
    bodySum += Math.abs(c[i].close - c[i].open);
    if (i >= 20) {
      sum -= closes[i - 20];
      sumSq -= closes[i - 20] ** 2;
    }
    if (i >= 10) bodySum -= Math.abs(c[i - 10].close - c[i - 10].open);
    const n = Math.min(i + 1, 20);
    const m = sum / n;
    mean20.push(m);
    std20.push(Math.sqrt(Math.max(0, sumSq / n - m * m)));
    avgBody10.push(bodySum / Math.min(i + 1, 10));
  }
  return { ema5, ema20, rsi, mean20, std20, avgBody10 };
}

interface VoterDef {
  id: string;
  label: string;
  fn: (c: Candle[], i: number, ind: Indicators) => { vote: -1 | 0 | 1; detail: string };
}

const up = (x: Candle) => x.close > x.open;
const dn = (x: Candle) => x.close < x.open;
const range = (x: Candle) => x.high - x.low;

const VOTERS: VoterDef[] = [
  {
    id: "momentum",
    label: "Momentum (continue last candle)",
    fn: (c, i) => {
      const x = c[i];
      if (up(x)) return { vote: 1, detail: "last candle green" };
      if (dn(x)) return { vote: -1, detail: "last candle red" };
      return { vote: 0, detail: "doji" };
    },
  },
  {
    id: "reversion",
    label: "Mean reversion (fade last candle)",
    fn: (c, i) => {
      const x = c[i];
      if (up(x)) return { vote: -1, detail: "fade green candle" };
      if (dn(x)) return { vote: 1, detail: "fade red candle" };
      return { vote: 0, detail: "doji" };
    },
  },
  {
    id: "streak3",
    label: "Streak exhaustion (3+ same colour)",
    fn: (c, i) => {
      if (i < 2) return { vote: 0, detail: "n/a" };
      if (up(c[i]) && up(c[i - 1]) && up(c[i - 2])) return { vote: -1, detail: "3 green in a row" };
      if (dn(c[i]) && dn(c[i - 1]) && dn(c[i - 2])) return { vote: 1, detail: "3 red in a row" };
      return { vote: 0, detail: "no streak" };
    },
  },
  {
    id: "rsi",
    label: "RSI 14 extremes",
    fn: (c, i, ind) => {
      const r = ind.rsi[i];
      if (r === null) return { vote: 0, detail: "n/a" };
      if (r >= 70) return { vote: -1, detail: `RSI ${r.toFixed(0)} overbought` };
      if (r <= 30) return { vote: 1, detail: `RSI ${r.toFixed(0)} oversold` };
      return { vote: 0, detail: `RSI ${r.toFixed(0)} neutral` };
    },
  },
  {
    id: "ema",
    label: "EMA 5/20 trend",
    fn: (c, i, ind) => {
      const d = ind.ema5[i] - ind.ema20[i];
      const tol = ind.std20[i] * 0.05;
      if (d > tol) return { vote: 1, detail: "EMA5 above EMA20" };
      if (d < -tol) return { vote: -1, detail: "EMA5 below EMA20" };
      return { vote: 0, detail: "EMAs flat" };
    },
  },
  {
    id: "bollinger",
    label: "Bollinger band touch",
    fn: (c, i, ind) => {
      const s = ind.std20[i];
      if (s === 0) return { vote: 0, detail: "n/a" };
      const z = (c[i].close - ind.mean20[i]) / s;
      if (z >= 2) return { vote: -1, detail: `close ${z.toFixed(1)}σ above mean` };
      if (z <= -2) return { vote: 1, detail: `close ${z.toFixed(1)}σ below mean` };
      return { vote: 0, detail: `z ${z.toFixed(1)}` };
    },
  },
  {
    id: "wick",
    label: "Wick rejection",
    fn: (c, i) => {
      const x = c[i];
      const r = range(x);
      if (r <= 0) return { vote: 0, detail: "n/a" };
      const upper = (x.high - Math.max(x.open, x.close)) / r;
      const lower = (Math.min(x.open, x.close) - x.low) / r;
      if (upper >= 0.6) return { vote: -1, detail: `upper wick ${Math.round(upper * 100)}%` };
      if (lower >= 0.6) return { vote: 1, detail: `lower wick ${Math.round(lower * 100)}%` };
      return { vote: 0, detail: "no rejection wick" };
    },
  },
  {
    id: "exhaustion",
    label: "Big-candle exhaustion",
    fn: (c, i, ind) => {
      const x = c[i];
      const body = Math.abs(x.close - x.open);
      const avg = ind.avgBody10[i] || 1e-9;
      if (body >= 2.5 * avg) {
        return up(x)
          ? { vote: -1, detail: `green body ${(body / avg).toFixed(1)}x avg` }
          : { vote: 1, detail: `red body ${(body / avg).toFixed(1)}x avg` };
      }
      return { vote: 0, detail: `body ${(body / avg).toFixed(1)}x avg` };
    },
  },
  {
    id: "closepos",
    label: "Close position in range",
    fn: (c, i) => {
      const x = c[i];
      const r = range(x);
      if (r <= 0) return { vote: 0, detail: "n/a" };
      const pos = (x.close - x.low) / r;
      if (pos >= 0.85) return { vote: 1, detail: "closed at the high" };
      if (pos <= 0.15) return { vote: -1, detail: "closed at the low" };
      return { vote: 0, detail: `closed ${Math.round(pos * 100)}% up the range` };
    },
  },
  {
    id: "slope10",
    label: "10-candle slope",
    fn: (c, i, ind) => {
      if (i < 10) return { vote: 0, detail: "n/a" };
      const d = c[i].close - c[i - 10].close;
      const tol = ind.std20[i] * 0.3;
      if (d > tol) return { vote: 1, detail: "rising over 10 candles" };
      if (d < -tol) return { vote: -1, detail: "falling over 10 candles" };
      return { vote: 0, detail: "flat over 10 candles" };
    },
  },
];

interface Counter {
  hit: number;
  n: number;
}

function weightOf(k: Counter): { acc: number; w: number } {
  const acc = (k.hit + 1) / (k.n + 2); // Laplace smoothing
  const raw = Math.log(acc / (1 - acc));
  const shrink = Math.min(1, k.n / 30); // trust a voter only once it has a record
  return { acc, w: raw * shrink };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function strengthOf(p: number): number {
  if (p < 0.55) return 1;
  if (p < 0.6) return 2;
  if (p < 0.65) return 3;
  if (p < 0.7) return 4;
  return 5;
}

function bucket(label: string, trades: BacktestTrade[]): BacktestBucket {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const ties = trades.length - wins - losses;
  const decided = wins + losses;
  return { label, signals: trades.length, wins, losses, ties, winRate: decided === 0 ? 0 : wins / decided };
}

const STRENGTH_LABELS = ["<55%", "55-60%", "60-65%", "65-70%", "≥70%"];

/**
 * Walk the closed candles, grade every prediction on the following candle, and
 * return the prediction for the candle that opens after the last closed one.
 */
export function predictNext(
  candles: Candle[],
  cfg: PatternConfig = DEFAULT_CONFIG,
): { prediction: Prediction | null; backtest: BacktestResult } {
  const n = candles.length;
  const ind = n > 0 ? indicators(candles) : null;
  const counters: Counter[] = VOTERS.map(() => ({ hit: 0, n: 0 }));
  const trades: BacktestTrade[] = [];
  const WARMUP = 25;

  // Calibration: voters are correlated, so the raw log-odds sum overstates
  // confidence. We bucket predictions by |sum| and report, as the probability,
  // how often predictions in that bucket have actually been right so far
  // (shrunk toward a tempered sigmoid while the bucket is small). If the model
  // has no edge on this pair, the probabilities honestly collapse toward 50%.
  const BIN_EDGES = [0.25, 0.5, 1, 2];
  const bins: Counter[] = Array.from({ length: BIN_EDGES.length + 1 }, () => ({ hit: 0, n: 0 }));
  const binOf = (a: number) => {
    const k = BIN_EDGES.findIndex((e) => a < e);
    return k === -1 ? BIN_EDGES.length : k;
  };
  const calibrate = (s: number) => {
    const a = Math.abs(s);
    const rawP = sigmoid(a / 2);
    const b = bins[binOf(a)];
    const p = (b.hit + rawP * 20) / (b.n + 20);
    return Math.min(0.95, Math.max(0.5, p));
  };

  const evaluate = (i: number) => {
    const votes: Vote[] = VOTERS.map((v, k) => {
      const r = v.fn(candles, i, ind!);
      const { acc, w } = weightOf(counters[k]);
      return { id: v.id, label: v.label, vote: r.vote, accuracy: acc, weight: w, detail: r.detail };
    });
    const s = votes.reduce((a, v) => a + v.vote * v.weight, 0);
    const direction: Direction = s >= 0 ? "CALL" : "PUT";
    return { votes, direction, probability: calibrate(s), s };
  };

  for (let i = WARMUP; i < n - 1; i++) {
    const { votes, direction, probability, s } = evaluate(i);
    const next = candles[i + 1];
    if (next.time - candles[i].time > 90_000) continue; // feed gap
    const actual = next.close > next.open ? 1 : next.close < next.open ? -1 : 0;
    const score = Math.round(probability * 100) / 10;
    const win = (direction === "CALL") === (actual > 0);
    trades.push({
      entryTime: next.time,
      direction,
      score,
      strength: strengthOf(probability),
      qualified: score >= cfg.minScore,
      outcome: actual === 0 ? "TIE" : win ? "WIN" : "LOSS",
      c4: next,
    });
    if (actual !== 0) {
      votes.forEach((v, k) => {
        if (v.vote === 0) return;
        counters[k].n = counters[k].n * DECAY + 1;
        counters[k].hit = counters[k].hit * DECAY + (v.vote === actual ? 1 : 0);
      });
      const b = bins[binOf(Math.abs(s))];
      b.n++;
      if (win) b.hit++;
    }
  }

  let prediction: Prediction | null = null;
  if (n > WARMUP) {
    const i = n - 1;
    const { votes, direction, probability } = evaluate(i);
    const score = Math.round(probability * 100) / 10;
    prediction = {
      direction,
      probability,
      entryTime: candles[i].time + 60_000,
      expiryTime: candles[i].time + 120_000,
      votes,
      score,
      strength: strengthOf(probability),
      qualified: score >= cfg.minScore,
    };
  }

  const sessionNames = Array.from(new Set(trades.map((t) => sessionOf(t.entryTime).name)));
  const backtest: BacktestResult = {
    candles: n,
    from: candles[0]?.time ?? 0,
    to: candles[n - 1]?.time ?? 0,
    breakEven: 1 / (1 + cfg.payout),
    all: bucket("Every candle", trades),
    qualified: bucket(`Probability >= ${cfg.minScore * 10}%`, trades.filter((t) => t.qualified)),
    byStrength: [1, 2, 3, 4, 5].map((s) =>
      bucket(STRENGTH_LABELS[s - 1], trades.filter((t) => t.strength === s)),
    ),
    bySession: sessionNames.map((name) =>
      bucket(name, trades.filter((t) => sessionOf(t.entryTime).name === name)),
    ),
    trades: trades.slice(-100),
  };
  return { prediction, backtest };
}
