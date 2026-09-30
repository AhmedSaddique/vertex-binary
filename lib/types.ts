export interface Candle {
  /** Open time in ms (UTC) */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Direction = "CALL" | "PUT"; // CALL = UP / BUY, PUT = DOWN / SELL

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  /** Points contributed to the confidence score */
  points: number;
  max: number;
  detail: string;
}

export interface Signal {
  direction: Direction;
  /** Open time of C3 (the sweep candle) */
  c3Time: number;
  /** Open time of C4 = entry moment */
  entryTime: number;
  /** Expiry = close of C4 */
  expiryTime: number;
  c1: Candle;
  c2: Candle;
  c3: Candle;
  /** Wick-tip liquidity level that C3 swept */
  liquidityLevel: number;
  /** How far beyond the liquidity level C3 went, in units of average range */
  sweepDepth: number;
  /** 0 - 10 */
  score: number;
  /** 1 - 5 */
  strength: number;
  checks: Check[];
  sentiment: Sentiment;
  /** Whether the signal clears the configured minimum score */
  qualified: boolean;
}

export type Sentiment = "BULLISH" | "BEARISH" | "RANGING";

export interface PatternConfig {
  /** Minimum wick size as a fraction of candle range for C1 and C2 (doc: 0.20) */
  minWickRatio: number;
  /** Tolerance for "equal" highs/lows, as a fraction of average range */
  equalTolerance: number;
  /** Minimum body as a fraction of range, to reject dojis */
  minBodyRatio: number;
  /** Require C3 body >= average body of previous N candles */
  requireStrongC3: boolean;
  avgBodyLookback: number;
  /** Signals below this confidence score are shown as WAIT */
  minScore: number;
  /** Payout used to compute break-even (0.85 = 85%) */
  payout: number;
}

export const DEFAULT_CONFIG: PatternConfig = {
  minWickRatio: 0.2,
  equalTolerance: 0.15,
  minBodyRatio: 0.1,
  requireStrongC3: true,
  avgBodyLookback: 10,
  minScore: 6,
  payout: 0.85,
};

export type Outcome = "WIN" | "LOSS" | "TIE";

export interface BacktestTrade {
  entryTime: number;
  direction: Direction;
  score: number;
  strength: number;
  qualified: boolean;
  outcome: Outcome;
  c4: Candle;
}

export interface BacktestBucket {
  label: string;
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number; // wins / (wins + losses)
}

export interface BacktestResult {
  candles: number;
  from: number;
  to: number;
  breakEven: number;
  all: BacktestBucket;
  qualified: BacktestBucket;
  byStrength: BacktestBucket[];
  bySession: BacktestBucket[];
  trades: BacktestTrade[];
}

export interface SymbolInfo {
  id: string;
  label: string;
  provider: "binance" | "twelvedata" | "quotex";
  query: string;
  kind: "forex" | "crypto" | "metal" | "otc";
  /** Recommended poll interval on the client, in ms */
  pollMs: number;
  available: boolean;
  note?: string;
}

export interface SignalResponse {
  symbol: SymbolInfo;
  serverTime: number;
  /** Closed candles, ascending */
  candles: Candle[];
  /** Currently forming candle, if the feed provides it */
  forming: Candle | null;
  /** Signal computed on the last three closed candles (may be unqualified) */
  signal: Signal | null;
  sentiment: Sentiment;
  backtest: BacktestResult;
  config: PatternConfig;
}
