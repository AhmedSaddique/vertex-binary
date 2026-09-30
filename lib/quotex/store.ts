import { Redis } from "@upstash/redis";
import { Candle } from "../types";
import {
  Batch,
  BridgeAsset,
  LIVE_WINDOW,
  MAX_AGE,
  MemoryStore,
  Meta,
  isNum,
  labelFor,
  merge,
  parseMessages,
} from "./parse";

export { labelFor } from "./parse";
export type { BridgeAsset } from "./parse";

/**
 * Server-side store for the Quotex bridge.
 *  - Upstash Redis when UPSTASH_REDIS_REST_URL/TOKEN (or Vercel KV_REST_API_*)
 *    are set. Needed on Vercel, where serverless instances share no memory.
 *  - In-memory (on globalThis, survives dev hot reloads) otherwise.
 * The dashboard also has a browser-side relay that needs neither.
 */

export interface BridgeStatus {
  backend: "redis" | "memory";
  connected: boolean;
  lastIngest: number;
  page: string;
  messages: number;
  parsedMessages: number;
  assets: BridgeAsset[];
  unparsedSamples: { at: number; text: string }[];
  parsedSamples: { at: number; text: string }[];
}

interface Backend {
  name: "redis" | "memory";
  apply(batch: Batch, total: number, page: string): Promise<void>;
  candles(asset: string): Promise<Candle[]>;
  assets(): Promise<BridgeAsset[]>;
  status(): Promise<BridgeStatus>;
}

// ---------------------------------------------------------------- memory backend

const g = globalThis as unknown as { __vbQuotex?: MemoryStore; __vbRedis?: Redis };
const mem = () => (g.__vbQuotex ??= new MemoryStore());

const memory: Backend = {
  name: "memory",
  async apply(batch, total, page) {
    mem().apply(batch, total, page);
  },
  async candles(asset) {
    return mem().candles(asset);
  },
  async assets() {
    return mem().list();
  },
  async status() {
    const s = mem();
    return {
      backend: "memory",
      connected: Date.now() - s.lastIngest < 15_000,
      lastIngest: s.lastIngest,
      page: s.page,
      messages: s.messages,
      parsedMessages: s.parsedMessages,
      assets: s.list(),
      unparsedSamples: s.unparsed,
      parsedSamples: s.samples,
    };
  },
};

// ---------------------------------------------------------------- redis backend

const K = {
  candles: (asset: string) => `qx:c:${asset}`,
  assets: "qx:a",
  status: "qx:s",
  unparsed: "qx:u",
  samples: "qx:p",
};

type Row = [number, number, number, number]; // o, h, l, c

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
function rowToCandle(time: number, raw: unknown): Candle | undefined {
  const r = (typeof raw === "string" ? safeJson(raw) : raw) as Row | undefined;
  if (!Array.isArray(r) || r.length < 4 || !r.every(isNum)) return undefined;
  return { time, open: r[0], high: r[1], low: r[2], close: r[3] };
}
const candleToRow = (c: Candle): Row => [c.open, c.high, c.low, c.close];
function asObj(raw: unknown): Record<string, unknown> {
  const v = typeof raw === "string" ? safeJson(raw) : raw;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return (g.__vbRedis ??= new Redis({ url, token }));
}

const lastTrim = new Map<string, number>();

function redisBackend(r: Redis): Backend {
  const assets = async (): Promise<BridgeAsset[]> => {
    const metas = (await r.hgetall<Record<string, unknown>>(K.assets)) ?? {};
    const names = Object.keys(metas);
    if (names.length === 0) return [];
    const p = r.pipeline();
    for (const n of names) p.hlen(K.candles(n));
    const lens = (await p.exec()) as number[];
    const now = Date.now();
    return names
      .map((asset, i) => {
        const m = asObj(metas[asset]);
        const lastTick = isNum(m.lastTick) ? m.lastTick : 0;
        return {
          asset,
          label: labelFor(asset),
          candles: lens[i] ?? 0,
          lastTick,
          lastPrice: isNum(m.lastPrice) ? m.lastPrice : 0,
          live: now - lastTick < LIVE_WINDOW,
        };
      })
      .sort((x, y) => Number(y.live) - Number(x.live) || x.label.localeCompare(y.label));
  };

  return {
    name: "redis",
    async apply(batch, total, page) {
      const now = Date.now();
      // 1) read the existing values for every minute this batch touches
      const reads = r.pipeline();
      const order: string[] = [];
      for (const [asset, minutes] of batch.candles) {
        order.push(asset);
        reads.hmget(K.candles(asset), ...Array.from(minutes.keys()).map(String));
      }
      reads.hgetall(K.assets);
      const results = await reads.exec();
      const existingMeta = asObj(results[results.length - 1]);

      // 2) merge and write back
      const w = r.pipeline();
      order.forEach((asset, i) => {
        const minutes = batch.candles.get(asset)!;
        const existing = (results[i] ?? {}) as Record<string, unknown>;
        const fields: Record<string, Row> = {};
        for (const [minute, e] of minutes) {
          const prev = rowToCandle(minute, existing?.[String(minute)]);
          fields[String(minute)] = candleToRow(merge(prev, e));
        }
        const key = K.candles(asset);
        w.hset(key, fields);
        w.expire(key, Math.ceil(MAX_AGE / 1000));

        const prevMeta = asObj(existingMeta[asset]);
        const m = batch.meta.get(asset);
        const meta: Meta = {
          lastTick: m?.lastTick || (isNum(prevMeta.lastTick) ? prevMeta.lastTick : 0),
          lastPrice: m?.lastTick ? m.lastPrice : isNum(prevMeta.lastPrice) ? prevMeta.lastPrice : 0,
          ticks: (isNum(prevMeta.ticks) ? prevMeta.ticks : 0) + (m?.ticks ?? 0),
        };
        w.hset(K.assets, { [asset]: meta });
      });
      w.hincrby(K.status, "messages", total);
      w.hincrby(K.status, "parsedMessages", batch.parsed);
      w.hset(K.status, { lastIngest: now, ...(page ? { page } : {}) });
      if (batch.unparsed.length) {
        w.lpush(K.unparsed, ...batch.unparsed.map((t) => JSON.stringify({ at: now, text: t })));
        w.ltrim(K.unparsed, 0, 24);
      }
      if (batch.samples.length) {
        w.lpush(K.samples, ...batch.samples.map((t) => JSON.stringify({ at: now, text: t })));
        w.ltrim(K.samples, 0, 19);
      }
      await w.exec();

      // 3) occasionally drop minutes older than MAX_AGE
      for (const asset of order) {
        if (now - (lastTrim.get(asset) ?? 0) < 5 * 60_000) continue;
        lastTrim.set(asset, now);
        const keys = await r.hkeys(K.candles(asset));
        const old = keys.filter((k) => Number(k) < now - MAX_AGE);
        if (old.length) await r.hdel(K.candles(asset), ...old);
      }
    },
    async candles(asset) {
      const all = (await r.hgetall<Record<string, unknown>>(K.candles(asset))) ?? {};
      const out: Candle[] = [];
      for (const [k, v] of Object.entries(all)) {
        const c = rowToCandle(Number(k), v);
        if (c) out.push(c);
      }
      return out.sort((a, b) => a.time - b.time);
    },
    assets,
    async status() {
      const [s, u, p, a] = await Promise.all([
        r.hgetall<Record<string, unknown>>(K.status),
        r.lrange(K.unparsed, 0, -1),
        r.lrange(K.samples, 0, -1),
        assets(),
      ]);
      const st = s ?? {};
      const lastIngest = Number(st.lastIngest ?? 0);
      const parseList = (xs: unknown[]) =>
        xs
          .map((x) => asObj(x))
          .filter((x) => typeof x.text === "string")
          .map((x) => ({ at: Number(x.at ?? 0), text: String(x.text) }));
      return {
        backend: "redis",
        connected: Date.now() - lastIngest < 15_000,
        lastIngest,
        page: typeof st.page === "string" ? st.page : "",
        messages: Number(st.messages ?? 0),
        parsedMessages: Number(st.parsedMessages ?? 0),
        assets: a,
        unparsedSamples: parseList(u),
        parsedSamples: parseList(p),
      };
    },
  };
}

function backend(): Backend {
  const r = getRedis();
  return r ? redisBackend(r) : memory;
}

// ---------------------------------------------------------------- public API

export async function ingest(messages: unknown[], page = "") {
  const { batch, total } = parseMessages(messages);
  await backend().apply(batch, total, page);
  return { total, parsed: batch.parsed, assets: Array.from(batch.candles.keys()) };
}

export const quotexCandles = (asset: string) => backend().candles(asset);
export const bridgeAssets = () => backend().assets();
export const bridgeStatus = () => backend().status();
export const bridgeBackend = () => backend().name;
