import { Candle, SymbolInfo } from "../types";
import { fetchBinance } from "./binance";
import { fetchTwelveData } from "./twelvedata";
import { bridgeAssets, labelFor, quotexCandles } from "../quotex/store";

type SymbolDef = Omit<SymbolInfo, "available" | "note">;

const FOREX_NOTE =
  "Real-market feed via Twelve Data. Quotex OTC prices are synthetic and will differ; always confirm the pattern on your Quotex chart.";

const DEFS: SymbolDef[] = [
  { id: "EURUSD", label: "EUR/USD", provider: "twelvedata", query: "EUR/USD", kind: "forex", pollMs: 60_000 },
  { id: "GBPUSD", label: "GBP/USD", provider: "twelvedata", query: "GBP/USD", kind: "forex", pollMs: 60_000 },
  { id: "USDJPY", label: "USD/JPY", provider: "twelvedata", query: "USD/JPY", kind: "forex", pollMs: 60_000 },
  { id: "AUDUSD", label: "AUD/USD", provider: "twelvedata", query: "AUD/USD", kind: "forex", pollMs: 60_000 },
  { id: "NZDUSD", label: "NZD/USD", provider: "twelvedata", query: "NZD/USD", kind: "forex", pollMs: 60_000 },
  { id: "USDCAD", label: "USD/CAD", provider: "twelvedata", query: "USD/CAD", kind: "forex", pollMs: 60_000 },
  { id: "USDCHF", label: "USD/CHF", provider: "twelvedata", query: "USD/CHF", kind: "forex", pollMs: 60_000 },
  { id: "EURJPY", label: "EUR/JPY", provider: "twelvedata", query: "EUR/JPY", kind: "forex", pollMs: 60_000 },
  { id: "GBPJPY", label: "GBP/JPY", provider: "twelvedata", query: "GBP/JPY", kind: "forex", pollMs: 60_000 },
  { id: "XAUUSD", label: "Gold (XAU/USD)", provider: "twelvedata", query: "XAU/USD", kind: "metal", pollMs: 60_000 },
  { id: "BTCUSDT", label: "BTC/USD", provider: "binance", query: "BTCUSDT", kind: "crypto", pollMs: 4_000 },
  { id: "ETHUSDT", label: "ETH/USD", provider: "binance", query: "ETHUSDT", kind: "crypto", pollMs: 4_000 },
  { id: "SOLUSDT", label: "SOL/USD", provider: "binance", query: "SOLUSDT", kind: "crypto", pollMs: 4_000 },
  { id: "BNBUSDT", label: "BNB/USD", provider: "binance", query: "BNBUSDT", kind: "crypto", pollMs: 4_000 },
  { id: "XRPUSDT", label: "XRP/USD", provider: "binance", query: "XRPUSDT", kind: "crypto", pollMs: 4_000 },
];

const QUOTEX_NOTE =
  "Quotex chart stream forwarded by the bridge userscript in your own browser. History starts when the bridge connects.";

export function listSymbols(): SymbolInfo[] {
  const hasTD = Boolean(process.env.TWELVEDATA_API_KEY);
  const fixed: SymbolInfo[] = DEFS.map((d) => ({
    ...d,
    available: d.provider === "binance" ? true : hasTD,
    note:
      d.provider === "twelvedata"
        ? hasTD
          ? FOREX_NOTE
          : "Add TWELVEDATA_API_KEY to .env.local to enable forex pairs."
        : "Free Binance feed, no key needed.",
  }));
  const bridged: SymbolInfo[] = bridgeAssets().map((a) => ({
    id: `QX:${a.asset}`,
    label: a.label,
    provider: "quotex",
    query: a.asset,
    kind: "otc",
    pollMs: 3_000,
    available: a.live,
    note: QUOTEX_NOTE,
  }));
  return [...bridged, ...fixed];
}

export function getSymbol(id: string): SymbolInfo | undefined {
  if (id.startsWith("QX:")) {
    const asset = id.slice(3);
    const a = bridgeAssets().find((x) => x.asset === asset);
    return {
      id,
      label: a?.label ?? labelFor(asset),
      provider: "quotex",
      query: asset,
      kind: "otc",
      pollMs: 3_000,
      available: Boolean(a),
      note: a ? QUOTEX_NOTE : "This Quotex asset has not been seen by the bridge yet. Open its chart in Quotex.",
    };
  }
  return listSymbols().find((s) => s.id === id.toUpperCase());
}

interface CacheEntry {
  at: number;
  candles: Candle[];
}
const cache = new Map<string, CacheEntry>();

async function cached(key: string, ttl: number, load: () => Promise<Candle[]>): Promise<Candle[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.candles;
  const candles = await load();
  candles.sort((a, b) => a.time - b.time);
  cache.set(key, { at: Date.now(), candles });
  return candles;
}

async function fetchRaw(sym: SymbolInfo, limit: number): Promise<Candle[]> {
  return sym.provider === "binance"
    ? await fetchBinance(sym.query, limit)
    : await fetchTwelveData(sym.query, limit);
}

/**
 * Deep history (for the backtest) is cached for 5 minutes and merged with a
 * small, frequently refreshed tail, so polling stays cheap on provider limits.
 */
export async function fetchCandles(sym: SymbolInfo, limit = 3000): Promise<Candle[]> {
  if (sym.provider === "quotex") return quotexCandles(sym.query).slice(-limit);
  const tailTtl = sym.provider === "binance" ? 2_000 : 15_000;
  const tail = await cached(`${sym.id}:tail`, tailTtl, () => fetchRaw(sym, 200));
  if (limit <= 200) return tail.slice(-limit);
  const history = await cached(`${sym.id}:hist:${limit}`, 5 * 60_000, () => fetchRaw(sym, limit));
  const byTime = new Map<number, Candle>();
  for (const c of history) byTime.set(c.time, c);
  for (const c of tail) byTime.set(c.time, c); // tail wins: it is fresher
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/** Split a candle list into closed candles and the (optional) forming candle. */
export function splitForming(candles: Candle[], now = Date.now()) {
  if (candles.length === 0) return { closed: candles, forming: null as Candle | null };
  const last = candles[candles.length - 1];
  if (last.time + 60_000 > now) {
    return { closed: candles.slice(0, -1), forming: last };
  }
  return { closed: candles, forming: null as Candle | null };
}
