# OS Retrofit — Settlement Prover (slot 20)

Date: 2026-09-23 · OPERATION RETROFIT Wave 2 · Constitution: AGENT-OPERATING-FRAMEWORK-2026-09-23

## What changed (this retrofit)
- Brand: official CWI logo (`brand/logo.jpg`) in the page header; Cumulative Web Inc header/footer identity on every page.
- CTA + try-link: visible "Try it live" strip with a working deep link, plus a business/support secondary CTA.
- Metadata: `llms.txt`, `.well-known/agent-card.json`, `content.json`, JSON-LD `WebApplication` schema.org block, canonical + Open Graph + Twitter tags.
- Marketing: value proposition above the fold; honest-limits copy retained verbatim (truth labels NEVER upgraded).
- Business: $0 free tool; commercial/support route via hp@cumulativeweb.com; attribution via the app's own machine-readable receipts and deep links (no third-party trackers).
- OS fit: nervous-system project state `os-retrofit-20-settlement-prover` with evidence-graded claims; 21-gate theorem verdict recorded.

## Red-team pass (2026-09-23)
- Keyless by design: public RPCs only, multi-endpoint failover. Unreachable RPCs yield RATE_LIMITED, never a fabricated verdict.
- RPC-returned fields (attacker-influenced via tx choice) are rendered through esc() before innerHTML; JSON view via textContent.
- v1 proves native transfers only; contract interactions -> UNSUPPORTED (honest refusal, not a guess).

## Secret scan (2026-09-23)
Pattern scan over the full repo (api keys, secrets, tokens, private keys): **0 hits**.


## Tests
node --test tests/prover.test.js — 29/29 (fixtures, deterministic)

## Truth-label discipline
No label changed in this retrofit. UNVERIFIED stays UNVERIFIED; honest-limits copy untouched.
