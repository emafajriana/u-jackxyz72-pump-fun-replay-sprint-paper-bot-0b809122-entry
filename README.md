# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/emafajriana/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/emafajriana/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the make.fun [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins; paper money only, nothing is traded for real.

## Strategy: buy the second leg

A coin's first leg is mostly the launch crowd — it usually dumps. The coins that keep going pump, retrace, and then **reclaim their earlier high on fresh buying**. This bot waits for exactly that shape:

1. The curve ran to a high over the last 240 slots.
2. It dipped at least 12% below that high.
3. It is now back within 3% of the high, with positive net SOL flow and at least 3 distinct buyers in the last 20 slots.

One fixed 0.05 SOL stake per coin, no pyramiding, no adds — breadth over concentration, so the score cannot lean on one coin. Exits: +35% take-profit, −18% hard stop, 25% trailing stop once +10% up, a single ≥ 2 SOL sell (dump signal), negative flow over 15 slots, or a 1200-slot time box. When the coin count lags the pace (30 coins over the 24h window), the entry loosens in fixed steps instead of probe-trading.

## Run it

The grader runs `node /bot/main.ts` (Node 22.18+, no install, no dependencies). The bot speaks `agent-fun/replay/v2` over stdin/stdout via the vendored SDK shim in `vendor/makefun-bot.ts`.

## Files

- `main.ts` — entrypoint: wires the strategy into the replay shim.
- `strategy.ts` — the second-leg retest strategy (pure function of the batches; no clock, no randomness, no I/O).
- `vendor/makefun-bot.ts` — the kit's replay protocol shim, vendored byte for byte.
