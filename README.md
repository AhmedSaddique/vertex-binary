# Vertex Binary — Wick Liquidity Sweep 1M Scanner

A Next.js signal dashboard for 1‑minute binary options, built on the **Wick Liquidity Sweep Reversal**
pattern (three same‑colour candles, C1/C2 leave far‑side wicks, C3 sweeps those wick tips, trade the
reversal on C4 with a 1‑minute expiry).

It watches live 1‑minute candles, fires **BUY (UP)** / **SELL (DOWN)** the moment C3 closes, tells you
to enter at the open of C4, grades the trade when C4 closes, and continuously backtests the same rules on
the loaded history so the win rate you see is measured, not invented.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000. Crypto pairs (BTC, ETH, SOL, BNB, XRP) work immediately through the free
Binance feed. For forex and gold, copy `.env.example` to `.env.local` and add a free Twelve Data key.
Optional Telegram alerts use `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Click **Enable sound** once so the browser allows the alert tone, and **Demo** to see what a live
SELL / BUY signal looks like (synthetic candles, never logged).

## Quotex OTC pairs (bridge)

OTC prices exist only inside Quotex, so they are read from your own logged‑in Quotex tab:

1. Install the Tampermonkey extension in Chrome or Edge.
2. With the app running, open `http://localhost:3000/quotex-bridge.user.js` and confirm the install.
3. Log in to Quotex yourself and open the OTC chart you want. A green “Vertex bridge” badge appears
   bottom‑right on the Quotex page, and the pair shows up here under **Quotex OTC**.

The script only copies chart messages your browser already receives. It never sends anything to
Quotex and never reads your login. It delivers the data two ways at once:

- **Tab‑to‑tab relay** (default, works everywhere including Vercel): the same script also runs on the
  dashboard page and hands the messages over through Tampermonkey storage. The dashboard parses
  candles and computes signals in the browser. The bridge bar shows `script: active` when this works.
- **Server ingest** (`/api/quotex/ingest`): fallback that also feeds `/api/quotex/status`. Uses memory
  locally, or Upstash Redis on Vercel if configured.

History starts when the bridge connects (plus whatever history Quotex sends when a chart opens), so
leave the Quotex tab open. If messages arrive but no ticks are recognised, the bridge bar shows raw
samples; those are what the parser in `lib/quotex/parse.ts` needs to be adjusted to.

**Chrome note:** Tampermonkey on Chrome needs **Developer mode** switched on at `chrome://extensions`,
otherwise userscripts silently never run.

## Deploying (Vercel)

The app runs on Vercel as is. The OTC bridge works there through the tab‑to‑tab relay with no extra
setup: install the userscript from `https://<your-app>.vercel.app/quotex-bridge.user.js`.
Optionally add an Upstash Redis database (Vercel Marketplace → Upstash) to enable the server‑side
path too; the app picks it up from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or
`KV_REST_API_URL` / `KV_REST_API_TOKEN`). Without it, serverless instances share no memory, so
`/api/quotex/status` will stay empty on Vercel, which is fine when the relay is active.

## OTC scanner (all bridged pairs at once)

When the bridge is delivering pairs, an **OTC SCANNER** board appears above the dial. Every few
seconds it runs both engines on every bridged pair and ranks them:

- **Call / Prob. / Strength**: the every‑candle model's call for the candle forming now.
- **Backtest support**: how often calls like this one have actually won on that pair (walk‑forward),
  against break‑even.
- **Pattern**: a live Wick Liquidity Sweep setup on that pair, or its historical hit rate.
- **Grade**: A = clears your minimum and the backtest on that pair supports it (30+ trades);
  B = clears the minimum, not enough history yet; C = clears the minimum but the backtest says calls
  like it lose there. A live pattern setup outranks everything.

**Auto‑follow best** (on by default) switches the main dial, sound alert and trade log to the
top‑ranked actionable pair, so you always see the single best trade across all your open OTC charts.
Open more charts in Quotex to add pairs. Selecting a pair manually turns auto‑follow off.

## Modes

Pick the mode from the **Mode** dropdown in the header.

- **Best of best (A+)** (default): fires only when a rule-based setup (wick sweep or SnR setup 1–3)
  passes every gate in `lib/best.ts` on the same closed candle: it scores 8/10 or more (or your minimum
  if higher), it is not against the 30-candle trend, the every-candle model calls the same direction,
  no other setup points the other way, and that setup is not losing on this pair (once it has 20+ graded
  trades here, its walk-forward win rate must beat break-even). Confluence score = setup score + 0.5 per
  extra agreeing setup + up to 1 for model conviction + 0.5 for a proven record. Expect very few signals.
  The backtest grades **every qualified setup** against **A+ only**, so you can see whether the filter
  actually helps on a pair.
- **SnR setups 1–3** (`lib/snr.ts`). Strong levels are clusters of 2+ swing highs/lows (3 candles each
  side) from the last 150 candles; trend is EMA 20/50 structure. All trades are taken on the next candle
  with a 1‑minute expiry:
  - **Setup 1, trend + SnR rejection**: uptrend at support (downtrend at resistance), a rejection candle
    (far wick ≥ 30% of range) touches the level and closes back on the right side, and a green (red)
    candle forms there → BUY at support / SELL at resistance.
  - **Setup 2, SnR + trendline**: a strong level meets a rising (falling) trendline drawn through two
    swing lows (highs) that price has respected; the rejection candle closes above (below) both → BUY in
    the uptrend / SELL in the downtrend. The trendline is drawn on the chart.
  - **Setup 3, breakout + retest**: a momentum candle (body ≥ 1.5× average and ≥ 55% of its range) closes
    through a strong level, the breakout holds, price comes back to touch the level within 15 candles and
    the first reversal candle closes back on the breakout side → BUY after a resistance break, SELL after
    a support break. Chart marks: BO breakout, RT retest, RV reversal.

  Levels and trendlines only use swing points confirmed before the signal candle, so the backtest has no
  look‑ahead. Each setup also gets a 0–10 quality score (level touches, wick, trend strength, session, RSI).
- **Wick sweep only**: the Wick Liquidity Sweep Reversal described below.
- **Every candle**: on each candle close an adaptive ensemble in `lib/predict.ts` predicts
  the next candle. Ten simple voters (momentum, mean reversion, streak exhaustion, RSI, EMA 5/20,
  Bollinger touch, wick rejection, big‑candle exhaustion, close position, 10‑candle slope) are
  weighted by their recent walk‑forward accuracy on that pair and combined into a probability.
  You trade when the probability clears your minimum (Settings → minimum score; 6 = 60%). Lower
  it to 5 to get a call on literally every candle. The backtest is strictly walk‑forward and shows
  the win rate per probability bucket, so you can see which calls actually beat break‑even.
  Expect single‑candle direction to sit close to a coin flip; the model cannot create an edge that
  is not in the data, it can only find and rank one. **Treat high win rates on the Twelve Data forex
  feed with suspicion**: vendor 1‑minute forex candles carry bid/ask bounce and stale quotes that
  look like mean reversion but do not exist in Quotex's own prices. Only the bridge (Quotex's real
  stream) or your live trade log tells the truth for Quotex.


## How a signal is produced

`lib/pattern.ts` implements the exact rules from the strategy document on **closed** candles only:

| Rule | Bearish (SELL on C4) | Bullish (BUY on C4) |
| --- | --- | --- |
| C1, C2, C3 colour | all green | all red |
| C1, C2 wick | upper wick ≥ 20 % of range | lower wick ≥ 20 % of range |
| C2 vs C1 | C2 high ≥ C1 high (small tolerance) | C2 low ≤ C1 low |
| C3 sweep | C3 high > both wick tips | C3 low < both wick tips |
| Strong C3 (optional) | C3 body ≥ 10‑candle average | same |
| Dojis | any of C1–C3 with body < 10 % of range → skip | same |

When the rules match, the optional filters from the document become a **confidence score (0–10)**:
wick quality, C3 strength (penalised if news‑sized), sweep depth, higher‑timeframe context
(30‑candle regression), proximity to the recent 60‑candle swing level, session (UTC), and RSI
over‑extension. Signals below the minimum score (default 6) are shown as **WEAK SETUP** and skipped.
Strength dots = score ÷ 2.

## Risk rules built in

- Stops alerting after N consecutive losses (default 3). No martingale.
- Every fired signal is logged with its graded result; the LIVE tally is your real session record.
- Backtest shows win rate vs. break‑even (`1 / (1 + payout)`), by strength and by session.
  The document asks for 200+ signals before trusting any number.

## Honest limits

- **Quotex has no official public API**, and unofficial automation can breach their terms. This tool
  is alert‑only: you place the trade yourself. Confirm the pattern on your own Quotex chart first.
- **OTC pairs on Quotex are synthetic**; no external feed matches them, which is why they come through
  the bridge from your own browser tab.
- Nothing here guarantees accuracy. The pattern is a hypothesis; the backtest tells you whether it
  has an edge on the data you load. Binary options can lose your whole stake.

## Project layout

```
lib/pattern.ts        wick sweep rule engine + confidence scoring
lib/snr.ts            SnR setups 1-3 (trend + SnR rejection, SnR + trendline, breakout + retest)
lib/best.ts           best-of-best (A+) confluence gates + walk-forward backtest
lib/analyze.ts        runs every engine on a candle series (API route, relay path, scanner)
lib/backtest.ts       walk‑forward grading on C4
lib/providers/        Binance (free) and Twelve Data feeds, cached
lib/mock.ts           synthetic series for the Demo button
lib/quotex/parse.ts   bridge message parser + per-asset 1-min candle builder (browser-safe)
lib/quotex/store.ts   server store: memory or Upstash Redis
components/useBridgeRelay.ts  receives relayed messages from the userscript on the dashboard page
app/quotex-bridge.user.js  Tampermonkey script served to the browser
app/api/quotex/       ingest (POST from the script) and status
app/api/signal        candles + signal + backtest for one symbol
app/api/symbols       pair catalogue and availability
app/api/notify        optional Telegram relay
components/Dashboard  polling, signal lifecycle, log, risk stop, settings
```
#   v e r t e x - b i n a r y  
 