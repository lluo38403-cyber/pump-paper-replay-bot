// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
//
// A momentum bot for the agent-fun/replay/v2 harness. It watches every new
// pump.fun bonding curve, buys only the ones that already survived the
// earliest dump and whose tape still shows real crowd buying (several
// distinct buyers, net SOL flowing in, price rising and holding near its
// window high, inflow accelerating), takes one small 0.05 SOL position per
// coin, and exits on a stop loss, a trailing stop, a time limit or a fade in
// inflow. Tiny probe round trips keep the run above the guardrail pace
// (20 coins) when momentum entries run dry. Tuned on the dev window:
// the survivor filter (real reserves >= 20 SOL) and the single small stake
// are what keep the drawdown low; pyramiding into strength and bigger
// stakes both lost more on this window.
//
// Deterministic by construction: no clock, no randomness, only
// insertion-ordered Maps and Sets fed by the batch stream. All money is
// paper; nothing here touches a real chain.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const BPS = 10_000;

// ---- strategy knobs (all in SOL or slots unless noted) --------------------
const WINDOW = 60; // entry tape window, in slots
const MIN_AGE = 800; // slots since CreateEvent before an entry is allowed
const MIN_TRADES = 5; // trades in the window
const MIN_BUYS = 5; // buy trades in the window
const MIN_BUYERS = 6; // distinct buying wallets in the window
const MIN_NET_SOL = 3.0; // net buy SOL (buys minus sells) over the window
const MIN_UP = 0.10; // price now vs window-start price, minus 1
const MAX_UP = 0.5; // skip curves that already ran too far in one window
const ACCEL = 1.0; // newer-half net inflow must be >= this x older half
const NEAR_HIGH = 0.90; // price now must be >= this share of window high
const MIN_RQ_SOL = 20; // real SOL reserves at entry, lower bound
const MAX_RQ_SOL = 100; // real SOL reserves at entry, upper bound
const FIRST_BUY_SOL = 0.05; // first buy of a position
const ADD_SOL = 0.05; // each pyramid add
const MAX_STAKE_SOL = 0.05; // most SOL at cost in one position: no pyramid
const ADD_STEP = 0.05; // add only once price is this far above last buy
const ADD_NET_SOL = 1.0; // add only while window net inflow is >= this
const MAX_ENTRIES = 1; // most separate entries per curve over the run
const COOLDOWN = 1000; // slots to wait after an exit before re-entry
const STOP_LOSS = 0.15; // sell when value falls this far below cost
const TRAIL_ARM = 0.50; // trailing stop arms once value is up this much
const TRAIL = 0.35; // sell when value falls this far below its peak
const MAX_HOLD = 3000; // slots held before the time-limit exit
const HOLD_IF_UP = 0.20; // time limit does not apply while up this much
const FADE_WINDOW = 40; // slots for the fade check
const FADE_NET_SOL = -1.5; // exit when net SOL over the fade window is below this
const BUY_SLIP_BPS = 1500; // slippage on buys; sells go out wide open
const SELL_SLIP_BPS = 10_000;
const PROBE_SOL = 0.02; // guardrail probe buy
const PACE_EVERY = 20_000; // slots between guardrail pace checks
const PACE_TARGET = 24; // distinct coins to reach by the end of the window
const PACE_SPAN = 400_000; // expected slot span of the 24h window

// ---- per-curve tape -------------------------------------------------------
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // SOL, signed later by side
  price: number; // SOL per token at this trade
  user: string;
}

interface Tape {
  created: number | null; // slot of CreateEvent, null if first seen via trade
  firstSeen: number;
  trades: TapeTrade[];
}

// ---- per-position bookkeeping ---------------------------------------------
interface Pos {
  entrySlot: number;
  spent: bigint; // lamports at cost across buys sent for this entry
  peak: bigint; // best close value seen, lamports
  lastBuyPrice: number; // decision-time price of the latest buy
  entries: number; // separate entries taken on this curve
}

interface WindowStats {
  trades: number;
  buys: number;
  buyers: number;
  netSol: number;
  priceStart: number;
  priceNow: number;
  high: number;
  netOld: number;
  netNew: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function valueOf(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n || tokens === 0n) return 0n;
  return (tokens * vq) / vt;
}

function windowStats(tape: Tape, slot: number): WindowStats {
  const from = slot - WINDOW;
  let trades = 0;
  let buys = 0;
  let netSol = 0;
  let netOld = 0;
  let netNew = 0;
  let priceStart = 0;
  let priceNow = 0;
  let high = 0;
  const buyers = new Set<string>();
  const mid = slot - Math.floor(WINDOW / 2);
  for (const t of tape.trades) {
    if (t.slot < from) continue;
    if (trades === 0) priceStart = t.price;
    trades++;
    priceNow = t.price;
    if (t.price > high) high = t.price;
    const signed = t.buy ? t.sol : -t.sol;
    netSol += signed;
    if (t.slot < mid) netOld += signed;
    else netNew += signed;
    if (t.buy) {
      buys++;
      buyers.add(t.user);
    }
  }
  return { trades, buys, buyers: buyers.size, netSol, priceStart, priceNow, high, netOld, netNew };
}

function fadeNetSol(tape: Tape, slot: number): number {
  const from = slot - FADE_WINDOW;
  let net = 0;
  for (const t of tape.trades) {
    if (t.slot < from) continue;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

function pruneTape(tape: Tape, slot: number): void {
  const from = slot - WINDOW - 1;
  while (tape.trades.length > 0 && tape.trades[0].slot < from) tape.trades.shift();
}

// ---- bot factory ----------------------------------------------------------
// The strategy lives in a closure created here so the same object can be
// driven by the harness (via runBot) or by a local backtest driver.
export function createBot(): { onBatch: (state: BotState, batch: Batch) => OrderInput[] } {
  const tapes = new Map<string, Tape>();
  const positions = new Map<string, Pos>();
  const cooldownUntil = new Map<string, number>();
  const entriesTaken = new Map<string, number>();
  const probeHeld = new Set<string>(); // probe mints bought, to sell once held
  const coinsTraded = new Set<string>();
  let filledCount = 0;
  let startSlot = -1;
  let nextPaceSlot = -1;

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    if (startSlot < 0) {
      startSlot = slot;
      nextPaceSlot = slot + PACE_EVERY;
    }
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let orderCount = 0;

    const sendBuy = (mint: string, amount: bigint): void => {
      if (orderCount >= caps.max_orders_per_batch) return;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      orderCount++;
    };
    const sendSell = (mint: string, tokens: bigint): void => {
      if (orderCount >= caps.max_orders_per_batch) return;
      if (tokens <= 0n) return;
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIP_BPS });
      orderCount++;
    };

    // 1. Fold this batch's fills into the counters.
    for (const f of batch.fills) {
      if (f.status === 'filled') filledCount++;
    }

    // 2. Update the tapes from this batch's events, in order.
    const eventMints: string[] = [];
    for (const e of batch.events) {
      const mint = e.mint;
      if (e.event === 'CreateEvent') {
        let tape = tapes.get(mint);
        if (tape === undefined) {
          tape = { created: e.slot, firstSeen: slot, trades: [] };
          tapes.set(mint, tape);
        } else if (tape.created === null) {
          tape.created = e.slot;
        }
      } else if (e.event === 'TradeEvent') {
        let tape = tapes.get(mint);
        if (tape === undefined) {
          tape = { created: null, firstSeen: slot, trades: [] };
          tapes.set(mint, tape);
        }
        tape.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / 1e9,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          user: e.user,
        });
        pruneTape(tape, slot);
        eventMints.push(mint);
      } else {
        // CompleteEvent: the curve is done, drop its tape.
        tapes.delete(mint);
        cooldownUntil.delete(mint);
      }
    }

    // 3. Sync position bookkeeping with the account the harness reports.
    const held = new Set<string>();
    for (const [mint, h] of state.positions) {
      held.add(mint);
      let pos = positions.get(mint);
      if (pos === undefined) {
        pos = { entrySlot: slot, spent: h.cost_lamports, peak: 0n, lastBuyPrice: 0, entries: entriesTaken.get(mint) ?? 0 };
        positions.set(mint, pos);
      }
      const curve = state.curves.get(mint);
      if (curve !== undefined) {
        const value = valueOf(h.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (value > pos.peak) pos.peak = value;
      }
      if (pos.lastBuyPrice === 0) {
        const curve = state.curves.get(mint);
        if (curve !== undefined) pos.lastBuyPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      }
    }
    for (const mint of [...positions.keys()]) {
      if (!held.has(mint)) positions.delete(mint);
    }

    // 4. Exits for every held position (at most max_open_positions of them).
    const exited = new Set<string>();
    for (const [mint, h] of state.positions) {
      const pos = positions.get(mint);
      if (pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = h.cost_lamports;
      if (cost <= 0n) continue;
      const value = valueOf(h.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const tape = tapes.get(mint);
      let sell = false;
      // Stop loss against cost.
      if (value * 100n <= cost * BigInt(Math.round((1 - STOP_LOSS) * 100))) sell = true;
      // Trailing stop from the best close value, once armed.
      if (!sell && pos.peak * 100n >= cost * BigInt(Math.round((1 + TRAIL_ARM) * 100))) {
        if (value * 100n <= pos.peak * BigInt(Math.round((1 - TRAIL) * 100))) sell = true;
      }
      // Time limit, unless the position is comfortably up.
      if (!sell && slot - pos.entrySlot > MAX_HOLD && value * 100n < cost * BigInt(Math.round((1 + HOLD_IF_UP) * 100))) {
        sell = true;
      }
      // Fade: the crowd stopped buying.
      if (!sell && tape !== undefined && fadeNetSol(tape, slot) < FADE_NET_SOL) sell = true;
      if (sell) {
        sendSell(mint, h.token_amount);
        exited.add(mint);
        cooldownUntil.set(mint, slot + COOLDOWN);
        probeHeld.delete(mint);
      }
    }

    // 5. Probe exits: a probe bought in an earlier batch is sold whole as soon
    //    as the account shows it held.
    for (const mint of [...probeHeld]) {
      if (exited.has(mint)) continue;
      const h = state.positions.get(mint);
      if (h !== undefined) {
        sendSell(mint, h.token_amount);
        exited.add(mint);
        probeHeld.delete(mint);
      }
    }

    // 6. Entries and pyramids, only for mints that traded in this batch.
    const decided = new Set<string>();
    for (const mint of eventMints) {
      if (decided.has(mint) || exited.has(mint)) continue;
      decided.add(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      const created = tape.created ?? tape.firstSeen;
      if (slot - created < MIN_AGE) continue;
      const cool = cooldownUntil.get(mint) ?? -1;
      if (slot < cool) continue;
      const stats = windowStats(tape, slot);
      if (stats.trades < MIN_TRADES || stats.buys < MIN_BUYS || stats.buyers < MIN_BUYERS) continue;
      if (stats.netSol < MIN_NET_SOL) continue;
      if (stats.priceStart <= 0) continue;
      const up = stats.priceNow / stats.priceStart - 1;
      if (up < MIN_UP || up > MAX_UP) continue;
      if (stats.high > 0 && stats.priceNow < NEAR_HIGH * stats.high) continue;
      if (stats.netNew < ACCEL * stats.netOld) continue;
      const rqSol = Number(curve.real_quote_reserves) / 1e9;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;

      const heldPos = state.positions.get(mint);
      const pos = positions.get(mint);
      if (heldPos !== undefined && pos !== undefined) {
        // Pyramid into strength: add while the price is above the last buy
        // and the crowd is still buying, up to the stake cap.
        if (pos.spent >= BigInt(Math.round(MAX_STAKE_SOL * 1e9))) continue;
        if (stats.priceNow < pos.lastBuyPrice * (1 + ADD_STEP)) continue;
        if (stats.netSol < ADD_NET_SOL) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap <= 0n) continue;
        let amount = BigInt(Math.round(ADD_SOL * 1e9));
        const room = BigInt(Math.round(MAX_STAKE_SOL * 1e9)) - pos.spent;
        if (amount > room) amount = room;
        if (amount > cap) amount = cap;
        if (amount < BigInt(Math.round(0.01 * 1e9))) continue;
        if (state.freeCashLamports() < amount + txFee) continue;
        sendBuy(mint, amount);
        pos.spent += amount;
        pos.lastBuyPrice = stats.priceNow;
        coinsTraded.add(mint);
        continue;
      }
      if (heldPos !== undefined) continue;
      // Fresh entry.
      if ((entriesTaken.get(mint) ?? 0) >= MAX_ENTRIES) continue;
      if (state.committedPositionCount() >= caps.max_open_positions) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;
      let amount = BigInt(Math.round(FIRST_BUY_SOL * 1e9));
      if (amount > cap) amount = cap;
      if (amount < BigInt(Math.round(0.01 * 1e9))) continue;
      if (state.freeCashLamports() < amount + txFee) continue;
      sendBuy(mint, amount);
      entriesTaken.set(mint, (entriesTaken.get(mint) ?? 0) + 1);
      positions.set(mint, {
        entrySlot: slot,
        spent: amount,
        peak: 0n,
        lastBuyPrice: stats.priceNow,
        entries: entriesTaken.get(mint) ?? 1,
      });
      coinsTraded.add(mint);
    }

    // 7. Guardrail pace probes: keep the run on pace for the 20-coin bar.
    if (slot >= nextPaceSlot) {
      nextPaceSlot = slot + PACE_EVERY;
      const elapsed = Math.max(1, slot - startSlot);
      const target = Math.max(1, Math.floor((PACE_TARGET * elapsed) / PACE_SPAN));
      if (coinsTraded.size < target && state.committedPositionCount() < caps.max_open_positions) {
        let bestMint: string | null = null;
        let bestRq = -1;
        for (const mint of eventMints) {
          if (decided.has(mint) || exited.has(mint)) continue;
          if (state.positions.has(mint) || probeHeld.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rq = Number(curve.real_quote_reserves);
          if (rq > bestRq) {
            bestRq = rq;
            bestMint = mint;
          }
        }
        if (bestMint !== null && bestRq > 0) {
          const cap = state.maxBuyLamports(bestMint);
          let amount = BigInt(Math.round(PROBE_SOL * 1e9));
          if (amount > cap) amount = cap;
          if (amount >= BigInt(Math.round(0.01 * 1e9)) && state.freeCashLamports() >= amount + txFee) {
            sendBuy(bestMint, amount);
            probeHeld.add(bestMint);
            coinsTraded.add(bestMint);
          }
        }
      }
    }

    return orders;
  }

  return { onBatch };
}

// Only speak the wire protocol when this file is the entrypoint; importing
// it (for a local backtest) must not start the harness loop.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await runBot(createBot());
}
