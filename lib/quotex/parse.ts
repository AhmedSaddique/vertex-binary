import { Candle } from "../types";

/**
 * Browser-safe parsing for the Quotex bridge: turns raw socket messages into
 * per-asset 1-minute candles. Used on the server (store.ts) and in the
 * dashboard (tab-to-tab relay), so it must not import any server-only module.
 */

export interface Meta {
  lastTick: number; // wall-clock ms of the last live tick
  lastPrice: number;
  ticks: number;
}

export interface BatchCandle {
  c: Candle;
  fromTicks: boolean;
}

export class Batch {
  candles = new Map<string, Map<number, BatchCandle>>();
  meta = new Map<string, Meta>();
  parsed = 0;
  unparsed: string[] = [];
  samples: string[] = [];

  private bucket(asset: string) {
    let m = this.candles.get(asset);
    if (!m) {
      m = new Map();
      this.candles.set(asset, m);
    }
    return m;
  }

  tick(asset: string, ts: number, price: number, live: boolean) {
    if (!isNum(price) || price <= 0) return;
    const minute = minuteOf(ts);
    const m = this.bucket(asset);
    const e = m.get(minute);
    if (!e || !e.fromTicks) {
      m.set(minute, { c: { time: minute, open: price, high: price, low: price, close: price }, fromTicks: true });
    } else {
      if (price > e.c.high) e.c.high = price;
      if (price < e.c.low) e.c.low = price;
      e.c.close = price;
    }
    const meta = this.meta.get(asset) ?? { lastTick: 0, lastPrice: 0, ticks: 0 };
    meta.ticks++;
    if (live) {
      meta.lastTick = Date.now();
      meta.lastPrice = price;
    }
    this.meta.set(asset, meta);
  }

  candle(asset: string, c: Candle) {
    const m = this.bucket(asset);
    const e = m.get(c.time);
    if (e?.fromTicks && c.time >= Date.now() - 120_000) return; // live ticks win for recent minutes
    m.set(c.time, { c, fromTicks: false });
    if (!this.meta.has(asset)) this.meta.set(asset, { lastTick: 0, lastPrice: 0, ticks: 0 });
  }
}

const ASSET_RE = /^[A-Z0-9]{3,12}(_otc)?$/i;
export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const looksLikeTs = (x: unknown): x is number => isNum(x) && x > 1e9 && x < 1e13;
const toMs = (ts: number) => (ts < 1e11 ? ts * 1000 : ts);
const minuteOf = (ts: number) => Math.floor(toMs(ts) / 60_000) * 60_000;

/** Decide the column order of numeric candle rows using max/min consistency. */
function candleOrder(rows: number[][]): "tochl" | "tohlc" | null {
  let a = 0;
  let b = 0;
  for (const r of rows.slice(0, 50)) {
    if (r.length < 5) continue;
    const [, x1, x2, x3, x4] = r;
    const fitA = x3 >= Math.max(x1, x2) && x4 <= Math.min(x1, x2); // t,o,c,h,l (pyquotex order)
    const fitB = x2 >= Math.max(x1, x4) && x3 <= Math.min(x1, x4); // t,o,h,l,c
    if (fitA && !fitB) a++;
    if (fitB && !fitA) b++;
  }
  if (a === 0 && b === 0) return rows.some((r) => r.length >= 5) ? "tochl" : null;
  return a >= b ? "tochl" : "tohlc";
}

function ingestNumericRows(b: Batch, asset: string | null, rows: number[][]): boolean {
  if (!asset || rows.length === 0) return false;
  const first = rows[0];
  if (!looksLikeTs(first[0])) return false;
  if (first.length >= 5) {
    const order = candleOrder(rows);
    if (!order) return false;
    for (const r of rows) {
      if (r.length < 5 || !looksLikeTs(r[0])) continue;
      const t = minuteOf(r[0]);
      const c: Candle =
        order === "tochl"
          ? { time: t, open: r[1], close: r[2], high: r[3], low: r[4] }
          : { time: t, open: r[1], high: r[2], low: r[3], close: r[4] };
      if ([c.open, c.high, c.low, c.close].every(isNum)) b.candle(asset, c);
    }
    return true;
  }
  if (first.length >= 2) {
    for (const r of rows) if (looksLikeTs(r[0]) && isNum(r[1])) b.tick(asset, r[0], r[1], false);
    return true;
  }
  return false;
}

const LIST_KEYS = ["history", "candles", "data", "ticks", "list"];

function walk(b: Batch, v: unknown, ctxAsset: string | null, depth: number): boolean {
  if (depth > 6 || v === null || typeof v !== "object") return false;
  let hit = false;

  if (Array.isArray(v)) {
    // live tick row: ["EURUSD_otc", 1712345678.123, 1.0765, ...]
    if (typeof v[0] === "string" && ASSET_RE.test(v[0]) && looksLikeTs(v[1]) && isNum(v[2])) {
      b.tick(v[0], v[1], v[2], true);
      return true;
    }
    // block of numeric rows: history ticks [[ts, price]] or candles [[ts, o, c, h, l]]
    if (v.length > 0 && v.every((r) => Array.isArray(r) && r.length >= 2 && r.every(isNum))) {
      return ingestNumericRows(b, ctxAsset, v as number[][]);
    }
    let ctx = ctxAsset;
    for (const el of v) if (typeof el === "string" && ASSET_RE.test(el) && el.length >= 6) ctx = el;
    for (const el of v) hit = walk(b, el, ctx, depth + 1) || hit;
    return hit;
  }

  const o = v as Record<string, unknown>;
  const named = [o.asset, o.symbol, o.pair].find((x) => typeof x === "string" && ASSET_RE.test(x)) as
    | string
    | undefined;
  const ctx = named ?? ctxAsset;

  if (ctx && looksLikeTs(o.time) && isNum(o.price)) {
    b.tick(ctx, o.time, o.price, true);
    hit = true;
  }
  if (ctx && looksLikeTs(o.time) && isNum(o.open) && isNum(o.close) && isNum(o.high) && isNum(o.low)) {
    b.candle(ctx, { time: minuteOf(o.time), open: o.open, high: o.high, low: o.low, close: o.close });
    hit = true;
  }
  for (const key of LIST_KEYS) if (Array.isArray(o[key])) hit = walk(b, o[key], ctx, depth + 1) || hit;
  for (const [key, val] of Object.entries(o)) {
    if (LIST_KEYS.includes(key)) continue;
    if (val && typeof val === "object") hit = walk(b, val, ctx, depth + 1) || hit;
  }
  return hit;
}

function extractJson(text: string): unknown | undefined {
  // socket.io frames look like 42["event",{...}] or 451-[...]; binary frames may carry a leading byte
  const i = text.search(/[[{]/);
  if (i < 0) return undefined;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return undefined;
  }
}

export function parseMessages(messages: unknown[]): { batch: Batch; total: number } {
  const b = new Batch();
  let total = 0;
  for (const m of messages) {
    if (typeof m !== "string" || m.length < 4) continue;
    total++;
    const json = extractJson(m);
    if (json === undefined) continue;
    if (walk(b, json, null, 0)) {
      b.parsed++;
      if (b.samples.length < 3 && Math.random() < 0.2) b.samples.push(m.slice(0, 300));
    } else if (b.unparsed.length < 10) {
      b.unparsed.push(m.slice(0, 300));
    }
  }
  return { batch: b, total };
}

/** Merge a batch candle into whatever is already stored for that minute. */
export function merge(existing: Candle | undefined, e: BatchCandle): Candle {
  if (!existing) return e.c;
  if (e.fromTicks) {
    return {
      time: existing.time,
      open: existing.open,
      high: Math.max(existing.high, e.c.high),
      low: Math.min(existing.low, e.c.low),
      close: e.c.close,
    };
  }
  // full history candle: never overwrite a minute we are building live
  return existing.time >= Date.now() - 120_000 ? existing : e.c;
}

export function labelFor(asset: string): string {
  const otc = /_otc$/i.test(asset);
  const base = asset.replace(/_otc$/i, "").toUpperCase();
  const pretty = base.length === 6 ? `${base.slice(0, 3)}/${base.slice(3)}` : base;
  return otc ? `${pretty} (OTC)` : pretty;
}

export interface BridgeAsset {
  asset: string;
  label: string;
  candles: number;
  lastTick: number;
  lastPrice: number;
  live: boolean;
}

export const MAX_AGE = 8 * 60 * 60_000;
export const LIVE_WINDOW = 3 * 60_000;

/** Simple in-memory candle store shared by the server memory backend and the browser relay. */
export class MemoryStore {
  assets = new Map<string, { candles: Map<number, Candle>; meta: Meta }>();
  messages = 0;
  parsedMessages = 0;
  lastIngest = 0;
  page = "";
  unparsed: { at: number; text: string }[] = [];
  samples: { at: number; text: string }[] = [];

  apply(batch: Batch, total: number, page = "") {
    this.messages += total;
    this.parsedMessages += batch.parsed;
    this.lastIngest = Date.now();
    if (page) this.page = page;
    const now = Date.now();
    for (const t of batch.unparsed) this.unparsed.push({ at: now, text: t });
    this.unparsed.splice(0, Math.max(0, this.unparsed.length - 25));
    for (const t of batch.samples) if (this.samples.length < 20) this.samples.push({ at: now, text: t });
    const cutoff = now - MAX_AGE;
    for (const [asset, minutes] of batch.candles) {
      let a = this.assets.get(asset);
      if (!a) {
        a = { candles: new Map(), meta: { lastTick: 0, lastPrice: 0, ticks: 0 } };
        this.assets.set(asset, a);
      }
      for (const [minute, e] of minutes) a.candles.set(minute, merge(a.candles.get(minute), e));
      for (const k of a.candles.keys()) if (k < cutoff) a.candles.delete(k);
      const m = batch.meta.get(asset);
      if (m) {
        a.meta.ticks += m.ticks;
        if (m.lastTick) {
          a.meta.lastTick = m.lastTick;
          a.meta.lastPrice = m.lastPrice;
        }
      }
    }
  }

  ingest(messages: unknown[], page = "") {
    const { batch, total } = parseMessages(messages);
    this.apply(batch, total, page);
    return { total, parsed: batch.parsed, assets: Array.from(batch.candles.keys()) };
  }

  candles(asset: string): Candle[] {
    const a = this.assets.get(asset);
    return a ? Array.from(a.candles.values()).sort((x, y) => x.time - y.time) : [];
  }

  list(): BridgeAsset[] {
    const now = Date.now();
    return Array.from(this.assets.entries())
      .map(([asset, a]) => ({
        asset,
        label: labelFor(asset),
        candles: a.candles.size,
        lastTick: a.meta.lastTick,
        lastPrice: a.meta.lastPrice,
        live: now - a.meta.lastTick < LIVE_WINDOW,
      }))
      .sort((x, y) => Number(y.live) - Number(x.live) || x.label.localeCompare(y.label));
  }
}
