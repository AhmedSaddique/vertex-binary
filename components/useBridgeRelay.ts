"use client";

import { useCallback, useEffect, useState } from "react";
import { BridgeAsset, MemoryStore } from "@/lib/quotex/parse";
import { Candle } from "@/lib/types";

/**
 * Receives Quotex messages relayed tab-to-tab by the bridge userscript (which
 * also runs on this page) and builds candles in the browser. Works on any host
 * with no server storage.
 */
export interface RelayState {
  /** the userscript is installed and running on this page */
  scriptPresent: boolean;
  /** a batch arrived in the last 15 s */
  connected: boolean;
  lastBatch: number;
  messages: number;
  parsedMessages: number;
  assets: BridgeAsset[];
  unparsed: string[];
  version: number;
}

const INITIAL: RelayState = {
  scriptPresent: false,
  connected: false,
  lastBatch: 0,
  messages: 0,
  parsedMessages: 0,
  assets: [],
  unparsed: [],
  version: 0,
};

interface Payload {
  kind: "status" | "snapshot" | "batch";
  relay?: boolean;
  data?: { messages?: unknown[]; page?: string };
}

export function useBridgeRelay() {
  const [store] = useState(() => new MemoryStore());
  const [state, setState] = useState<RelayState>(INITIAL);

  useEffect(() => {
    const s = store;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; payload?: Payload } | undefined;
      if (!d || d.source !== "vertex-bridge" || !d.payload) return;
      const p = d.payload;
      if (p.kind === "status") {
        setState((st) => ({ ...st, scriptPresent: true }));
        return;
      }
      const msgs = Array.isArray(p.data?.messages) ? p.data!.messages! : [];
      s.ingest(msgs, p.data?.page ?? "");
      const now = Date.now();
      setState((st) => ({
        scriptPresent: true,
        connected: true,
        lastBatch: p.kind === "batch" ? now : st.lastBatch,
        messages: s.messages,
        parsedMessages: s.parsedMessages,
        assets: s.list(),
        unparsed: s.unparsed.slice(-5).map((u) => u.text),
        version: st.version + 1,
      }));
    };
    window.addEventListener("message", onMessage);
    // let a userscript that loaded before us know we are ready
    window.postMessage({ source: "vertex-page", type: "hello" }, window.location.origin);
    const tick = setInterval(() => {
      setState((st) =>
        st.connected && Date.now() - st.lastBatch > 15_000
          ? { ...st, connected: false, assets: s.list() }
          : st,
      );
    }, 5_000);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(tick);
    };
  }, [store]);

  const candles = useCallback((asset: string): Candle[] => store.candles(asset), [store]);
  return { relay: state, candles };
}
