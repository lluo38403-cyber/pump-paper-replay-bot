# Pump Paper Replay Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/lluo38403-cyber/pump-paper-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/lluo38403-cyber/pump-paper-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A momentum trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24-hour replay of recorded pump.fun bonding-curve activity. Nothing here trades for real.

## Strategy

Most new pump.fun coins go to zero; a few run far. The bot only buys a coin once its early tape already shows real crowd buying:

- **Survivor first:** at least 800 slots since its CreateEvent and at least 20 SOL of real reserves, so fresh bundled launches that get dumped are skipped.
- **Crowd buying:** over a rolling 60-slot window, at least 5 trades, 5 buys, 6 distinct buying wallets, and net inflow of at least 3 SOL.
- **Rising and holding:** price up at least 10% over the window (but no more than 50%), sitting within 10% of the window high, with inflow accelerating into the newer half of the window.
- **One small bet per coin:** a single 0.05 SOL buy, one entry per coin — pyramiding into strength lost more on the dev window, so there is none.

It exits whole on the first of: a 15% stop loss against cost, a 35% trailing stop from its peak (armed at +50%), a 3000-slot time limit (unless up 20%+), or net inflow turning below −1.5 SOL over 40 slots. A curve that completes is closed by the replay itself.

A guardrail probe keeps the run above the 20-coin bar: if the pace of distinct coins traded lags the target, the bot buys a tiny 0.02 SOL probe of the most liquid curve in the current batch and sells it whole once it lands.

The bot is deterministic by construction: no clock, no randomness, only insertion-ordered maps fed by the batch stream, so its two graded executions agree byte for byte.

## Layout

- `main.ts` — the entrypoint: strategy plus the harness wire loop.
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 shim, vendored byte for byte.
- `.makefun/owner.json` — the claim file naming the payout wallet.

## Run it locally

Grade it on the dev window the way the server does (needs the kit unpacked next to this repo):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

## License

MIT. See [LICENSE](LICENSE).
