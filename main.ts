// Entry rule in one line: buy only the reclaim — a curve that ran to a high, dipped >= 12%
// below it, and is now back within 3% of the high on fresh buying. One fixed 0.08 SOL stake
// per coin, no adds; exits are +35% take-profit, -18% stop, 25% trailing stop, dump/fade
// signals, or a 1200-slot time box. See strategy.ts for the full design.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
