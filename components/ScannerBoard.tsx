"use client";

import { ScanRow } from "@/lib/scan";

interface Props {
  rows: ScanRow[];
  selectedId: string;
  autoFollow: boolean;
  minScore: number;
  onSelect: (id: string) => void;
  onToggleAutoFollow: () => void;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function gradeClass(g: ScanRow["grade"]) {
  switch (g) {
    case "A":
      return "bg-up text-black";
    case "B":
      return "bg-cyan/80 text-black";
    case "C":
      return "bg-amber/80 text-black";
    default:
      return "bg-line text-muted";
  }
}

export default function ScannerBoard({ rows, selectedId, autoFollow, minScore, onSelect, onToggleAutoFollow }: Props) {
  const best = rows.find((r) => r.actionable) ?? null;
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="text-xs tracking-widest text-muted">OTC SCANNER · ALL BRIDGED PAIRS</div>
        <span className="text-[11px] text-muted">{rows.length} pair{rows.length === 1 ? "" : "s"} analysed every few seconds</span>
        <button
          onClick={onToggleAutoFollow}
          className={`ml-auto text-xs border rounded-lg px-2 py-1.5 hover:bg-panel-2 ${autoFollow ? "border-up text-up" : "border-line text-muted"}`}
          title="Automatically switch the main signal to the best-ranked pair"
        >
          {autoFollow ? "Auto-follow best: ON" : "Auto-follow best: OFF"}
        </button>
      </div>

      {best ? (
        <div
          className={`rounded-xl border px-4 py-3 mb-3 flex flex-wrap items-center gap-3 ${
            best.direction === "PUT" ? "border-down/60 bg-down/10" : "border-up/60 bg-up/10"
          }`}
        >
          <div className="text-[11px] tracking-widest text-muted">BEST NOW</div>
          <div className={`text-xl font-black ${best.direction === "PUT" ? "text-down glow-red" : "text-up glow-green"}`}>
            {best.direction === "PUT" ? "SELL" : "BUY"} {best.label}
          </div>
          <div className="text-sm">
            {best.pattern?.qualified ? "pattern" : `${pct(best.probability)} model`} · grade {best.grade}
          </div>
          <div className="text-[11px] text-muted basis-full">{best.reason}</div>
          <button onClick={() => onSelect(best.id)} className="text-xs rounded-lg px-3 py-1.5 bg-panel border border-line hover:bg-panel-2">
            Show on dial
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-line px-4 py-3 mb-3 text-sm text-muted">
          No pair clears your minimum of {minScore * 10}% right now. The table still shows which way each
          pair leans. Lower the minimum in Settings if you want a call on every candle.
        </div>
      )}

      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-muted text-left">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="pr-2">Pair</th>
              <th className="pr-2">Call</th>
              <th className="pr-2">Prob.</th>
              <th className="pr-2">Strength</th>
              <th className="pr-2">Backtest support</th>
              <th className="pr-2">Pattern</th>
              <th className="pr-2">Trend</th>
              <th className="pr-2">Candles</th>
              <th className="pr-2">Grade</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const selected = r.id === selectedId;
              return (
                <tr
                  key={r.id}
                  className={`border-t border-line ${selected ? "bg-white/5" : ""} ${r.live ? "" : "opacity-50"}`}
                  title={r.reason}
                >
                  <td className="py-1.5 pr-2 text-muted">{i + 1}</td>
                  <td className="pr-2 font-semibold whitespace-nowrap">
                    {r.label}
                    {!r.live && <span className="ml-1 text-[10px] text-muted">(stale)</span>}
                  </td>
                  <td className={`pr-2 font-black ${r.direction === "PUT" ? "text-down" : r.direction === "CALL" ? "text-up" : "text-muted"}`}>
                    {r.direction === null ? "–" : r.direction === "PUT" ? "SELL" : "BUY"}
                    {r.direction !== null && !r.qualified && !r.pattern?.qualified && (
                      <span className="ml-1 text-[10px] font-normal text-muted">lean</span>
                    )}
                  </td>
                  <td className="pr-2 mono">{r.direction === null ? "–" : pct(r.probability)}</td>
                  <td className="pr-2">
                    <span className="inline-flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span
                          key={n}
                          className={`h-2 w-2 rounded-full ${
                            n <= r.strength ? (r.direction === "PUT" ? "bg-down" : "bg-up") : "bg-line"
                          }`}
                        />
                      ))}
                    </span>
                  </td>
                  <td className="pr-2 whitespace-nowrap">
                    {r.support && r.support.signals > 0 ? (
                      <span className={r.support.winRate > r.breakEven ? "text-up" : "text-amber"}>
                        {pct(r.support.winRate)} <span className="text-muted">({r.support.signals}, {r.supportLabel})</span>
                      </span>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </td>
                  <td className="pr-2 whitespace-nowrap">
                    {r.pattern ? (
                      <span className={r.pattern.qualified ? "text-amber font-bold" : "text-muted"}>
                        {r.pattern.direction === "PUT" ? "SELL" : "BUY"} {r.pattern.score}/10
                      </span>
                    ) : r.patternWinRate ? (
                      <span className="text-muted">
                        hist {pct(r.patternWinRate.winRate)} ({r.patternWinRate.signals})
                      </span>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </td>
                  <td className={`pr-2 ${r.sentiment === "BULLISH" ? "text-up" : r.sentiment === "BEARISH" ? "text-down" : "text-muted"}`}>
                    {r.sentiment.toLowerCase()}
                  </td>
                  <td className="pr-2 mono text-muted">{r.candles}</td>
                  <td className="pr-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${gradeClass(r.grade)}`}>{r.grade}</span>
                  </td>
                  <td>
                    <button onClick={() => onSelect(r.id)} className="text-[11px] underline text-cyan">
                      {selected ? "selected" : "open"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-muted mt-2 leading-relaxed">
        Grade A: call clears your minimum and calls like it have beaten break‑even on this pair (30+ graded
        trades). B: clears the minimum but too little history yet. C: clears the minimum but the backtest on
        this pair says calls like it lose. A live pattern setup outranks everything.
      </div>
    </section>
  );
}
