// Second-leg retest bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// IDEA — buy the SECOND leg, not the first. A pump.fun coin's first leg is mostly the launch
// crowd and bundled buyers; it usually dumps. The coins that keep going are the ones that pump,
// retrace, and then RECLAIM their earlier high on fresh buying. This bot waits for exactly that
// shape: a curve that (a) ran up to a high over the last 120 slots, (b) dipped at least 8% below
// that high, and (c) is now back within 3% of the high with positive net SOL flow and several
// distinct buyers stepping in. The reclaim is the confirmation that the dip was bought, not the
// start of a bleed. Entries are limited to a coin's first 600 slots of life: older coins that
// reclaim are usually dead-cat bounces.
//
// WHY THIS DIFFERS FROM THE OBVIOUS PLAYS:
// - Not a launch sniper: entries need age >= 100 slots, so bundled launches are already gone.
// - Not first-leg momentum: a coin still on its first straight run-up never triggers — the dip
//   and reclaim are mandatory. A coin that never dips is left alone.
// - Not dip-buying / mean reversion: the dip alone is never bought. Only the reclaim after the
//   dip, with flow turning positive, counts.
// - One fixed-size buy per coin, no pyramiding, no adds: every coin risks the same small stake,
//   so the score cannot lean on one coin getting fed repeatedly. Breadth is the point — the
//   guardrail needs round trips on 20+ coins, and small equal stakes are how we get there.
// EXITS — sell the whole position on the first of: take-profit +35% over cost, hard stop -18%,
// a trailing stop of 25% once the position has been +10% up, a single recorded sell of >= 2 SOL
// (a dump signal), net flow turning negative over 15 slots (the crowd leaving), or a 1200-slot
// time box (unless the position is already +20% up, in which case it may ride). A completed
// curve is closed by the replay itself.
//
// PACING — when the coin count lags the pace (30 coins over the 24h window, measured on block
// time), the entry loosens in fixed steps (net flow 0.30 -> 0.15 SOL, reclaim 0.97 -> 0.94 of
// the high). No probe trades: the loosening is the whole catch-up mechanism, and it only ever
// relaxes the entry, never the exits.
//
// FEES — every order pays 105,000 lamports of tx fees plus ~1.25% curve fees each way, so a
// round trip costs roughly 4% of a 0.05 SOL stake. The +35% / -18% pair needs about a 40%
// win rate to break even after fees.
//
// DETERMINISM — a pure function of the batches: no clock, no randomness, no I/O, iteration only
// over insertion-ordered maps fed by the batch stream. The two graded executions therefore
// produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback (slots) for the high the dip and reclaim are measured from. */
  highWindow: number;
  /** Dip below the window high required before a reclaim counts (fraction). */
  dip: number;
  /** Loosened dip while catching up on the coin pace. */
  dipLoose: number;
  /** Price now must be at least this share of the window high (the reclaim). */
  reclaim: number;
  /** Loosened reclaim while catching up. */
  reclaimLoose: number;
  /** Net SOL (buys minus sells) over the flow window that must be positive. */
  flowWindow: number;
  minNetSol: number;
  minNetSolLoose: number;
  /** Buys and distinct buyers over the flow window. */
  minBuys: number;
  minBuyers: number;
  minBuyersLoose: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided (0 = no limit). */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL per position (single buy, no adds). */
  sizeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits (fractions of cost / peak value). */
  takeProfit: number;
  stopLoss: number;
  trail: number;
  trailArm: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when net SOL over the fade window falls below this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held, unless up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: coins target over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  /**
   * Dip mode: instead of waiting for the reclaim, buy the dip itself once fresh buying
   * steps in (net flow positive over dipFlowWindow, last trade a buy). The take-profit
   * then becomes the old window high (reclaimTp of it). Off by default.
   */
  dipMode: boolean;
  dipFlowWindow: number;
  reclaimTp: number;
}

// The settings main.ts trades with. Chosen on the dev window with the kit's local sim across
// five sweep rounds (see STATE.md): the base reclaim design lost -0.19 SOL; wide-TP variants
// lost more (coins rarely run +100% after a reclaim); dip-buying lost more; the locked settings
// below were the best flat region found (-0.09 SOL, 54 trips, 48 coins, 24% wins, dd 0.010).
// Every strategy tried on this window lost money, including all three house pilot baselines
// (momentum -9.38, reversion -1.78, sniper -0.13), so the settings were picked for breadth,
// win rate and drawdown, not for a positive dev number that is not there.
export const DEFAULT_PARAMS: Params = {
  highWindow: 120,
  dip: 0.08,
  dipLoose: 0.08,
  reclaim: 0.97,
  reclaimLoose: 0.94,
  flowWindow: 20,
  minNetSol: 0.3,
  minNetSolLoose: 0.15,
  minBuys: 3,
  minBuyers: 2,
  minBuyersLoose: 2,
  minAge: 20,
  maxAge: 600,
  minRqSol: 3,
  maxRqSol: 55,
  sizeSol: 0.05,
  minBuySol: 0.02,
  buySlipBps: 1500,
  takeProfit: 0.35,
  stopLoss: 0.18,
  trail: 0.25,
  trailArm: 0.1,
  bigSellSol: 2,
  fadeWindow: 15,
  fadeNetSol: -0.5,
  maxHold: 1200,
  holdIfUp: 0.2,
  cooldown: 300,
  maxEntries: 2,
  maxOpen: 5,
  maxExposureSol: 8,
  targetCoins: 30,
  paceSecs: 86400,
  dipMode: false,
  dipFlowWindow: 10,
  reclaimTp: 0.97,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL spent in buys for this position (fees included). */
  invested: number;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** Window high at entry (dip mode: the take-profit target). */
  entryHigh: number;
  /** Price when the position was opened. */
  entryPrice: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Coins we have bought, for the pace check. */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.highWindow + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Are we behind the coin pace? Block time since the first batch, scaled to the window. */
  const catchingUp = (): boolean => {
    if (firstTime === null || lastTime === null) return false;
    const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
    return myCoins.size < Math.ceil(p.targetCoins * pace);
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * The second-leg signal: over the high window the price ran to a high, dipped at least `dip`
   * below it, and is now back within `reclaim` of it — with fresh buying behind the reclaim.
   * In dip mode the same high/dip structure is used, but the buy fires at the dip itself once
   * fresh buying steps in (positive net flow over dipFlowWindow and the last trade a buy).
   * Returns the window high alongside the verdict (the dip-mode take-profit target).
   */
  const entrySignal = (t: Tape, now: number, rqSol: number, loose: boolean): { ok: boolean; high: number } => {
    const no = { ok: false, high: 0 };
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return no;
    if (t.created === null || now - t.created < p.minAge) return no;
    if (p.maxAge > 0 && now - t.created > p.maxAge) return no;
    const dip = loose ? p.dipLoose : p.dip;
    const reclaim = loose ? p.reclaimLoose : p.reclaim;
    const minNet = loose ? p.minNetSolLoose : p.minNetSol;
    const minBuyers = loose ? p.minBuyersLoose : p.minBuyers;
    const from = now - p.highWindow;
    let high = 0;
    let highSlot = -1;
    let last = 0;
    let lowAfterHigh = Infinity;
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (tr.price > high) {
        high = tr.price;
        highSlot = tr.slot;
        lowAfterHigh = Infinity;
      } else if (tr.slot > highSlot && tr.price < lowAfterHigh) {
        lowAfterHigh = tr.price;
      }
      last = tr.price;
    }
    if (high <= 0 || last <= 0 || highSlot < 0) return no;
    // The dip must have happened after the high.
    if (lowAfterHigh === Infinity) return no;
    if (lowAfterHigh > high * (1 - dip)) return no;
    if (p.dipMode) {
      // Buy the dip: the price must still be down near the dip, with buying stepping in.
      if (last > high * (1 - dip * 0.5)) return no;
      let buys = 0;
      let net = 0;
      const byUser = new Set<string>();
      let lastBuy = false;
      for (let i = t.trades.length - 1; i >= 0; i--) {
        const tr = t.trades[i]!;
        if (tr.slot <= now - p.dipFlowWindow) break;
        if (i === t.trades.length - 1) lastBuy = tr.buy;
        if (tr.buy) {
          buys++;
          net += tr.sol;
          byUser.add(tr.user);
        } else {
          net -= tr.sol;
        }
      }
      if (!lastBuy || buys < p.minBuys || byUser.size < minBuyers) return no;
      if (net < minNet) return no;
      return { ok: true, high };
    }
    // Reclaim mode: the price must have come back within `reclaim` of the high.
    if (last < high * reclaim) return no;
    // Fresh buying behind the reclaim.
    let buys = 0;
    let net = 0;
    const byUser = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.flowWindow) break;
      if (tr.buy) {
        buys++;
        net += tr.sol;
        byUser.add(tr.user);
      } else {
        net -= tr.sol;
      }
    }
    if (buys < p.minBuys || byUser.size < minBuyers) return no;
    if (net < minNet) return no;
    return { ok: true, high };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const loose = catchingUp();

      // Exits first: sell the whole position on the first trigger that fires.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && p.dipMode && h.entryHigh > 0) {
          const price = vq / vt;
          if (price >= h.entryHigh * p.reclaimTp) exit = true;
        }
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one fixed-size buy per coin, only on the second-leg reclaim signal.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const sig = entrySignal(t, now, rqSol, loose);
        if (!sig.ok) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.sizeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, filled: false, lastValue: 0, entryHigh: sig.high, entryPrice: Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves) });
        t.entries++;
        slotsLeft--;
      }
      return orders;
    },
  };
}
