"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CandleChart from "./CandleChart";
import SignalDial, { DialMode } from "./SignalDial";
import { analyze } from "@/lib/analyze";
import { outcomeOf } from "@/lib/backtest";
import { BEST_MIN_SCORE } from "@/lib/best";
import { Prediction } from "@/lib/predict";
import { rankRows, scanAsset } from "@/lib/scan";
import ScannerBoard from "./ScannerBoard";
import {
  Candle,
  Sentiment,
  BacktestBucket,
  DEFAULT_CONFIG,
  Direction,
  Mode,
  Outcome,
  PatternConfig,
  Signal,
  SignalResponse,
  SymbolInfo,
} from "@/lib/types";
import { RelayState, useBridgeRelay } from "./useBridgeRelay";

interface LogEntry {
  id: string;
  symbol: string;
  label: string;
  direction: Direction;
  entryTime: number;
  expiryTime: number;
  score: number;
  strength: number;
  outcome: Outcome | "PENDING";
  c4Close?: number;
  /** which setup fired it (A+ entries are prefixed) */
  setup?: string;
}

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: "best", label: "Best of best (A+)", title: "Only A+ trades: a setup scoring 8+, model agrees, not counter-trend, setup not losing on this pair" },
  { id: "setups", label: "SnR setups 1–3", title: "Setup 1 trend + SnR rejection, Setup 2 SnR + trendline, Setup 3 breakout + retest" },
  { id: "pattern", label: "Wick sweep only", title: "Wick Liquidity Sweep Reversal setups only" },
  { id: "every", label: "Every candle", title: "Model prediction on every candle close" },
];

interface Settings {
  mode: Mode;
  /** scanner: switch the main signal to the best-ranked bridged pair automatically */
  autoFollow: boolean;
  minScore: number;
  payout: number;
  requireStrongC3: boolean;
  minWickRatio: number;
  sound: boolean;
  telegram: boolean;
  maxConsecutiveLosses: number;
}

const DEFAULT_SETTINGS: Settings = {
  mode: "best",
  autoFollow: true,
  minScore: DEFAULT_CONFIG.minScore,
  payout: DEFAULT_CONFIG.payout,
  requireStrongC3: DEFAULT_CONFIG.requireStrongC3,
  minWickRatio: DEFAULT_CONFIG.minWickRatio,
  sound: true,
  telegram: false,
  maxConsecutiveLosses: 3,
};

const LS = {
  symbol: "vb:symbol",
  log: "vb:log",
  settings: "vb:settings",
  riskReset: "vb:riskReset",
};

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function loadRaw<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtPrice = (p: number) => p.toFixed(Math.abs(p) > 1000 ? 1 : Math.abs(p) > 10 ? 3 : 5);
const dirLabel = (d: Direction) => (d === "PUT" ? "SELL (DOWN)" : "BUY (UP)");

/** Present an every-candle prediction through the same Signal shape the dial, log and chart use. */
function predictionToSignal(p: Prediction, candles: Candle[], sentiment: Sentiment): Signal {
  const n = candles.length;
  const c3 = candles[n - 1];
  const c2 = candles[n - 2] ?? c3;
  const c1 = candles[n - 3] ?? c2;
  return {
    direction: p.direction,
    c3Time: c3.time,
    entryTime: p.entryTime,
    expiryTime: p.expiryTime,
    c1,
    c2,
    c3,
    liquidityLevel: c3.close,
    sweepDepth: 0,
    score: p.score,
    strength: p.strength,
    checks: p.votes.map((v) => ({
      id: v.id,
      label: v.label,
      pass: v.vote !== 0 && (v.vote > 0) === (p.direction === "CALL"),
      points: v.vote === 0 ? 0 : Math.abs(v.weight),
      max: 1,
      detail:
        v.vote === 0
          ? `${v.detail} · abstains`
          : `${v.detail} · votes ${v.vote > 0 ? "UP" : "DOWN"} · ${Math.round(v.accuracy * 100)}% recent accuracy`,
    })),
    sentiment,
    qualified: p.qualified,
  };
}

/**
 * Put the selected engine's signal and backtest into `signal` / `backtest`, which the dial,
 * log and chart read. Demo candles only contain a wick sweep, so the demo shows that in
 * every rule-based mode.
 */
function applyMode(resp: SignalResponse, mode: Mode, isDemo = false): SignalResponse {
  switch (mode) {
    case "every":
      return {
        ...resp,
        signal: resp.prediction ? predictionToSignal(resp.prediction, resp.candles, resp.sentiment) : null,
        backtest: resp.predictionBacktest,
      };
    case "setups":
      return { ...resp, signal: isDemo ? resp.signal : resp.setup, backtest: resp.setupBacktest };
    case "best":
      return { ...resp, signal: isDemo ? resp.signal : resp.best, backtest: resp.bestBacktest };
    default:
      return resp;
  }
}

export default function Dashboard() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [symbolId, setSymbolId] = useState(() => loadRaw(LS.symbol, "BTCUSDT"));
  const [settings, setSettings] = useState<Settings>(() => load(LS.settings, DEFAULT_SETTINGS));
  const [log, setLog] = useState<LogEntry[]>(() => loadRaw<LogEntry[]>(LS.log, []));
  const [riskReset, setRiskReset] = useState(() => loadRaw(LS.riskReset, 0));
  const [data, setData] = useState<SignalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showSettings, setShowSettings] = useState(false);
  const [demo, setDemo] = useState<Direction | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const lastFetch = useRef(0);
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  // ---- persist to localStorage (component is rendered client-only)
  useEffect(() => save(LS.symbol, symbolId), [symbolId]);
  useEffect(() => save(LS.settings, settings), [settings]);
  useEffect(() => save(LS.log, log.slice(-300)), [log]);
  useEffect(() => save(LS.riskReset, riskReset), [riskReset]);

  // ---- clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // ---- symbols + Quotex bridge status (re-polled so OTC assets appear as the bridge sees them)
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/symbols")
        .then((r) => r.json())
        .then((j: { symbols: SymbolInfo[] }) => !cancelled && setSymbols(j.symbols))
        .catch(() => undefined);
      fetch("/api/quotex/status")
        .then((r) => r.json())
        .then((j: BridgeStatus) => !cancelled && setBridge(j))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // ---- tab-to-tab relay from the userscript (no server storage needed)
  const { relay, candles: relayCandles } = useBridgeRelay();
  const allSymbols = useMemo(() => {
    const local: SymbolInfo[] = relay.assets.map((a) => ({
      id: `QX:${a.asset}`,
      label: a.label,
      provider: "quotex",
      query: a.asset,
      kind: "otc",
      pollMs: 3_000,
      available: a.live || a.candles > 0,
      note: "Quotex chart stream relayed from your Quotex tab into this browser. History starts when the bridge connects.",
    }));
    const ids = new Set(local.map((s) => s.id));
    return [...local, ...symbols.filter((s) => !ids.has(s.id))];
  }, [symbols, relay.assets]);
  const symbolsRef = useRef(allSymbols);
  useEffect(() => {
    symbolsRef.current = allSymbols;
  }, [allSymbols]);

  const symbol = useMemo(() => allSymbols.find((s) => s.id === symbolId), [allSymbols, symbolId]);
  const provider = symbol?.provider;

  // ---- multi-asset scan of every bridged pair (recomputed every 3 s)
  const scanConfig = useMemo<PatternConfig>(
    () => ({
      ...DEFAULT_CONFIG,
      minScore: settings.minScore,
      payout: settings.payout,
      requireStrongC3: settings.requireStrongC3,
      minWickRatio: settings.minWickRatio,
    }),
    [settings.minScore, settings.payout, settings.requireStrongC3, settings.minWickRatio],
  );
  const scanNow = Math.floor(now / 3000) * 3000;
  const scanRows = useMemo(
    () =>
      rankRows(
        relay.assets.map((a) =>
          scanAsset(`QX:${a.asset}`, a.asset, a.label, relayCandles(a.asset), scanConfig, a.live, settings.mode, scanNow),
        ),
      ),
    // relay.version changes whenever new candles arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.assets, relay.version, relayCandles, scanConfig, settings.mode, scanNow],
  );
  const scanRowsRef = useRef(scanRows);
  useEffect(() => {
    scanRowsRef.current = scanRows;
  }, [scanRows]);
  const otcSymbols = allSymbols.filter((s) => s.provider === "quotex");
  const marketSymbols = allSymbols.filter((s) => s.provider !== "quotex");

  // ---- risk manager: consecutive losses since last reset
  const consecutiveLosses = useMemo(() => {
    let n = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.entryTime < riskReset) break;
      if (e.outcome === "PENDING" || e.outcome === "TIE") continue;
      if (e.outcome === "LOSS") n++;
      else break;
    }
    return n;
  }, [log, riskReset]);
  const paused = consecutiveLosses >= settings.maxConsecutiveLosses;

  // ---- sound
  const beep = useCallback(
    (direction: Direction) => {
      if (!settings.sound || !audioCtx.current) return;
      const ctx = audioCtx.current;
      const base = direction === "CALL" ? 880 : 440;
      [0, 0.18, 0.36].forEach((t, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = base * (i === 2 ? 1.5 : 1);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.16);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.18);
      });
    },
    [settings.sound],
  );
  const enableAudio = () => {
    if (!audioCtx.current) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx.current = new Ctor();
    }
    audioCtx.current.resume();
    setAudioReady(true);
  };

  // ---- signal lifecycle: log new qualified signals, resolve pending ones
  const alerted = useRef<Set<string>>(new Set());
  const processResponse = useCallback(
    (resp: SignalResponse, isDemo: boolean) => {
      const sig = resp.signal;
      const fresh = sig && sig.qualified && !paused && Date.now() < sig.expiryTime ? sig : null;
      const id = fresh ? `${isDemo ? "demo" : resp.symbol.id}:${fresh.entryTime}` : null;

      // side effects (sound, Telegram) exactly once per signal
      if (fresh && id && !alerted.current.has(id)) {
        alerted.current.add(id);
        beep(fresh.direction);
        if (settings.telegram && !isDemo) {
          const text =
            `<b>${dirLabel(fresh.direction)}</b> on <b>${resp.symbol.label}</b>\n` +
            (fresh.setupLabel ? `${fresh.gates ? "A+ " : ""}${fresh.setupLabel}\n` : "") +
            `Enter at open of next candle (${fmtTime(fresh.entryTime)}), expiry 1 min\n` +
            `Score ${fresh.score}/10 · strength ${fresh.strength}/5 · ${fresh.sentiment.toLowerCase()} context`;
          fetch("/api/notify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          }).catch(() => undefined);
        }
      }

      if (isDemo) return; // demo signals never enter the real log

      setLog((prev) => {
        let next = prev;
        if (fresh && id && !prev.some((e) => e.id === id)) {
          next = [
            ...prev,
            {
              id,
              symbol: resp.symbol.id,
              label: resp.symbol.label,
              direction: fresh.direction,
              entryTime: fresh.entryTime,
              expiryTime: fresh.expiryTime,
              score: fresh.score,
              strength: fresh.strength,
              outcome: "PENDING",
              setup: fresh.setupLabel ? `${fresh.gates ? "A+ " : ""}${fresh.setupLabel}` : "Model",
            },
          ];
        }
        // resolve pending entries whose C4 has closed
        const byTime = new Map(resp.candles.map((c) => [c.time, c]));
        let changed = false;
        const resolved = next.map((e) => {
          if (e.outcome !== "PENDING" || e.symbol !== resp.symbol.id) return e;
          const c4 = byTime.get(e.entryTime);
          if (!c4) return e;
          changed = true;
          return { ...e, outcome: outcomeOf(e.direction, c4), c4Close: c4.close };
        });
        return changed ? resolved : next;
      });
    },
    [paused, beep, settings.telegram],
  );

  // ---- polling loop, aligned to candle closes for slow feeds
  const fetchSignal = useCallback(async () => {
    // scanner auto-follow: jump to the best actionable bridged pair
    if (!demo && settings.autoFollow) {
      const best = scanRowsRef.current.find((r) => r.actionable);
      if (best && best.id !== symbolId) {
        setSymbolId(best.id);
        return;
      }
    }
    // Quotex asset with data relayed into this browser: compute everything locally
    if (!demo && symbolId.startsWith("QX:")) {
      const asset = symbolId.slice(3);
      const raw = relayCandles(asset);
      // a remembered OTC pair whose bridge is not running any more: fall back to a live pair
      const known = symbolsRef.current.some((s) => s.id === symbolId);
      if (raw.length === 0 && !known && symbolsRef.current.length > 0 && Date.now() - mountedAt.current > 8_000) {
        setSymbolId("BTCUSDT");
        return;
      }
      if (raw.length >= 10) {
        const now = Date.now();
        const last = raw[raw.length - 1];
        const forming = last.time + 60_000 > now ? last : null;
        const closed = forming ? raw.slice(0, -1) : raw;
        const config: PatternConfig = {
          ...DEFAULT_CONFIG,
          minScore: settings.minScore,
          payout: settings.payout,
          requireStrongC3: settings.requireStrongC3,
          minWickRatio: settings.minWickRatio,
        };
        const sym = symbolsRef.current.find((s) => s.id === symbolId);
        if (sym) {
          const resp = applyMode(
            {
              symbol: sym,
              serverTime: now,
              candles: closed.slice(-120),
              forming,
              config,
              ...analyze(closed, config),
            },
            settings.mode,
          );
          setData(resp);
          setError(null);
          processResponse(resp, false);
          return;
        }
      }
    }
    const q = new URLSearchParams({
      symbol: symbolId,
      minScore: String(settings.minScore),
      payout: String(settings.payout),
      requireStrongC3: settings.requireStrongC3 ? "1" : "0",
      minWickRatio: String(settings.minWickRatio),
      ...(demo ? { mock: demo } : {}),
    });
    lastFetch.current = Date.now();
    try {
      const res = await fetch(`/api/signal?${q}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const resp = applyMode(json as SignalResponse, settings.mode, Boolean(demo));
      setData(resp);
      setError(null);
      processResponse(resp, Boolean(demo));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feed error");
    }
  }, [
    symbolId,
    settings.minScore,
    settings.payout,
    settings.requireStrongC3,
    settings.minWickRatio,
    settings.mode,
    settings.autoFollow,
    processResponse,
    demo,
    relayCandles,
  ]);

  // demo mode switches itself off after the demo candle has expired
  useEffect(() => {
    if (!demo) return;
    const t = setTimeout(() => setDemo(null), 75_000);
    return () => clearTimeout(t);
  }, [demo]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fast = provider !== "twelvedata";

    const loop = async () => {
      await fetchSignal();
      if (cancelled) return;
      let delay: number;
      if (fast) {
        delay = 4000;
      } else {
        const t = Date.now();
        const intoMinute = t % 60_000;
        // right after a close, retry every 5s until the feed publishes the new candle
        delay = intoMinute < 30_000 ? 5000 : 60_000 - intoMinute + 3000;
      }
      timer = setTimeout(loop, delay);
    };
    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchSignal, provider]);

  // ---- derived UI state
  const sig: Signal | null = data?.signal ?? null;
  const live = sig && now < sig.expiryTime ? sig : null;
  const secToClose = 60 - Math.floor((now / 1000) % 60);

  const every = settings.mode === "every";
  const bestMode = settings.mode === "best";
  const probText = live ? `${Math.round(live.score * 10)}%` : "";
  const isWick = !live?.strategy || live.strategy === "wick";
  const SCANNING: Record<Mode, string> = {
    best: `Waiting for an A+ trade: a setup scoring ${Math.max(settings.minScore, BEST_MIN_SCORE)}+ that the model, the trend and the pair's record all agree with.`,
    setups: "Watching for SnR rejection, SnR + trendline, and breakout + retest setups.",
    pattern: "Watching the last three closed candles for a liquidity sweep.",
    every: "Model predicts the next candle at every candle close.",
  };
  let mode: DialMode = "WAIT";
  let headline = "SCANNING";
  let sub = SCANNING[settings.mode];
  let countdown = `next candle closes in ${secToClose}s`;

  if (error && !data) {
    mode = "OFFLINE";
    headline = "FEED OFFLINE";
    sub = error;
    countdown = "";
  } else if (paused) {
    mode = "PAUSED";
    headline = "SESSION PAUSED";
    sub = `${consecutiveLosses} losses in a row. The document says stop here, no martingale. Reset when you are ready.`;
  } else if (live && live.qualified) {
    mode = live.direction;
    headline = live.direction === "PUT" ? "SELL (SHORT)" : "BUY (LONG)";
    const sinceEntry = now - live.entryTime;
    const why = every
      ? `Model probability ${probText}.`
      : live.gates
        ? `A+ ${live.setupLabel}, confluence ${live.score}/10.`
        : isWick
          ? ""
          : `${live.setupLabel}, score ${live.score}/10.`;
    if (sinceEntry < 0) {
      sub = isWick && !every && !live.gates
        ? "C3 closed. Enter at the open of the next candle."
        : `${why} Enter at the open of the next candle.`;
      countdown = `enter in ${Math.ceil(-sinceEntry / 1000)}s`;
    } else if (sinceEntry < 20_000) {
      sub = `${why} ENTER NOW on ${data?.symbol.label}, 1-minute expiry. Entry window closes soon.`.trim();
      countdown = `entry window ${Math.ceil((20_000 - sinceEntry) / 1000)}s`;
    } else {
      sub = `${why} Trade running. Result is graded when this candle closes.`.trim();
      countdown = `expires in ${Math.ceil((live.expiryTime - now) / 1000)}s`;
    }
  } else if (live && !live.qualified) {
    mode = "WEAK";
    headline = every ? `LEAN ${live.direction === "PUT" ? "DOWN" : "UP"}` : bestMode ? "NOT A+" : "WEAK SETUP";
    const failed = live.gates?.filter((g) => !g.pass).map((g) => g.label.toLowerCase()) ?? [];
    sub = every
      ? `Model leans ${dirLabel(live.direction)} at only ${probText}, below your minimum of ${settings.minScore * 10}%. No trade. Lower the minimum in Settings to trade every candle.`
      : bestMode
        ? `${live.setupLabel} (${dirLabel(live.direction)}) found but failed: ${failed.join(", ")}. Skipped.`
        : `${isWick ? "Pattern" : live.setupLabel} matched (${dirLabel(live.direction)}) but score ${live.score}/10 is below your minimum of ${settings.minScore}. Skipped.`;
  }

  const bt = data?.backtest;
  const rateBucket: BacktestBucket | undefined = bt
    ? bt.qualified.signals >= 10
      ? bt.qualified
      : bt.all
    : undefined;
  const aboveBreakEven = bt && rateBucket ? rateBucket.winRate > bt.breakEven : false;

  const sessionLog = log.filter((e) => e.entryTime >= riskReset);
  const liveWins = sessionLog.filter((e) => e.outcome === "WIN").length;
  const liveLosses = sessionLog.filter((e) => e.outcome === "LOSS").length;
  const scoreShown = live?.score;

  const sentiment = data?.sentiment ?? "RANGING";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 flex flex-col gap-5">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-up to-cyan flex items-center justify-center font-black text-black">
            V
          </div>
          <div>
            <div className="font-black tracking-widest text-lg leading-none">VERTEX BINARY</div>
            <div className="text-[11px] text-muted tracking-wider">SNR SETUPS · WICK SWEEP · A+ FILTER · 1M SCANNER</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="bg-panel border border-line rounded-lg px-3 py-2 text-sm"
            value={symbolId}
            onChange={(e) => setSymbolId(e.target.value)}
          >
            <optgroup label={otcSymbols.length ? "Quotex OTC (bridge)" : "Quotex OTC (bridge not connected)"}>
              {otcSymbols.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.available}>
                  {s.label}
                  {s.available ? "" : " (stale)"}
                </option>
              ))}
            </optgroup>
            <optgroup label="Real market">
              {marketSymbols.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.available}>
                  {s.label}
                  {s.available ? "" : " (needs key)"}
                </option>
              ))}
            </optgroup>
          </select>
          <span
            className={`h-2.5 w-2.5 rounded-full ${error ? "bg-down" : data ? "bg-up" : "bg-amber"}`}
            title={error ?? (data ? "connected" : "connecting")}
          />
          <span className="mono text-sm text-muted">{fmtTime(now)}</span>
          {!audioReady && (
            <button onClick={enableAudio} className="text-xs border border-line rounded-lg px-2 py-1.5 hover:bg-panel-2">
              Enable sound
            </button>
          )}
          <select
            aria-label="Signal mode"
            className={`bg-panel border rounded-lg px-2 py-1.5 text-xs ${bestMode ? "border-up text-up" : "border-cyan text-cyan"}`}
            value={settings.mode}
            title={MODES.find((m) => m.id === settings.mode)?.title}
            onChange={(e) => setSettings({ ...settings, mode: e.target.value as Mode })}
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id} title={m.title}>
                Mode: {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setDemo((d) => (d === null ? "PUT" : d === "PUT" ? "CALL" : null))}
            className={`text-xs border rounded-lg px-2 py-1.5 hover:bg-panel-2 ${demo ? "border-amber text-amber" : "border-line"}`}
            title="Show a synthetic example signal (never logged)"
          >
            {demo === "PUT" ? "Demo: SELL → next" : demo === "CALL" ? "Demo: BUY → exit" : "Demo"}
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="text-xs border border-line rounded-lg px-2 py-1.5 hover:bg-panel-2"
          >
            Settings
          </button>
          <a
            href="https://market-qx.trade/en/trade"
            target="_blank"
            rel="noreferrer"
            className="text-xs rounded-lg px-3 py-1.5 bg-up text-black font-bold"
          >
            Open Quotex
          </a>
        </div>
      </header>

      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />
      )}

      <BridgeBar status={bridge} relay={relay} />

      {relay.assets.length > 0 && (
        <ScannerBoard
          rows={scanRows}
          selectedId={symbolId}
          autoFollow={settings.autoFollow}
          minScore={settings.minScore}
          mode={settings.mode}
          onSelect={(id) => {
            setSettings({ ...settings, autoFollow: false });
            setSymbolId(id);
          }}
          onToggleAutoFollow={() => setSettings({ ...settings, autoFollow: !settings.autoFollow })}
        />
      )}

      {data?.symbol.provider === "quotex" && data.candles.length < 40 && (
        <div className="card px-4 py-3 text-xs text-amber border-amber/40">
          Only {data.candles.length} closed candles collected for {data.symbol.label} so far. The scanner
          needs about 40 to score signals properly and far more for a meaningful backtest. Keep the
          Quotex tab open on this chart.
        </div>
      )}

      {/* main signal card */}
      <section className="card p-6 sm:p-8 grid gap-8 lg:grid-cols-[1fr_1.2fr] items-center relative">
        {demo && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[11px] tracking-widest text-amber border border-amber/50 rounded-full px-3 py-1 bg-black/60">
            DEMO DATA · synthetic candles, not the market
          </div>
        )}
        <div className="flex flex-col items-center gap-3">
          <div className="text-xs tracking-[0.35em] text-muted">SIGNAL FOR</div>
          <div className="text-2xl sm:text-3xl font-black text-up glow-green text-center">
            {data?.symbol.label ?? symbol?.label ?? symbolId}
          </div>
          <div className="text-xs tracking-widest text-cyan">TIMEFRAME: 1M · EXPIRY: 1 MIN</div>
          <div className="mt-2">
            <SignalDial mode={mode} headline={headline} sub={sub} countdown={countdown} />
          </div>
          {paused && (
            <button
              onClick={() => setRiskReset(Date.now())}
              className="mt-2 text-xs border border-amber text-amber rounded-lg px-3 py-1.5"
            >
              Reset risk stop
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Stat title="SIGNAL STRENGTH">
            <div className="flex gap-1.5 mb-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={`h-3 w-3 rounded-full ${
                    live && n <= live.strength
                      ? live.direction === "PUT"
                        ? "bg-down shadow-[0_0_8px_var(--red)]"
                        : "bg-up shadow-[0_0_8px_var(--green)]"
                      : "bg-line"
                  }`}
                />
              ))}
            </div>
            <div className="text-2xl font-black">{live ? `${live.strength}/5` : "–/5"}</div>
          </Stat>

          <Stat title="WIN RATE" badge={bt ? `${rateBucket?.signals ?? 0} signals` : undefined}>
            <div className={`text-3xl font-black ${aboveBreakEven ? "text-up glow-green" : "text-amber"}`}>
              {rateBucket && rateBucket.signals > 0 ? pct(rateBucket.winRate) : "–"}
            </div>
            <div className="text-[11px] text-muted">
              backtest on last {bt?.candles ?? 0} candles · break-even {bt ? pct(bt.breakEven) : "–"}
            </div>
            <div className="text-[11px] mt-1">
              <span className="text-up">● LIVE</span> {liveWins}W / {liveLosses}L
              {liveWins + liveLosses > 0 && ` (${pct(liveWins / (liveWins + liveLosses))})`}
            </div>
          </Stat>

          <Stat title={every ? "MODEL PROBABILITY" : bestMode ? "CONFLUENCE SCORE" : "CONFIDENCE SCORE"}>
            <div className="text-3xl font-black">
              {scoreShown === undefined ? "–" : every ? `${Math.round(scoreShown * 10)}%` : scoreShown.toFixed(1)}
              {!every && <span className="text-base text-muted">/10</span>}
            </div>
            <div className="text-[11px] text-muted">
              {bestMode
                ? `setup needs ${Math.max(settings.minScore, BEST_MIN_SCORE)}+ and every A+ gate`
                : `minimum to trade: ${every ? `${settings.minScore * 10}%` : settings.minScore}`}
            </div>
          </Stat>

          <Stat title="MARKET SENTIMENT">
            <div
              className={`text-2xl font-black ${
                sentiment === "BULLISH" ? "text-up glow-green" : sentiment === "BEARISH" ? "text-down glow-red" : "text-cyan"
              }`}
            >
              {sentiment}
            </div>
            <div className="text-[11px] text-muted">
              {live && !every
                ? isWick
                  ? `liquidity ${live.direction === "PUT" ? "above" : "below"} swept ✓`
                  : `${live.levelLabel} at ${fmtPrice(live.liquidityLevel)}`
                : "30-candle regression context"}
            </div>
          </Stat>

          <div className="col-span-2 card px-4 py-3 flex items-center gap-3">
            <span className="text-[11px] tracking-widest text-up">● SCANNER RUNNING</span>
            <div className="flex items-end gap-[3px] h-5">
              {Array.from({ length: 28 }).map((_, i) => (
                <span
                  key={i}
                  className="eq-bar w-[3px] h-full rounded bg-up/70"
                  style={{ animationDelay: `${(i % 7) * 0.12}s` }}
                />
              ))}
            </div>
            <span className="ml-auto text-[11px] text-muted mono">
              {data ? `updated ${fmtTime(data.serverTime)}` : "connecting…"}
            </span>
          </div>
        </div>
      </section>

      {/* chart + checklist */}
      <section className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs tracking-widest text-muted">LAST 40 CANDLES · 1M</div>
            <div className="text-[11px] text-muted">
              {data?.symbol.provider === "binance"
                ? "Binance feed"
                : data?.symbol.provider === "quotex"
                  ? "Quotex bridge feed"
                  : "Twelve Data feed"}
            </div>
          </div>
          <CandleChart candles={data?.candles ?? []} forming={data?.forming ?? null} signal={every ? null : live} />
          {data?.symbol.note && <div className="text-[11px] text-muted mt-2">{data.symbol.note}</div>}
        </div>

        <div className="card p-4">
          <div className="text-xs tracking-widest text-muted mb-3">
            {every ? "MODEL VOTES" : bestMode ? "A+ CHECKLIST" : "SETUP CHECKLIST"}
          </div>
          {live && !every && (live.gates || !isWick) ? (
            <ul className="flex flex-col gap-2">
              {live.gates?.map((c) => (
                <Check key={`gate-${c.id}`} ok={c.pass} label={c.label} detail={c.detail} />
              ))}
              {live.gates && (
                <li className="text-[10px] tracking-widest text-muted border-t border-line pt-2 mt-1">
                  {live.setupLabel?.toUpperCase()}
                </li>
              )}
              {live.checks.map((c) => (
                <Check key={c.id} ok={c.pass} label={c.label} detail={`${c.detail} · ${c.points.toFixed(1)}/${c.max}`} />
              ))}
              <li className="mt-2 text-xs text-muted border-t border-line pt-2">
                Enter at the open of the next candle, 1-minute expiry. Risk 1–2% per trade · stop after{" "}
                {settings.maxConsecutiveLosses} losses · no martingale.
              </li>
            </ul>
          ) : live && every ? (
            <ul className="flex flex-col gap-2">
              {live.checks.map((c) => (
                <Check key={c.id} ok={c.pass} label={c.label} detail={c.detail} />
              ))}
              <li className="mt-2 text-xs text-muted border-t border-line pt-2">
                Each voter is weighted by how often it has been right recently on this pair. Ticks agree
                with the call, dashes disagree or abstain. Risk 1–2% per trade · stop after{" "}
                {settings.maxConsecutiveLosses} losses · no martingale.
              </li>
            </ul>
          ) : live ? (
            <ul className="flex flex-col gap-2">
              <Check ok label="Three same-colour candles" detail={live.direction === "PUT" ? "green → trade DOWN" : "red → trade UP"} />
              <Check ok label="C1 & C2 wicks on the far side" detail={live.checks[0].detail} />
              <Check ok label="C3 swept the wick tips and closed" detail={live.checks[2].detail} />
              {live.checks.slice(1).map((c) =>
                c.id === "sweep" ? null : (
                  <Check key={c.id} ok={c.pass} label={c.label} detail={`${c.detail} · ${c.points.toFixed(1)}/${c.max}`} />
                ),
              )}
              <li className="mt-2 text-xs text-muted border-t border-line pt-2">
                Risk 1–2% per trade · stop after {settings.maxConsecutiveLosses} losses · no martingale.
              </li>
            </ul>
          ) : every ? (
            <div className="text-sm text-muted leading-relaxed">
              <p>Every candle close, ten simple voters look at the closed candles and vote UP or DOWN:</p>
              <ul className="list-disc ml-5 mt-2 space-y-1">
                <li>momentum, mean reversion, 3-candle streak exhaustion</li>
                <li>RSI extremes, EMA 5/20 trend, Bollinger band touch, 10-candle slope</li>
                <li>wick rejection, big-candle exhaustion, close position in range</li>
              </ul>
              <p className="mt-2">
                Votes are weighted by each voter&apos;s recent accuracy on this pair. The result is a
                probability for the next candle; you trade when it clears your minimum.
              </p>
            </div>
          ) : bestMode ? (
            <div className="text-sm text-muted leading-relaxed">
              <p>An A+ trade fires only when all of these line up on the same closed candle:</p>
              <ol className="list-decimal ml-5 mt-2 space-y-1">
                <li>A setup fires: wick sweep or SnR setup 1, 2 or 3.</li>
                <li>It scores {Math.max(settings.minScore, BEST_MIN_SCORE)}/10 or more.</li>
                <li>It is not against the 30-candle trend.</li>
                <li>The every-candle model independently calls the same direction.</li>
                <li>No other setup points the opposite way.</li>
                <li>That setup is not losing on this pair (after 20+ graded trades it must beat break-even).</li>
              </ol>
              <p className="mt-2">Expect only a few per session. Enter at the open of the next candle, 1-minute expiry.</p>
            </div>
          ) : settings.mode === "setups" ? (
            <div className="text-sm text-muted leading-relaxed">
              <p>Strong SnR levels are swing highs/lows touched 2+ times. On closed candles:</p>
              <ol className="list-decimal ml-5 mt-2 space-y-1">
                <li>
                  <b className="text-text">Setup 1</b>: uptrend at support / downtrend at resistance, a rejection
                  candle closes and a green / red candle forms there → BUY at S, SELL at R next candle.
                </li>
                <li>
                  <b className="text-text">Setup 2</b>: SnR level meets a trendline, rejection candle closes above
                  (below) both → BUY in uptrend, SELL in downtrend next candle.
                </li>
                <li>
                  <b className="text-text">Setup 3</b>: momentum candle breaks a strong level, price retests it and a
                  reversal candle forms → BUY after a resistance break, SELL after a support break, only after the retest.
                </li>
              </ol>
            </div>
          ) : (
            <div className="text-sm text-muted leading-relaxed">
              <p>A signal fires only when the exact rules from your document are met on closed candles:</p>
              <ol className="list-decimal ml-5 mt-2 space-y-1">
                <li>C1, C2, C3 all the same colour, none a doji.</li>
                <li>C1 and C2 have a far-side wick of at least {Math.round(settings.minWickRatio * 100)}% of range.</li>
                <li>C2&apos;s extreme is equal to or beyond C1&apos;s.</li>
                <li>C3 pushes beyond both wick tips{settings.requireStrongC3 ? " with a body above the 10-candle average" : ""}.</li>
                <li>Enter at the open of C4 in the opposite direction, 1-minute expiry.</li>
              </ol>
            </div>
          )}
        </div>
      </section>

      {/* backtest + log */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="card p-4">
          <div className="text-xs tracking-widest text-muted mb-3">BACKTEST ON LOADED HISTORY</div>
          {bt ? (
            <div className="text-sm">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <BucketBox b={bt.all} be={bt.breakEven} />
                <BucketBox b={bt.qualified} be={bt.breakEven} />
              </div>
              <div className="text-[11px] text-muted mb-1">By strength</div>
              <div className="grid grid-cols-5 gap-1 mb-3">
                {bt.byStrength.map((b) => (
                  <div key={b.label} className="rounded-lg bg-panel border border-line p-2 text-center">
                    <div className="text-[10px] text-muted">{b.label}</div>
                    <div className={`font-bold ${b.signals && b.winRate > bt.breakEven ? "text-up" : ""}`}>
                      {b.signals ? pct(b.winRate) : "–"}
                    </div>
                    <div className="text-[10px] text-muted">{b.signals}</div>
                  </div>
                ))}
              </div>
              {bt.byStrategy && (
                <>
                  <div className="text-[11px] text-muted mb-1">By setup</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {bt.byStrategy.map((b) => (
                      <div key={b.label} className="rounded-lg bg-panel border border-line px-2 py-1 text-xs">
                        {b.label}:{" "}
                        <b className={b.signals && b.winRate > bt.breakEven ? "text-up" : ""}>
                          {b.signals ? pct(b.winRate) : "–"}
                        </b>{" "}
                        <span className="text-muted">({b.signals})</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <div className="text-[11px] text-muted mb-1">By session (UTC)</div>
              <div className="flex flex-wrap gap-1">
                {bt.bySession.map((b) => (
                  <div key={b.label} className="rounded-lg bg-panel border border-line px-2 py-1 text-xs">
                    {b.label}: <b className={b.winRate > bt.breakEven ? "text-up" : ""}>{pct(b.winRate)}</b>{" "}
                    <span className="text-muted">({b.signals})</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted mt-3">
                The document asks for 200+ signals before trusting a number. Load history from more days
                or more pairs before drawing conclusions. Ties are excluded from the win rate.
              </p>
            </div>
          ) : (
            <div className="text-sm text-muted">Waiting for data…</div>
          )}
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs tracking-widest text-muted">SIGNAL LOG</div>
            <button
              onClick={() => {
                setLog([]);
                setRiskReset(0);
              }}
              className="text-[11px] text-muted hover:text-text"
            >
              clear
            </button>
          </div>
          {log.length === 0 ? (
            <div className="text-sm text-muted">No signals fired yet in this browser.</div>
          ) : (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-muted text-left">
                  <tr>
                    <th className="py-1">Entry</th>
                    <th>Pair</th>
                    <th>Setup</th>
                    <th>Dir</th>
                    <th>Score</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {[...log].reverse().map((e) => (
                    <tr key={e.id} className="border-t border-line">
                      <td className="py-1.5 mono">{fmtTime(e.entryTime)}</td>
                      <td>{e.label}</td>
                      <td className="text-muted text-[11px] max-w-36 truncate" title={e.setup}>
                        {e.setup ?? "–"}
                      </td>
                      <td className={e.direction === "PUT" ? "text-down" : "text-up"}>
                        {e.direction === "PUT" ? "DOWN" : "UP"}
                      </td>
                      <td>{e.score.toFixed(1)}</td>
                      <td
                        className={
                          e.outcome === "WIN"
                            ? "text-up font-bold"
                            : e.outcome === "LOSS"
                              ? "text-down font-bold"
                              : "text-muted"
                        }
                      >
                        {e.outcome}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <footer className="text-[11px] text-muted leading-relaxed pb-6">
        Educational tool. Signals are generated mechanically from the SnR setups, the Wick Liquidity Sweep
        Reversal rules and the every-candle model, and graded on the following candle. A+ is a filter, not a
        promise: it only stacks independent checks. Past win rates do not guarantee future results. Binary options
        can lose your whole stake. Quotex has no official API, so this scanner reads a real-market data feed
        and you place trades yourself; OTC prices on Quotex are synthetic and can differ from any feed.
      </footer>
    </div>
  );
}

interface BridgeStatus {
  backend: "redis" | "memory";
  connected: boolean;
  lastIngest: number;
  page: string;
  messages: number;
  parsedMessages: number;
  assets: { asset: string; label: string; candles: number; live: boolean; lastPrice: number }[];
  unparsedSamples: { at: number; text: string }[];
}

function BridgeBar({ status, relay }: { status: BridgeStatus | null; relay: RelayState }) {
  const [open, setOpen] = useState(false);
  const serverConnected = Boolean(status?.connected);
  const connected = relay.connected || serverConnected;
  const liveAssets = relay.connected
    ? relay.assets.filter((a) => a.live)
    : (status?.assets.filter((a) => a.live) ?? []);
  const messages = relay.connected ? relay.messages : (status?.messages ?? 0);
  const parsed = relay.connected ? relay.parsedMessages : (status?.parsedMessages ?? 0);
  const receivingButUnparsed = connected && messages > 50 && parsed === 0;
  const scriptMissing = !relay.scriptPresent;
  return (
    <div className={`card px-4 py-3 text-xs ${connected ? "border-up/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-up shadow-[0_0_8px_var(--green)]" : "bg-line"}`} />
        <span className="tracking-widest text-muted">QUOTEX OTC BRIDGE</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] ${relay.scriptPresent ? "border-up/50 text-up" : "border-down/50 text-down"}`}
          title={
            relay.scriptPresent
              ? "The bridge userscript is running on this page: Quotex data is relayed tab-to-tab, no server storage needed"
              : "The bridge userscript is not running in this browser"
          }
        >
          {relay.scriptPresent ? "script: active" : "script: not installed"}
        </span>
        {status && (
          <span
            className="rounded-full border border-line px-2 py-0.5 text-[10px] text-muted"
            title="Server-side fallback path (used when the tab-to-tab relay is unavailable)"
          >
            server: {status.backend}
          </span>
        )}
        {connected ? (
          <span>
            connected{relay.connected ? " via relay" : " via server"} · {liveAssets.length} live asset
            {liveAssets.length === 1 ? "" : "s"} · {parsed} parsed / {messages} messages
          </span>
        ) : relay.scriptPresent ? (
          <span className="text-muted">script ready. Open an OTC chart in Quotex in this same browser.</span>
        ) : (
          <span className="text-muted">not connected. Install the bridge script (steps below).</span>
        )}
        <a href="/quotex-bridge.user.js" className="ml-auto underline text-cyan" target="_blank" rel="noreferrer">
          Install bridge script
        </a>
        <button onClick={() => setOpen((v) => !v)} className="text-muted hover:text-text">
          {open ? "hide" : "how it works"}
        </button>
      </div>
      {receivingButUnparsed && (
        <div className="mt-2 text-amber">
          Messages are arriving but no ticks were recognised yet. Open a chart in Quotex; if this persists,
          copy the samples below and share them so the parser can be adjusted.
          {relay.unparsed.length > 0 && (
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/40 p-2 text-[10px] text-muted whitespace-pre-wrap break-all">
              {relay.unparsed.join("\n\n")}
            </pre>
          )}
        </div>
      )}
      {(open || scriptMissing) && (
        <ol className="mt-3 list-decimal ml-5 space-y-1 text-muted leading-relaxed">
          <li>
            Install the <b>Tampermonkey</b> extension in Chrome or Edge. In Chrome, also switch on{" "}
            <b>Developer mode</b> at <span className="mono">chrome://extensions</span> (top right), otherwise
            Tampermonkey scripts never run.
          </li>
          <li>Click <b>Install bridge script</b> above and confirm in Tampermonkey. Then reload this page:
            the badge above should read <b>script: active</b>.</li>
          <li>Log in to Quotex yourself in that browser and open the OTC chart you want to trade. A small
            green “Vertex bridge” badge appears bottom‑right on the Quotex page.</li>
          <li>The asset appears in the pair list here under <b>Quotex OTC</b> within a few seconds.
            Each chart you open in Quotex is added. Keep the Quotex tab open.</li>
          <li>The script is read‑only: it copies chart messages your browser already receives into this
            page and never sends anything to Quotex or reads your login.</li>
        </ol>
      )}
    </div>
  );
}

function Stat({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] tracking-[0.25em] text-muted">{title}</div>
        {badge && <div className="text-[10px] text-muted">{badge}</div>}
      </div>
      {children}
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex gap-2 text-sm">
      <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full text-[10px] flex items-center justify-center font-bold ${ok ? "bg-up text-black" : "bg-line text-muted"}`}>
        {ok ? "✓" : "–"}
      </span>
      <div>
        <div>{label}</div>
        <div className="text-[11px] text-muted">{detail}</div>
      </div>
    </li>
  );
}

function BucketBox({ b, be }: { b: BacktestBucket; be: number }) {
  const good = b.signals > 0 && b.winRate > be;
  return (
    <div className="rounded-lg bg-panel border border-line p-3">
      <div className="text-[11px] text-muted">{b.label}</div>
      <div className={`text-2xl font-black ${good ? "text-up" : b.signals ? "text-amber" : ""}`}>
        {b.signals ? pct(b.winRate) : "–"}
      </div>
      <div className="text-[11px] text-muted">
        {b.wins}W / {b.losses}L / {b.ties}T · {b.signals} signals
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  return (
    <div className="card p-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Minimum confidence score: {settings.minScore}</span>
        <input type="range" min={0} max={10} step={0.5} value={settings.minScore} onChange={(e) => set("minScore", Number(e.target.value))} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Payout for break-even: {Math.round(settings.payout * 100)}%</span>
        <input type="range" min={0.5} max={1} step={0.01} value={settings.payout} onChange={(e) => set("payout", Number(e.target.value))} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Min wick size (C1, C2): {Math.round(settings.minWickRatio * 100)}% of range</span>
        <input type="range" min={0.1} max={0.5} step={0.05} value={settings.minWickRatio} onChange={(e) => set("minWickRatio", Number(e.target.value))} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Stop after consecutive losses: {settings.maxConsecutiveLosses}</span>
        <input type="range" min={1} max={10} step={1} value={settings.maxConsecutiveLosses} onChange={(e) => set("maxConsecutiveLosses", Number(e.target.value))} />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.requireStrongC3} onChange={(e) => set("requireStrongC3", e.target.checked)} />
        Require strong C3 (body above 10-candle average)
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.sound} onChange={(e) => set("sound", e.target.checked)} />
        Sound alert on signal
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.telegram} onChange={(e) => set("telegram", e.target.checked)} />
        Telegram alert (needs env vars)
      </label>
      <div className="sm:col-span-2 lg:col-span-3 flex justify-end">
        <button onClick={onClose} className="text-xs border border-line rounded-lg px-3 py-1.5">
          Close
        </button>
      </div>
    </div>
  );
}
