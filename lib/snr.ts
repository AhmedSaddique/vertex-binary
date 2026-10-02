import { outcomeOf, summarize } from "./backtest";
import { body, isBear, isBull, lowerWick, mean, range, rsi, sentimentOf, sessionOf, upperWick } from "./pattern";
import { ema } from "./predict";
import { BacktestResult, BacktestTrade, Candle, Check, DEFAULT_CONFIG, Direction, PatternConfig, Signal } from "./types";

/**
 * Support / resistance setups, traded on the next 1-minute candle:
 *
 * Setup 1  Trend + SnR rejection. Uptrend + support (downtrend + resistance); a rejection
 *          candle closes at the level and a green (red) candle forms there -> BUY at
 *          support / SELL at resistance on the next candle.
 * Setup 2  Trend + SnR + trendline. A support (resistance) level meets a rising (falling)
 *          trendline; the rejection candle closes above (below) both -> BUY in the uptrend /
 *          SELL in the downtrend on the next candle.
 * Setup 3  Breakout + retest. A strong momentum candle breaks a strong level, price comes
 *          back to touch it and a reversal candle forms -> BUY after a resistance break,
 *          SELL after a support break, on the next candle (only AFTER the retest).
 *
 * Closed candles only. Levels and trendlines are built from swing points that were
 * confirmed before the signal candle, so the backtest has no look-ahead.
 */

export type SetupId = "snr1" | "snr2" | "snr3";

export const SETUP_NAMES: Record<SetupId, string> = {
  snr1: "Setup 1 · Trend + SnR rejection",
  snr2: "Setup 2 · SnR + trendline",
  snr3: "Setup 3 · Breakout + retest",
};

/** a swing high / low must be the extreme of this many candles on each side */
const PIVOT = 3;
const LEVEL_LOOKBACK = 150;
const TRENDLINE_LOOKBACK = 100;
/** a retest has to complete within this many candles of the breakout */
const RETEST_WINDOW = 15;
export const SETUP_MIN_HISTORY = 60;

interface Level {
  price: number;
  /** swing highs / lows that formed the level */
  touches: number;
}

export interface SetupContext {
  candles: Candle[];
  cfg: PatternConfig;
  /** mean range / body of the candles before i (exclusive) */
  avgRange: number[];
  avgBody: number[];
  ema20: number[];
  ema50: number[];
  swingHigh: boolean[];
  swingLow: boolean[];
  levels: Map<number, Level[]>;
  found: Map<number, Signal[]>;
}

/** Precompute everything the setups need once per series, so the backtest stays linear. */
export function setupContext(candles: Candle[], cfg: PatternConfig = DEFAULT_CONFIG): SetupContext {
  const n = candles.length;
  const avgRange: number[] = new Array(n);
  const avgBody: number[] = new Array(n);
  let rs = 0;
  let bs = 0;
  for (let i = 0; i < n; i++) {
    const rn = Math.min(i, 20);
    const bn = Math.min(i, 10);
    avgRange[i] = (rn ? rs / rn : range(candles[i])) || 1e-9;
    avgBody[i] = (bn ? bs / bn : body(candles[i])) || 1e-9;
    rs += range(candles[i]);
    bs += body(candles[i]);
    if (i >= 20) rs -= range(candles[i - 20]);
    if (i >= 10) bs -= body(candles[i - 10]);
  }

  const swingHigh: boolean[] = new Array(n).fill(false);
  const swingLow: boolean[] = new Array(n).fill(false);
  for (let j = PIVOT; j < n - PIVOT; j++) {
    let hi = true;
    let lo = true;
    for (let k = j - PIVOT; k <= j + PIVOT && (hi || lo); k++) {
      if (k === j) continue;
      // equal extremes: only the first one counts as the swing point
      if (k < j ? candles[k].high >= candles[j].high : candles[k].high > candles[j].high) hi = false;
      if (k < j ? candles[k].low <= candles[j].low : candles[k].low < candles[j].low) lo = false;
    }
    swingHigh[j] = hi;
    swingLow[j] = lo;
  }

  const closes = candles.map((c) => c.close);
  return {
    candles,
    cfg,
    avgRange,
    avgBody,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    swingHigh,
    swingLow,
    levels: new Map(),
    found: new Map(),
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// direction helpers: s = +1 for BUY at support, -1 for SELL at resistance
type Side = 1 | -1;
/** the candle extreme that tests the level (low for a BUY, high for a SELL) */
const extreme = (c: Candle, s: Side) => (s > 0 ? c.low : c.high);
const farWick = (c: Candle, s: Side) => (s > 0 ? lowerWick(c) : upperWick(c));
const withTrade = (c: Candle, s: Side) => (s > 0 ? isBull(c) : isBear(c));
/** 0 = closed at the extreme against the trade, 1 = closed at the extreme with it */
const closePos = (c: Candle, s: Side) => {
  const r = range(c);
  if (r <= 0) return 0.5;
  return s > 0 ? (c.close - c.low) / r : (c.high - c.close) / r;
};
const levelPoints = (touches: number, max: number) => max * (touches >= 4 ? 1 : touches === 3 ? 0.75 : 0.5);

function fmt(p: number) {
  const a = Math.abs(p);
  return p.toFixed(a > 1000 ? 1 : a > 10 ? 3 : 5);
}

/**
 * Strong support / resistance levels known before candle i: swing highs and lows of the
 * last LEVEL_LOOKBACK candles clustered by price; a level needs 2+ swing points.
 * A level can act as support or resistance depending on which side price is.
 */
function levelsBefore(ctx: SetupContext, i: number): Level[] {
  const cached = ctx.levels.get(i);
  if (cached) return cached;
  const c = ctx.candles;
  const tol = 0.35 * ctx.avgRange[i];
  const pts: number[] = [];
  for (let j = Math.max(PIVOT, i - LEVEL_LOOKBACK); j <= i - 1 - PIVOT; j++) {
    if (ctx.swingHigh[j]) pts.push(c[j].high);
    if (ctx.swingLow[j]) pts.push(c[j].low);
  }
  pts.sort((a, b) => a - b);
  const out: Level[] = [];
  for (let k = 0; k < pts.length; ) {
    let e = k;
    while (e + 1 < pts.length && pts[e + 1] - pts[k] <= tol) e++;
    if (e > k) out.push({ price: mean(pts.slice(k, e + 1)), touches: e - k + 1 });
    k = e + 1;
  }
  ctx.levels.set(i, out);
  return out;
}

/** Trend from EMA 20/50 structure, which survives the pullback into a level better than a regression. */
function trendAt(ctx: SetupContext, i: number): { dir: Side | 0; strength: number; detail: string } {
  const ar = ctx.avgRange[i];
  const gap = (ctx.ema20[i] - ctx.ema50[i]) / ar;
  const slope = (ctx.ema50[i] - ctx.ema50[i - 10]) / ar;
  const strength = clamp((Math.abs(gap) + Math.abs(slope) / 0.6) / 2, 0, 1);
  if (gap > 0.15 && slope > 0.1) {
    return { dir: 1, strength, detail: `EMA20 above EMA50 by ${gap.toFixed(2)} avg ranges, EMA50 rising` };
  }
  if (gap < -0.15 && slope < -0.1) {
    return { dir: -1, strength, detail: `EMA20 below EMA50 by ${(-gap).toFixed(2)} avg ranges, EMA50 falling` };
  }
  return { dir: 0, strength: 0, detail: "no clear trend" };
}

function sessionCheck(time: number): Check {
  const s = sessionOf(time);
  return { id: "session", label: "Trading session", pass: s.quality >= 0.5, points: s.quality, max: 1, detail: s.name };
}

/** pullback setups want room to run (not over-extended in the trade direction) */
function rsiCheck(ctx: SetupContext, i: number, s: Side, kind: "pullback" | "retest", max: number): Check {
  const r = rsi(ctx.candles.slice(Math.max(0, i - 60), i + 1));
  let frac = 0;
  if (r !== null) {
    const x = s > 0 ? r : 100 - r; // 'as if buying'
    if (kind === "pullback") frac = x <= 45 ? 1 : x <= 55 ? 2 / 3 : x <= 65 ? 1 / 3 : 0;
    else frac = x >= 40 && x <= 70 ? 1 : x > 30 && x < 80 ? 0.5 : 0;
  }
  return {
    id: "rsi",
    label: "RSI 14 room to run",
    pass: frac >= 0.5,
    points: frac * max,
    max,
    detail: r === null ? "n/a" : `RSI ${r.toFixed(1)}`,
  };
}

function toSignal(
  ctx: SetupContext,
  i: number,
  setup: SetupId,
  s: Side,
  level: number,
  checks: Check[],
  extra: Pick<Signal, "levelLabel" | "marks" | "trendline">,
): Signal {
  const c = ctx.candles;
  const c3 = c[i];
  const raw = checks.reduce((a, k) => a + k.points, 0);
  const score = Math.round(clamp(raw, 0, 10) * 10) / 10;
  const direction: Direction = s > 0 ? "CALL" : "PUT";
  return {
    direction,
    c3Time: c3.time,
    entryTime: c3.time + 60_000,
    expiryTime: c3.time + 120_000,
    c1: c[i - 2],
    c2: c[i - 1],
    c3,
    liquidityLevel: level,
    sweepDepth: 0,
    score,
    strength: clamp(Math.ceil(score / 2), 1, 5),
    checks,
    sentiment: sentimentOf(c.slice(Math.max(0, i - 29), i + 1)),
    qualified: score >= ctx.cfg.minScore,
    strategy: setup,
    setupLabel: SETUP_NAMES[setup],
    ...extra,
  };
}

/** Setup 1: trend + SnR level + rejection candle + green/red candle at the level. */
function setup1(ctx: SetupContext, i: number): Signal | null {
  const c = ctx.candles;
  const x = c[i];
  const trend = trendAt(ctx, i);
  if (trend.dir === 0) return null;
  const s = trend.dir;
  if (!withTrade(x, s)) return null; // green candle at support / red at resistance
  const ar = ctx.avgRange[i];
  const tol = 0.25 * ar;
  const levels = levelsBefore(ctx, i);

  // The rejection is this candle itself (a green / red pin bar) or the candle before it,
  // when that one closed against the trade and this candle is the confirmation.
  let hit: { level: Level; r: number; wick: number } | null = null;
  for (const r of [i, i - 1]) {
    const rc = c[r];
    if (r === i - 1 && withTrade(rc, s)) continue; // it would have been its own signal
    const rr = range(rc);
    if (rr <= 0) continue;
    const wick = farWick(rc, s) / rr;
    if (wick < 0.3) continue;
    for (const L of levels) {
      const toward = s * (extreme(rc, s) - L.price); // > 0 stayed short of the level, < 0 pierced it
      if (toward > tol || toward < -1.2 * ar) continue; // no touch / crashed through
      if (s * (rc.close - L.price) <= 0 || s * (x.close - L.price) <= 0) continue; // must close back on the trade side
      if (s * (x.close - L.price) > 2 * ar) continue; // already ran away from the level
      if (!hit || L.touches > hit.level.touches || (L.touches === hit.level.touches && wick > hit.wick)) {
        hit = { level: L, r, wick };
      }
    }
    if (hit) break;
  }
  if (!hit) return null;

  const side = s > 0 ? "support" : "resistance";
  const cp = closePos(x, s);
  const checks: Check[] = [
    {
      id: "trend",
      label: s > 0 ? "Uptrend" : "Downtrend",
      pass: true,
      points: 1 + trend.strength,
      max: 2,
      detail: trend.detail,
    },
    {
      id: "level",
      label: `Strong ${side} level`,
      pass: true,
      points: levelPoints(hit.level.touches, 2),
      max: 2,
      detail: `${fmt(hit.level.price)} · ${hit.level.touches} swing touches`,
    },
    {
      id: "rejection",
      label: "Rejection candle closed at the level",
      pass: true,
      points: clamp(1 + (hit.wick - 0.3) / 0.3, 1, 2),
      max: 2,
      detail: `${hit.r === i ? "signal candle" : "previous candle"} wick ${Math.round(hit.wick * 100)}% of range, closed back ${s > 0 ? "above" : "below"}`,
    },
    {
      id: "colour",
      label: s > 0 ? "Green candle formed at support" : "Red candle formed at resistance",
      pass: true,
      points: cp >= 0.7 ? 1.5 : cp >= 0.5 ? 1 : 0.5,
      max: 1.5,
      detail: `closed ${Math.round(cp * 100)}% toward the ${s > 0 ? "high" : "low"}`,
    },
    sessionCheck(x.time),
    rsiCheck(ctx, i, s, "pullback", 1.5),
  ];
  const marks = hit.r === i ? [{ time: x.time, label: "RJ" }] : [{ time: c[hit.r].time, label: "RJ" }, { time: x.time, label: "CF" }];
  return toSignal(ctx, i, "snr1", s, hit.level.price, checks, { levelLabel: side, marks });
}

/** Most recent trendline through two swing lows (uptrend) / highs (downtrend) that price has respected. */
function trendlineAt(ctx: SetupContext, i: number, s: Side) {
  const c = ctx.candles;
  const ar = ctx.avgRange[i];
  const swings: number[] = [];
  for (let j = Math.max(PIVOT, i - TRENDLINE_LOOKBACK); j <= i - 1 - PIVOT; j++) {
    if (s > 0 ? ctx.swingLow[j] : ctx.swingHigh[j]) swings.push(j);
  }
  const pts = swings.slice(-5);
  const price = (j: number) => extreme(c[j], s);
  for (let bi = pts.length - 1; bi >= 1; bi--) {
    for (let ai = bi - 1; ai >= 0; ai--) {
      const a = pts[ai];
      const b = pts[bi];
      if (b - a < 5) continue;
      const slope = (price(b) - price(a)) / (b - a);
      if (s * slope < 0.02 * ar) continue; // must rise (fall); a flat line is just a level
      const line = (k: number) => price(a) + slope * (k - a);
      let held = true;
      for (let k = a + 1; k <= i - 1 && held; k++) {
        if (s * (c[k].close - line(k)) < -0.2 * ar) held = false;
      }
      if (!held) continue;
      let touches = 2;
      for (const j of swings) {
        if (j > a && j !== b && Math.abs(price(j) - line(j)) <= 0.25 * ar) touches++;
      }
      return { a, b, at: line(i), touches };
    }
  }
  return null;
}

/** Setup 2: trend + SnR level meeting a trendline + rejection candle closing beyond both. */
function setup2(ctx: SetupContext, i: number): Signal | null {
  const c = ctx.candles;
  const x = c[i];
  const trend = trendAt(ctx, i);
  if (trend.dir === 0) return null;
  const s = trend.dir;
  const tl = trendlineAt(ctx, i, s);
  if (!tl) return null;
  const ar = ctx.avgRange[i];

  let L: Level | null = null;
  for (const lv of levelsBefore(ctx, i)) {
    const d = Math.abs(lv.price - tl.at);
    if (d <= 0.8 * ar && (!L || d < Math.abs(L.price - tl.at))) L = lv;
  }
  if (!L) return null;

  // the candle has to close beyond the far edge of the level/trendline zone
  const edge = s > 0 ? Math.max(L.price, tl.at) : Math.min(L.price, tl.at);
  const inner = s > 0 ? Math.min(L.price, tl.at) : Math.max(L.price, tl.at);
  const rr = range(x);
  if (rr <= 0) return null;
  if (s * (extreme(x, s) - edge) > 0.25 * ar) return null; // never came back to the zone
  if (s * (extreme(x, s) - inner) < -1.2 * ar) return null; // crashed through
  if (s * (x.close - edge) <= 0) return null; // must close above (below) trendline + level
  const wick = farWick(x, s) / rr;
  const coloured = withTrade(x, s);
  if (!coloured && wick < 0.4) return null; // needs a real rejection

  const gap = Math.abs(L.price - tl.at) / ar;
  const side = s > 0 ? "support" : "resistance";
  const checks: Check[] = [
    {
      id: "trend",
      label: s > 0 ? "Uptrend" : "Downtrend",
      pass: true,
      points: 0.75 + 0.75 * trend.strength,
      max: 1.5,
      detail: trend.detail,
    },
    {
      id: "level",
      label: `Strong ${side} level`,
      pass: true,
      points: levelPoints(L.touches, 1.5),
      max: 1.5,
      detail: `${fmt(L.price)} · ${L.touches} swing touches`,
    },
    {
      id: "trendline",
      label: s > 0 ? "Rising trendline" : "Falling trendline",
      pass: true,
      points: tl.touches >= 3 ? 1.5 : 1,
      max: 1.5,
      detail: `${tl.touches} touches, at ${fmt(tl.at)} now`,
    },
    {
      id: "confluence",
      label: `${s > 0 ? "Support" : "Resistance"} + trendline meet`,
      pass: true,
      points: gap <= 0.3 ? 1 : 0.5,
      max: 1,
      detail: `${gap.toFixed(2)} avg ranges apart`,
    },
    {
      id: "rejection",
      label: `Rejection candle closed ${s > 0 ? "above" : "below"} trendline + level`,
      pass: true,
      points: clamp((wick - 0.2) / 0.4, 0, 1) * 1.5 + (coloured ? 1 : 0),
      max: 2.5,
      detail: `wick ${Math.round(wick * 100)}% of range, ${coloured ? (s > 0 ? "green" : "red") : "opposite colour"} close`,
    },
    sessionCheck(x.time),
    rsiCheck(ctx, i, s, "pullback", 1),
  ];
  return toSignal(ctx, i, "snr2", s, L.price, checks, {
    levelLabel: side,
    marks: [{ time: x.time, label: "RJ" }],
    trendline: { t1: c[tl.a].time, p1: extreme(c[tl.a], s), t2: c[tl.b].time, p2: extreme(c[tl.b], s) },
  });
}

/** Setup 3: momentum breakout of a strong level, retest of the level, reversal candle. */
function setup3(ctx: SetupContext, i: number): Signal | null {
  const c = ctx.candles;
  const x = c[i];
  let hit: { b: number; s: Side; L: Level; touch: number } | null = null;

  // most recent breakout first
  for (let b = i - 1; b >= Math.max(SETUP_MIN_HISTORY, i - RETEST_WINDOW) && !hit; b--) {
    const bc = c[b];
    const arB = ctx.avgRange[b];
    const bb = body(bc);
    const br = range(bc);
    if (br <= 0 || bb < 1.5 * ctx.avgBody[b] || bb < 0.55 * br) continue; // not a momentum candle
    const s: Side = isBull(bc) ? 1 : -1;
    for (const L of levelsBefore(ctx, b)) {
      if (s * (bc.open - L.price) > 0.1 * arB) continue; // opened beyond the level already
      if (s * (c[b - 1].close - L.price) > 0.1 * arB) continue; // was beyond before the breakout
      if (s * (bc.close - L.price) < 0.15 * arB) continue; // did not close clearly through
      let held = true;
      let touch = -1;
      for (let k = b + 1; k <= i && held; k++) {
        if (s * (c[k].close - L.price) < -0.25 * arB) held = false; // failed breakout
        else if (touch < 0 && s * (extreme(c[k], s) - L.price) <= 0.3 * arB) touch = k;
      }
      if (!held || touch < 0) continue; // broken back, or no retest yet
      // the first reversal candle at / after the touch, closing back on the breakout side
      let rev = -1;
      for (let k = touch; k <= i && rev < 0; k++) {
        if (withTrade(c[k], s) && s * (c[k].close - L.price) > 0) rev = k;
      }
      if (rev !== i) continue; // not completed yet, or it fired earlier
      if (!hit || L.touches > hit.L.touches) hit = { b, s, L, touch };
    }
  }
  if (!hit) return null;

  const { b, s, L, touch } = hit;
  const ar = ctx.avgRange[i];
  const ratio = body(c[b]) / ctx.avgBody[b];
  const retestDist = (s * (extreme(c[touch], s) - L.price)) / ar;
  const cp = closePos(x, s);
  const trend = trendAt(ctx, i);
  const trendPts = trend.dir === s ? 1 : trend.dir === 0 ? 0.5 : 0;
  const broke = s > 0 ? "resistance" : "support";
  const checks: Check[] = [
    {
      id: "level",
      label: `Strong ${broke} level`,
      pass: true,
      points: levelPoints(L.touches, 2),
      max: 2,
      detail: `${fmt(L.price)} · ${L.touches} swing touches`,
    },
    {
      id: "breakout",
      label: "Breakout with a strong momentum candle",
      pass: true,
      points: clamp(1 + (ratio - 1.5), 1, 2),
      max: 2,
      detail: `${i - b} candle${i - b === 1 ? "" : "s"} ago, body ${ratio.toFixed(1)}x average`,
    },
    {
      id: "retest",
      label: "Retest touched the level again",
      pass: true,
      points: Math.abs(retestDist) <= 0.15 ? 1.5 : retestDist >= -0.4 && retestDist <= 0.3 ? 1 : 0.5,
      max: 1.5,
      detail: `${touch === i ? "this candle" : `${i - touch} candle${i - touch === 1 ? "" : "s"} ago`}, ${Math.abs(retestDist).toFixed(2)} avg ranges ${retestDist >= 0 ? "short of" : "through"} the level`,
    },
    {
      id: "reversal",
      label: s > 0 ? "Green reversal candle after the retest" : "Red reversal candle after the retest",
      pass: true,
      points: cp >= 0.6 ? 1.5 : cp >= 0.4 ? 1 : 0.5,
      max: 1.5,
      detail: `closed ${Math.round(cp * 100)}% toward the ${s > 0 ? "high" : "low"}`,
    },
    {
      id: "trend",
      label: "Trend agrees with the breakout",
      pass: trendPts > 0,
      points: trendPts,
      max: 1,
      detail: trend.dir === 0 ? "no clear trend" : `${trend.dir > 0 ? "uptrend" : "downtrend"} · ${trend.detail}`,
    },
    sessionCheck(x.time),
    rsiCheck(ctx, i, s, "retest", 1),
  ];
  const marks = [{ time: c[b].time, label: "BO" }];
  if (touch !== i) marks.push({ time: c[touch].time, label: "RT" });
  marks.push({ time: x.time, label: "RV" });
  return toSignal(ctx, i, "snr3", s, L.price, checks, { levelLabel: `broken ${broke}`, marks });
}

/** Every setup that matches on candle `i`, best score first. Cached per context. */
export function detectSetups(ctx: SetupContext, i: number): Signal[] {
  const cached = ctx.found.get(i);
  if (cached) return cached;
  let out: Signal[] = [];
  if (i >= SETUP_MIN_HISTORY && i < ctx.candles.length && range(ctx.candles[i]) > 0) {
    out = [setup1(ctx, i), setup2(ctx, i), setup3(ctx, i)]
      .filter((s): s is Signal => s !== null)
      .sort((a, b) => b.score - a.score);
  }
  ctx.found.set(i, out);
  return out;
}

/** Walk-forward backtest of the best setup on each candle, graded on the next candle. */
export function backtestSetups(ctx: SetupContext): BacktestResult {
  const c = ctx.candles;
  const trades: BacktestTrade[] = [];
  for (let i = SETUP_MIN_HISTORY; i < c.length - 1; i++) {
    const sig = detectSetups(ctx, i)[0];
    if (!sig) continue;
    const next = c[i + 1];
    if (next.time - sig.c3Time > 90_000) continue; // feed gap
    trades.push({
      entryTime: sig.entryTime,
      direction: sig.direction,
      score: sig.score,
      strength: sig.strength,
      qualified: sig.qualified,
      outcome: outcomeOf(sig.direction, next),
      c4: next,
      strategy: sig.strategy,
    });
  }
  return summarize(
    c,
    ctx.cfg,
    trades,
    { all: "All setups", qualified: `Score >= ${ctx.cfg.minScore}` },
    SETUP_NAMES,
  );
}
