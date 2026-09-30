import { Candle } from "../types";

/**
 * In-memory store for the Quotex bridge. The userscript in the user's own
 * logged-in browser forwards raw socket messages; we parse ticks and candle
 * history opportunistically and build 1-minute OHLC candles per asset.
 * Kept on globalThis so dev-server hot reloads do not wipe the data.
 */

interface AssetState {
  asset: string;
  candles: Map<number, Candle>;
  lastTick: number; // ms, wall clock of last ingest
  lastPrice: number;
  ticks: number;
}

interface Store {
  assets: Map<string, AssetState>;
  messages: number;
  parsedMessages: number;
  lastIngest: number;
  page: string;
  unparsed: { at: number; text: string }[];
  samples: { at: number; kind: string; text: string }[];
}

const g = globalThis as unknown as { __vbQuotex?: Store };
const store: Store =
  g.__vbQuotex ??
  (g.__vbQuotex = {
    assets: new Map(),
    messages: 0,
    parsedMessages: 0,
    lastIngest: 0,
    page: "",
    unparsed: [],
    samples: [],
  });

const MAX_MINUTES = 8 * 60;
const ASSET_RE = /^[A-Z0-9]{3,12}(_otc)?$/i;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const looksLikeTs = (x: unknown): x is number => isNum(x) && x > 1e9 && x < 1e13;
const toMs = (ts: number) => (ts < 1e11 ? ts * 1000 : ts);

function state(asset: string): AssetState {
  let s = store.assets.get(asset);
  if (!s) {
    s = { asset, candles: new Map(), lastTick: 0, lastPrice: 0, ticks: 0 };
    store.assets.set(asset, s);
  }
  return s;
}

function prune(s: AssetState) {
  if (s.candles.size <= MAX_MINUTES) return;
  const keys = Array.from(s.candles.keys()).sort((a, b) => a - b);
  for (const k of keys.slice(0, keys.length - MAX_MINUTES)) s.candles.delete(k);
}

function addTick(asset: string, ts: number, price: number, live: boolean) {
  if (!isNum(price) || price <= 0) return;
  const s = state(asset);
  const minute = Math.floor(toMs(ts) / 60_000) * 60_000;
  const c = s.candles.get(minute);
  if (!c) {
    s.candles.set(minute, { time: minute, open: price, high: price, low: price, close: price });
    prune(s);
  } else {
    if (price > c.high) c.high = price;
    if (price < c.low) c.low = price;
    c.close = price;
  }
  s.ticks++;
  if (live) {
    s.lastTick = Date.now();
    s.lastPrice = price;
  }
}

function addCandle(asset: string, c: Candle) {
  const s = state(asset);
  const existing = s.candles.get(c.time);
  // history should not overwrite a candle we are building live from ticks
  if (existing && existing.time >= Date.now() - 120_000) return;
  s.candles.set(c.time, c);
  prune(s);
}

/** Decide the column order of numeric candle rows using max/min consistency. */
function candleOrder(rows: number[][]): "tochl" | "tohlc" | null {
  let a = 0;
  let b = 0;
  for (const r of rows.slice(0, 50)) {
    if (r.length < 5) continue;
    const [, x1, x2, x3, x4] = r;
    const fitA = x3 >= Math.max(x1, x2) && x4 <= Math.min(x1, x2); // t,o,c,h,l
    const fitB = x2 >= Math.max(x1, x4) && x3 <= Math.min(x1, x4); // t,o,h,l,c
    if (fitA && !fitB) a++;
    if (fitB && !fitA) b++;
  }
  if (a === 0 && b === 0) {
    // ambiguous rows (all consistent either way) default to the pyquotex order
    return rows.some((r) => r.length >= 5) ? "tochl" : null;
  }
  return a >= b ? "tochl" : "tohlc";
}

function ingestNumericRows(asset: string | null, rows: number[][]): boolean {
  if (!asset || rows.length === 0) return false;
  const first = rows[0];
  if (!looksLikeTs(first[0])) return false;
  if (first.length >= 5) {
    const order = candleOrder(rows);
    if (!order) return false;
    for (const r of rows) {
      if (r.length < 5 || !looksLikeTs(r[0])) continue;
      const t = Math.floor(toMs(r[0]) / 60_000) * 60_000;
      const c: Candle =
        order === "tochl"
          ? { time: t, open: r[1], close: r[2], high: r[3], low: r[4] }
          : { time: t, open: r[1], high: r[2], low: r[3], close: r[4] };
      if ([c.open, c.high, c.low, c.close].every(isNum)) addCandle(asset, c);
    }
    return true;
  }
  if (first.length >= 2) {
    for (const r of rows) if (looksLikeTs(r[0]) && isNum(r[1])) addTick(asset, r[0], r[1], false);
    return true;
  }
  return false;
}

function walk(v: unknown, ctxAsset: string | null, depth: number): boolean {
  if (depth > 6 || v === null || typeof v !== "object") return false;
  let hit = false;

  if (Array.isArray(v)) {
    // live tick row: ["EURUSD_otc", 1712345678.123, 1.0765, ...]
    if (typeof v[0] === "string" && ASSET_RE.test(v[0]) && looksLikeTs(v[1]) && isNum(v[2])) {
      addTick(v[0], v[1], v[2], true);
      return true;
    }
    // block of numeric rows: history ticks [[ts, price]] or candles [[ts, o, c, h, l]]
    if (v.length > 0 && v.every((r) => Array.isArray(r) && r.length >= 2 && r.every(isNum))) {
      return ingestNumericRows(ctxAsset, v as number[][]);
    }
    // otherwise recurse, picking up an asset name if one appears alongside
    let ctx = ctxAsset;
    for (const el of v) if (typeof el === "string" && ASSET_RE.test(el) && el.length >= 6) ctx = el;
    for (const el of v) hit = walk(el, ctx, depth + 1) || hit;
    return hit;
  }

  const o = v as Record<string, unknown>;
  const named = [o.asset, o.symbol, o.pair].find((x) => typeof x === "string" && ASSET_RE.test(x)) as
    | string
    | undefined;
  const ctx = named ?? ctxAsset;

  if (ctx && looksLikeTs(o.time) && isNum(o.price)) {
    addTick(ctx, o.time, o.price, true);
    hit = true;
  }
  if (ctx && looksLikeTs(o.time) && isNum(o.open) && isNum(o.close) && isNum(o.high) && isNum(o.low)) {
    addCandle(ctx, {
      time: Math.floor(toMs(o.time) / 60_000) * 60_000,
      open: o.open,
      high: o.high,
      low: o.low,
      close: o.close,
    });
    hit = true;
  }
  for (const key of ["history", "candles", "data", "ticks", "list"]) {
    if (Array.isArray(o[key])) hit = walk(o[key], ctx, depth + 1) || hit;
  }
  for (const [key, val] of Object.entries(o)) {
    if (["history", "candles", "data", "ticks", "list"].includes(key)) continue;
    if (val && typeof val === "object") hit = walk(val, ctx, depth + 1) || hit;
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

export function ingest(messages: unknown[], page = "") {
  store.lastIngest = Date.now();
  if (page) store.page = page;
  for (const m of messages) {
    if (typeof m !== "string" || m.length < 4) continue;
    store.messages++;
    const json = extractJson(m);
    if (json === undefined) continue;
    const hit = walk(json, null, 0);
    if (hit) {
      store.parsedMessages++;
      if (store.samples.length < 20 && Math.random() < 0.2) {
        store.samples.push({ at: Date.now(), kind: "parsed", text: m.slice(0, 300) });
      }
    } else {
      store.unparsed.push({ at: Date.now(), text: m.slice(0, 300) });
      if (store.unparsed.length > 25) store.unparsed.shift();
    }
  }
}

export function quotexCandles(asset: string): Candle[] {
  const s = store.assets.get(asset);
  if (!s) return [];
  return Array.from(s.candles.values()).sort((a, b) => a.time - b.time);
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

export function bridgeAssets(): BridgeAsset[] {
  const now = Date.now();
  return Array.from(store.assets.values())
    .map((s) => ({
      asset: s.asset,
      label: labelFor(s.asset),
      candles: s.candles.size,
      lastTick: s.lastTick,
      lastPrice: s.lastPrice,
      live: now - s.lastTick < 3 * 60_000,
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || a.label.localeCompare(b.label));
}

export function bridgeStatus() {
  const now = Date.now();
  return {
    connected: now - store.lastIngest < 15_000,
    lastIngest: store.lastIngest,
    page: store.page,
    messages: store.messages,
    parsedMessages: store.parsedMessages,
    assets: bridgeAssets(),
    unparsedSamples: store.unparsed,
    parsedSamples: store.samples,
  };
}
