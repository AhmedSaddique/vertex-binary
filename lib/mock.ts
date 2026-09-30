import { Candle, Direction } from "./types";

/**
 * Builds a synthetic 1-minute series that ends in a textbook Wick Liquidity
 * Sweep setup, with C4 opening at the current minute. Used only by the
 * "Demo signal" button so the user can see how a live alert looks and sounds.
 */
export function mockSeries(direction: Direction, now = Date.now()): Candle[] {
  const M = 60_000;
  const c4Open = Math.floor(now / M) * M;
  const start = c4Open - 120 * M;
  const out: Candle[] = [];
  let price = 100;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  // 117 quiet, gently ranging candles
  for (let i = 0; i < 117; i++) {
    const drift = Math.sin(i / 9) * 0.6;
    const o = price;
    const c = o + drift + (rnd() - 0.5) * 1.6;
    const h = Math.max(o, c) + rnd() * 0.9;
    const l = Math.min(o, c) - rnd() * 0.9;
    out.push({ time: start + i * M, open: r(o), high: r(h), low: r(l), close: r(c) });
    price = c;
  }
  const s = direction === "PUT" ? 1 : -1; // PUT setup is built with green candles
  const c1o = price;
  const c1c = c1o + s * 1.6;
  const c2o = c1c;
  const c2c = c2o + s * 1.4;
  const c3o = c2c;
  const c3c = c3o + s * 1.3;
  const c1: Candle = { time: start + 117 * M, open: r(c1o), high: 0, low: 0, close: r(c1c) };
  const c2: Candle = { time: start + 118 * M, open: r(c2o), high: 0, low: 0, close: r(c2c) };
  const c3: Candle = { time: start + 119 * M, open: r(c3o), high: 0, low: 0, close: r(c3c) };
  if (s > 0) {
    c1.high = r(c1c + 1.6);
    c1.low = r(c1o - 0.2);
    c2.high = r(c2c + 1.5);
    c2.low = r(c2o - 0.2);
    c3.high = r(c3c + 0.4);
    c3.low = r(c3o - 0.2);
  } else {
    c1.low = r(c1c - 1.6);
    c1.high = r(c1o + 0.2);
    c2.low = r(c2c - 1.5);
    c2.high = r(c2o + 0.2);
    c3.low = r(c3c - 0.4);
    c3.high = r(c3o + 0.2);
  }
  out.push(c1, c2, c3);
  // forming C4, a few ticks in
  const elapsed = Math.min(1, (now - c4Open) / M);
  const c4c = c3c - s * 1.2 * elapsed;
  out.push({
    time: c4Open,
    open: r(c3c),
    high: r(Math.max(c3c, c4c) + 0.1),
    low: r(Math.min(c3c, c4c) - 0.1),
    close: r(c4c),
  });
  return out;
}

const r = (x: number) => Math.round(x * 1000) / 1000;
