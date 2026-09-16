# Settlement Prover — CWI (#32)

Agent-to-agent payment settlement has no proof layer. An agent can say "payment sent" but nobody can independently verify it settled. Settlement Prover closes the gap: paste a payment claim (chain, tx hash, expected amount, expected recipient, invoice/memo) and it checks public chain data for:

- **exists** — transaction is on the claimed chain
- **status** — succeeded vs reverted
- **amount** — expected vs observed (wei-exact)
- **recipient** — expected vs observed (case-insensitive)
- **confirmations** — count + probabilistic finality assessment

Verdicts: `SETTLED` / `PENDING` / `FAILED` / `NOT_FOUND` / `MISMATCH` (field-level diffs) / `RATE_LIMITED` / `INVALID_CLAIM` / `UNSUPPORTED`.

## Live
https://cumulativewebinc.github.io/cwi-settlement-prover/

## Engine
`prover.js` — UMD, zero dependencies, runs in browser and Node. Pure verdict logic (`evaluateClaim`) is network-free; only `proveSettlement` touches the network, with multi-endpoint failover and honest rate-limit states. Nothing is ever fabricated: if the RPCs are unreachable, you get `RATE_LIMITED`, not a guess.

## Chains (v1)
- **Base** (8453) — public RPCs, no keys
- **Ethereum** (1) — public RPCs, no keys

## For agents
- Machine-readable schema: `./schema/proofs.schema.json` (`cwi.settlement-proof/1.0`)
- Deep links: `?proof=<chain>:<txhash>[&amount=<eth>][&to=<0x…>]`
- The rendered proof JSON is the settlement receipt — embed it in your own records.

## Dogfood
No CWI x402 transaction hash exists in the monetization workspace (testnet only: 0 settled / 8 rejected, no hashes documented — stated honestly rather than invented). The demo button uses a real, independently verifiable Base mainnet transaction observed 2026-09-16 (~13:20 UTC): `0x0f7bc8d5…f85b45df`, 0.173503114619109366 ETH, status success — verifiable on basescan.org.

## Honest limits
v1 proves **native transfers only** (contract interactions → `UNSUPPORTED`); confirmations are probabilistic (12+ heuristic, reorg risk never zero); SETTLED proves value moved on-chain as claimed — not that goods were delivered. Not financial advice.

## Tests
`node --test tests/` — 28 tests, fixtures only (deterministic, no network).

## i18n
`data-i18n` keys throughout + one-line hook to the shared cwi-i18n module (`data-app="settlement-prover"`); English table in `i18n-tables/en.json`.
