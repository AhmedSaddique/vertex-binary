import {
  Candle,
  Check,
  DEFAULT_CONFIG,
  Direction,
  PatternConfig,
  Sentiment,
  Signal,
} from "./types";

export const body = (c: Candle) => Math.abs(c.close - c.open);
export const range = (c: Candle) => c.high - c.low;
export const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
export const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
export const isBull = (c: Candle) => c.close > c.open;
export const isBear = (c: Candle) => c.close < c.open;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Wilder RSI on the closes of the given candles (last value). */
export function rsi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/**
 * Higher-timeframe context: linear-regression slope of the last `n` closes,
 * normalised by average range. This approximates the 5m/15m direction the
 * document asks you to check, without needing a second data feed.
 */
export function sentimentOf(candles: Candle[], n = 30): Sentiment {
  const xs = candles.slice(-n);
  if (xs.length < 10) return "RANGING";
  const avgRange = mean(xs.map(range)) || 1e-9;
  const len = xs.length;
  const mx = (len - 1) / 2;
  const my = mean(xs.map((c) => c.close));
  let num = 0;
  let den = 0;
  xs.forEach((c, i) => {
    num += (i - mx) * (c.close - my);
    den += (i - mx) ** 2;
  });
  const slope = den === 0 ? 0 : num / den; // price per candle
  const totalMove = (slope * (len - 1)) / avgRange; // in ranges over the window
  if (totalMove > 1.2) return "BULLISH";
  if (totalMove < -1.2) return "BEARISH";
  return "RANGING";
}

export interface SessionInfo {
  name: string;
  /** 0 (dead) .. 1 (best liquidity) */
  quality: number;
}

export function sessionOf(timeMs: number): SessionInfo {
  const h = new Date(timeMs).getUTCHours();
  if (h >= 12 && h < 16) return { name: "London/NY overlap", quality: 1 };
  if (h >= 7 && h < 12) return { name: "London", quality: 0.9 };
  if (h >= 16 && h < 20) return { name: "New York", quality: 0.6 };
  if (h >= 0 && h < 7) return { name: "Asia", quality: 0.35 };
  return { name: "Quiet hours", quality: 0 };
}

interface Match {
  direction: Direction;
  liquidityLevel: number;
  sweepDistance: number;
  wickRatios: [number, number];
}

function matchPattern(
  c1: Candle,
  c2: Candle,
  c3: Candle,
  tol: number,
  cfg: PatternConfig,
): Match | null {
  const notDoji = (c: Candle) => range(c) > 0 && body(c) >= cfg.minBodyRatio * range(c);
  if (!notDoji(c1) || !notDoji(c2) || !notDoji(c3)) return null;

  // Bearish setup: three green candles, upper wicks on C1/C2, C3 sweeps the wick highs -> PUT
  if (isBull(c1) && isBull(c2) && isBull(c3)) {
    const w1 = upperWick(c1) / range(c1);
    const w2 = upperWick(c2) / range(c2);
    if (w1 < cfg.minWickRatio || w2 < cfg.minWickRatio) return null;
    if (c2.high < c1.high - tol) return null;
    const liquidityLevel = Math.max(c1.high, c2.high);
    if (c3.high <= liquidityLevel) return null;
    return {
      direction: "PUT",
      liquidityLevel,
      sweepDistance: c3.high - liquidityLevel,
      wickRatios: [w1, w2],
    };
  }

  // Bullish setup: three red candles, lower wicks on C1/C2, C3 sweeps the wick lows -> CALL
  if (isBear(c1) && isBear(c2) && isBear(c3)) {
    const w1 = lowerWick(c1) / range(c1);
    const w2 = lowerWick(c2) / range(c2);
    if (w1 < cfg.minWickRatio || w2 < cfg.minWickRatio) return null;
    if (c2.low > c1.low + tol) return null;
    const liquidityLevel = Math.min(c1.low, c2.low);
    if (c3.low >= liquidityLevel) return null;
    return {
      direction: "CALL",
      liquidityLevel,
      sweepDistance: liquidityLevel - c3.low,
      wickRatios: [w1, w2],
    };
  }
  return null;
}

/**
 * Evaluate the Wick Liquidity Sweep Reversal at position `index` (the C3 candle).
 * `candles` must be closed candles in ascending order. Defaults to the latest candle.
 * Returns null when the exact rules are not met. When they are met, the signal
 * carries a 0-10 confidence score built from the document's optional filters.
 */
export function detectSignal(
  candles: Candle[],
  cfg: PatternConfig = DEFAULT_CONFIG,
  index = candles.length - 1,
): Signal | null {
  const i = index;
  if (i < 2 || i >= candles.length) return null;
  const c1 = candles[i - 2];
  const c2 = candles[i - 1];
  const c3 = candles[i];
  const history = candles.slice(0, i - 2); // everything before C1
  if (history.length < 5) return null;

  const rangeWindow = history.slice(-20);
  const avgRange = mean(rangeWindow.map(range)) || range(c3) || 1e-9;
  const tol = cfg.equalTolerance * avgRange;

  const m = matchPattern(c1, c2, c3, tol, cfg);
  if (!m) return null;

  const bodyWindow = history.slice(-cfg.avgBodyLookback);
  const avgBody = mean(bodyWindow.map(body)) || 1e-9;
  const c3Ratio = body(c3) / avgBody;
  if (cfg.requireStrongC3 && c3Ratio < 1) return null;

  const checks: Check[] = [];

  // 1. Wick quality (C1 & C2 wicks clear and visible)
  {
    const r = mean(m.wickRatios);
    const points = clamp((r - cfg.minWickRatio) / 0.3, 0, 1) * 2;
    checks.push({
      id: "wicks",
      label: "Wick quality (C1, C2)",
      pass: points >= 1,
      points,
      max: 2,
      detail: `wicks ${Math.round(m.wickRatios[0] * 100)}% / ${Math.round(m.wickRatios[1] * 100)}% of range`,
    });
  }

  // 2. C3 strength: strong but not a news-sized candle
  {
    let points: number;
    if (c3Ratio < 1) points = 0;
    else if (c3Ratio <= 2) points = 1 + (c3Ratio - 1);
    else if (c3Ratio <= 3) points = 2;
    else if (c3Ratio <= 4) points = 1;
    else points = 0.5;
    checks.push({
      id: "c3",
      label: "C3 strength",
      pass: c3Ratio >= 1 && c3Ratio <= 3,
      points,
      max: 2,
      detail: `C3 body ${c3Ratio.toFixed(2)}x avg body${c3Ratio > 3 ? " (news-sized, weaker)" : ""}`,
    });
  }

  // 3. Sweep depth: clearly beyond the wick tips, but not a runaway breakout
  {
    const depth = m.sweepDistance / avgRange;
    let points: number;
    if (depth < 0.05) points = 0.5;
    else if (depth <= 1) points = 1;
    else if (depth <= 2) points = 0.5;
    else points = 0;
    checks.push({
      id: "sweep",
      label: "Liquidity sweep depth",
      pass: depth >= 0.05 && depth <= 1.5,
      points,
      max: 1,
      detail: `swept ${depth.toFixed(2)} avg ranges beyond wick tips`,
    });
  }

  // 4. Higher-timeframe context: agree with trend or ranging market
  const sentiment = sentimentOf(candles.slice(0, i + 1));
  {
    const agrees =
      (m.direction === "PUT" && sentiment === "BEARISH") ||
      (m.direction === "CALL" && sentiment === "BULLISH");
    const points = agrees ? 2 : sentiment === "RANGING" ? 1.5 : 0;
    checks.push({
      id: "htf",
      label: "Higher-timeframe context",
      pass: points > 0,
      points,
      max: 2,
      detail: agrees
        ? `trade agrees with ${sentiment.toLowerCase()} context`
        : sentiment === "RANGING"
          ? "market is ranging"
          : `against a ${sentiment.toLowerCase()} trend (risky)`,
    });
  }

  // 5. Location: C3 sweeps into a recent swing level
  {
    const lookback = history.slice(-60);
    let points = 0;
    let detail = "not enough history";
    if (lookback.length >= 20) {
      const level =
        m.direction === "PUT"
          ? Math.max(...lookback.map((c) => c.high))
          : Math.min(...lookback.map((c) => c.low));
      const dist =
        m.direction === "PUT" ? (c3.high - level) / avgRange : (level - c3.low) / avgRange;
      if (dist >= -0.5 && dist <= 1) {
        points = 1.5;
        detail = `C3 swept into the ${lookback.length}-candle ${m.direction === "PUT" ? "high" : "low"} (${level})`;
      } else if (dist < -0.5) {
        detail = "C3 is in open space, no nearby level";
      } else {
        detail = "C3 broke far through the level (breakout risk)";
      }
    }
    checks.push({
      id: "level",
      label: "Support / resistance location",
      pass: points > 0,
      points,
      max: 1.5,
      detail,
    });
  }

  // 6. Session
  {
    const s = sessionOf(c3.time);
    checks.push({
      id: "session",
      label: "Trading session",
      pass: s.quality >= 0.5,
      points: s.quality,
      max: 1,
      detail: s.name,
    });
  }

  // 7. Over-extension (RSI at C3 close)
  {
    const r = rsi(candles.slice(Math.max(0, i - 60), i + 1));
    let points = 0;
    if (r !== null) {
      if (m.direction === "PUT") points = r >= 70 ? 1 : r >= 60 ? 0.5 : 0;
      else points = r <= 30 ? 1 : r <= 40 ? 0.5 : 0;
    }
    checks.push({
      id: "rsi",
      label: "Over-extension (RSI 14)",
      pass: points >= 0.5,
      points,
      max: 1,
      detail: r === null ? "n/a" : `RSI ${r.toFixed(1)}`,
    });
  }

  const raw = checks.reduce((a, c) => a + c.points, 0);
  const score = Math.round(clamp(raw, 0, 10) * 10) / 10;
  const strength = clamp(Math.ceil(score / 2), 1, 5);

  return {
    direction: m.direction,
    c3Time: c3.time,
    entryTime: c3.time + 60_000,
    expiryTime: c3.time + 120_000,
    c1,
    c2,
    c3,
    liquidityLevel: m.liquidityLevel,
    sweepDepth: m.sweepDistance / avgRange,
    score,
    strength,
    checks,
    sentiment,
    qualified: score >= cfg.minScore,
  };
}
