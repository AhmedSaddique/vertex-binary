"use client";

export type DialMode = "PUT" | "CALL" | "WAIT" | "WEAK" | "PAUSED" | "OFFLINE";

interface Props {
  mode: DialMode;
  headline: string;
  sub: string;
  countdown?: string;
}

const ringClass: Record<DialMode, string> = {
  PUT: "ring-put pulse",
  CALL: "ring-call pulse",
  WAIT: "ring-wait",
  WEAK: "ring-weak",
  PAUSED: "ring-wait",
  OFFLINE: "ring-wait",
};

const textClass: Record<DialMode, string> = {
  PUT: "text-down glow-red",
  CALL: "text-up glow-green",
  WAIT: "text-cyan",
  WEAK: "text-amber glow-amber",
  PAUSED: "text-amber glow-amber",
  OFFLINE: "text-muted",
};

export default function SignalDial({ mode, headline, sub, countdown }: Props) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-56 w-56 sm:h-64 sm:w-64">
        <div className={`absolute inset-0 rounded-full ${ringClass[mode]}`} />
        <div className="absolute inset-[22%] rounded-full bg-black/70 backdrop-blur flex items-center justify-center border border-white/10">
          {mode === "PUT" && <Arrow dir="down" color="var(--red)" />}
          {mode === "CALL" && <Arrow dir="up" color="var(--green)" />}
          {mode === "WEAK" && <span className="text-4xl text-amber">!</span>}
          {mode === "PAUSED" && <span className="text-3xl text-amber">II</span>}
          {mode === "WAIT" && <Scanner />}
          {mode === "OFFLINE" && <span className="text-2xl text-muted">…</span>}
        </div>
        {countdown && (
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/80 border border-white/10 px-3 py-1 text-xs mono text-muted">
            {countdown}
          </div>
        )}
      </div>
      <div className={`text-3xl sm:text-4xl font-black tracking-wide text-center ${textClass[mode]}`}>
        {headline}
      </div>
      <div className="text-sm text-muted text-center max-w-xs">{sub}</div>
    </div>
  );
}

function Arrow({ dir, color }: { dir: "up" | "down"; color: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className="h-20 w-20"
      style={{ transform: dir === "up" ? "rotate(180deg)" : undefined, filter: `drop-shadow(0 0 10px ${color})` }}
    >
      <path d="M32 6v40M14 30l18 18 18-18" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Scanner() {
  return (
    <svg viewBox="0 0 64 64" className="h-20 w-20 spin-slow">
      <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(45,212,255,.25)" strokeWidth="3" />
      <path d="M32 6a26 26 0 0 1 26 26" fill="none" stroke="var(--cyan)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32" r="4" fill="var(--cyan)" />
    </svg>
  );
}
