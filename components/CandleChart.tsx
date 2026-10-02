"use client";

import { Candle, Signal } from "@/lib/types";

interface Props {
  candles: Candle[];
  forming: Candle | null;
  signal: Signal | null;
  count?: number;
}

export default function CandleChart({ candles, forming, signal, count = 40 }: Props) {
  const closed = candles.slice(-count);
  const all = forming ? [...closed, forming] : closed;
  if (all.length === 0) return <div className="text-muted text-sm">No candles yet.</div>;

  const W = 720;
  const H = 260;
  const padX = 8;
  const padY = 14;
  const right = 64;
  const hi = Math.max(...all.map((c) => c.high), signal?.liquidityLevel ?? -Infinity);
  const lo = Math.min(...all.map((c) => c.low), signal?.liquidityLevel ?? Infinity);
  const span = hi - lo || 1;
  const y = (p: number) => padY + ((hi - p) / span) * (H - padY * 2);
  const slot = (W - padX * 2 - right) / all.length;
  const bw = Math.max(2, slot * 0.6);
  const x = (i: number) => padX + i * slot + slot / 2;

  const marks = new Map(
    (signal?.marks ?? (signal ? [
      { time: signal.c1.time, label: "C1" },
      { time: signal.c2.time, label: "C2" },
      { time: signal.c3.time, label: "C3" },
    ] : [])).map((m) => [m.time, m.label]),
  );
  const entryLabel = signal?.strategy && signal.strategy !== "wick" ? "IN" : "C4";
  const decimals = hi > 1000 ? 1 : hi > 10 ? 3 : 5;
  const last = all[all.length - 1];
  // candles are one minute apart, so a time maps to a slot even when it is off-screen
  const xAt = (t: number) => x(all.length - 1 - (last.time - t) / 60_000);
  let trend: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (signal?.trendline) {
    const { t1, p1, t2, p2 } = signal.trendline;
    const at = (t: number) => p1 + ((p2 - p1) * (t - t1)) / (t2 - t1);
    const from = Math.max(t1, all[0].time);
    const to = signal.entryTime;
    trend = { x1: xAt(from), y1: y(at(from)), x2: xAt(to), y2: y(at(to)) };
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="1-minute candles">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const p = hi - t * span;
        return (
          <g key={t}>
            <line x1={padX} x2={W - right} y1={y(p)} y2={y(p)} stroke="#1b2532" strokeWidth="1" />
            <text x={W - right + 6} y={y(p) + 4} fill="#7d8b9c" fontSize="11" fontFamily="monospace">
              {p.toFixed(decimals)}
            </text>
          </g>
        );
      })}

      {signal && (
        <g>
          <line
            x1={padX}
            x2={W - right}
            y1={y(signal.liquidityLevel)}
            y2={y(signal.liquidityLevel)}
            stroke="#ffb020"
            strokeDasharray="6 4"
            strokeWidth="1.5"
          />
          <text x={padX + 4} y={y(signal.liquidityLevel) - 4} fill="#ffb020" fontSize="11" fontFamily="monospace">
            {signal.levelLabel ?? "liquidity"} {signal.liquidityLevel.toFixed(decimals)}
          </text>
        </g>
      )}

      {trend && (
        <g>
          <clipPath id="plot">
            <rect x={padX} y={padY} width={W - right - padX} height={H - padY * 2} />
          </clipPath>
          <line
            {...trend}
            clipPath="url(#plot)"
            stroke="#2dd4ff"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
        </g>
      )}

      {all.map((c, i) => {
        const up = c.close >= c.open;
        const col = up ? "#22ff88" : "#ff2d55";
        const isForming = forming && i === all.length - 1;
        const mark = marks.get(c.time);
        const inPattern = mark !== undefined;
        const isC4 = signal && c.time === signal.entryTime;
        const top = y(Math.max(c.open, c.close));
        const bot = y(Math.min(c.open, c.close));
        return (
          <g key={c.time} opacity={isForming ? 0.75 : 1}>
            {(inPattern || isC4) && (
              <rect
                x={x(i) - slot / 2 + 1}
                y={padY}
                width={slot - 2}
                height={H - padY * 2}
                fill={isC4 ? "rgba(45,212,255,0.08)" : "rgba(255,176,32,0.08)"}
                stroke={isC4 ? "rgba(45,212,255,0.5)" : "rgba(255,176,32,0.35)"}
                strokeDasharray={isC4 ? "3 3" : undefined}
              />
            )}
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1.5" />
            <rect
              x={x(i) - bw / 2}
              y={top}
              width={bw}
              height={Math.max(1, bot - top)}
              fill={col}
              stroke={isForming ? "#fff" : col}
              strokeDasharray={isForming ? "2 2" : undefined}
            />
            {inPattern && (
              <text x={x(i)} y={H - 2} textAnchor="middle" fill="#ffb020" fontSize="10" fontFamily="monospace">
                {mark}
              </text>
            )}
            {isC4 && (
              <text x={x(i)} y={H - 2} textAnchor="middle" fill="#2dd4ff" fontSize="10" fontFamily="monospace">
                {entryLabel}
              </text>
            )}
          </g>
        );
      })}

      <line x1={padX} x2={W - right} y1={y(last.close)} y2={y(last.close)} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 3" />
      <rect x={W - right + 2} y={y(last.close) - 9} width={right - 4} height={18} rx="3" fill={last.close >= last.open ? "#22ff88" : "#ff2d55"} />
      <text x={W - right + right / 2} y={y(last.close) + 4} textAnchor="middle" fill="#000" fontSize="11" fontFamily="monospace" fontWeight="bold">
        {last.close.toFixed(decimals)}
      </text>
    </svg>
  );
}
