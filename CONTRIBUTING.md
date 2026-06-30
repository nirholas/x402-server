# Contributing to `@three-ws/x402-server`

Thanks for helping improve the seller side of x402. This package is small, sharp,
and deliberately **zero-dependency** — contributions should keep it that way.

## Ground rules

1. **Zero runtime dependencies.** `dependencies` in `package.json` stays empty.
   The SDK runs on the platform `fetch` and nothing else. If you reach for a
   dependency, open an issue first to discuss — the bar is very high.
2. **Node 18+, framework-agnostic.** Code must run on Node 18+, Bun, Deno, and
   Cloudflare Workers. Don't assume Node-only globals beyond `Buffer` (which is
   already guarded with a browser/Workers fallback).
3. **The verify → dispatch → settle invariant is sacred.** Work runs only after a
   valid payment; funds move only after the work succeeds. Any change near
   `verifyPayment` / `settlePayment` / `paid()` must preserve this ordering and
   its failure semantics (a handler throw skips settlement; a facilitator outage
   is a typed `502`, never a silent rejection).
4. **No mocks or fake data in shipped code.** Tests use a scripted `fetch` double;
   never hardcode a real third-party mint, creator, or holder address. Use the
   synthetic placeholders already in the test file (e.g.
   `THREEsynthetic1111…`). `$THREE` (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`)
   is the one canonical mint that may appear.

## Getting started

```bash
git clone https://github.com/nirholas/x402-server.git
cd x402-server
npm install      # installs nothing (zero deps) but sets up the workspace
npm test         # runs the node:test suite — all tests must pass
```

The whole SDK is two files:

- `src/index.js` — challenge construction, fee split, verify/settle, the
  `paid()` middleware factory, and the node + fetch adapters.
- `src/http.js` — the zero-dependency HTTP core, `X402Error`, and
  `PaymentRequiredError`.

Types live in `src/index.d.ts` and must be kept in sync with the runtime.

## Tests

```bash
npm test
```

Tests are `node --test test/*.test.js` — no test framework dependency. Every
behavior change needs a test:

- New option or branch in `buildChallenge` → assert the resulting `accepts[]`.
- New verify/settle behavior → drive it through the `stubFetch` double and assert
  on both the **request shaping** (what we POST to the facilitator) and the
  **response parsing** (the result/receipt shape).
- New error path → assert the `X402Error` `code` and `status`.

Keep tests deterministic and offline — no real network, no real facilitator.

## Coding style

- Match the existing style: small functions, clear boundaries, comments that
  explain *why* (the wire-format gotchas), not *what*.
- Throw `X402Error` with a stable `code` and an HTTP `status` for every failure a
  caller might branch on. Don't invent a new code without documenting it in
  [`docs/api.md`](./docs/api.md#error-codes).
- Update [`docs/api.md`](./docs/api.md) and the [README](./README.md) tables in
  the same PR as any public-surface change. Stale docs are a failing change.

## Submitting a change

1. Branch from `main`.
2. Make the change, add/extend tests, update the types and docs.
3. `npm test` — all tests green.
4. Open a PR describing the behavior change and why. Reference any issue.

## Reporting bugs

Open an issue at <https://github.com/nirholas/x402-server/issues> with:

- the version, runtime (Node/Bun/Deno/Workers) and version,
- a minimal repro (ideally a failing test against the `stubFetch` double),
- expected vs. actual behavior, and the `X402Error` `code`/`status` if one was
  thrown.

## License

By contributing you agree your contributions are licensed under the project's
proprietary license. Proprietary — Copyright (c) 2026 nirholas. All Rights Reserved.
Unauthorized use, copying, modification, or distribution is prohibited. See [LICENSE](./LICENSE).
