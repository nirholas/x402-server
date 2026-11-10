---
name: paywall-an-endpoint
description: Put an x402 paywall in front of an HTTP endpoint with the @three-ws/x402-server library: price it in USDC or $THREE on Solana, verify the buyer's X-PAYMENT header, settle after delivery, and optionally take a platform fee. Use when a Node service should charge per call.
---

# Paywall an endpoint with @three-ws/x402-server

This plugin is a skill only. There is no MCP server. The library is the seller half of x402 and never signs or pays. Install it in the user's Node project:

```
npm install @three-ws/x402-server
```

## The one-call path: `paid(options, handler)`

`paid` wraps a handler so unpaid requests get a 402 challenge and paid ones run verify, then the handler, then settle. It works as Express or Connect middleware, as a plain Node `(req, res)` handler, or with `{ adapter: fetchAdapter }` as a fetch-style `(request) => Response` handler.

```js
import express from 'express';
import { paid } from '@three-ws/x402-server';

const app = express();
app.use(express.json());

app.post('/v1/embed', paid(
  {
    price: '2000',                       // atomic units, whole-number string (USDC has 6 decimals)
    asset: 'usdc',                       // or 'three'
    payTo: { solana: '<your Solana address>' },
    feePayer: '<facilitator sponsor address>',
    description: 'Text embedding',
    serviceName: 'My API',
    onSettled: (receipt) => console.log(receipt.transaction),
  },
  async (req, res, payment) => {
    res.json({ result: await work(req.body), billedTo: payment.payer });
  },
));
```

Options read from the source: `price`, `asset` (`usdc` default, or `three`), `payTo` (an object keyed by lane, here `solana`), `network`, `feePayer`, `facilitator`, `maxTimeoutSeconds`, `description`, `serviceName`, `tags`, `iconUrl`, `onSettled`, `streaming`, `adapter`, `feeBps` and `feeTo`.

- `price` must be a whole-number string in atomic units. Anything else throws `invalid_input`.
- The Solana accept needs a sponsor `feePayer`. If the option is omitted the library reads the `X402_FEE_PAYER_SOLANA` environment variable.
- Default order is deliver-then-settle: the response is buffered, the payment settles, then the 200 is sent with the `X-PAYMENT-RESPONSE` receipt. Set `streaming: true` for handlers that write their own body (downloads, SSE). Settlement then runs first.
- Advertise both main assets on the Solana lane with `acceptThree: true` (and an optional `threeAmount` atomic string) through `buildChallenge`. `$THREE` has 6 decimals.
- A platform fee is carved out of the price, never added on top. `feeBps` above 0 requires `feeTo`, and the rate is clamped to 1000 bps (10%).
- `facilitator` overrides the settlement service for a route. The default is the library's `DEFAULT_FACILITATOR_URL`.

## Lower-level primitives

For custom frameworks use `createX402Server({ facilitator, fetch, apiKey, headers })` or the top-level functions:

- `buildChallenge(opts)` returns the v2 envelope `{ x402Version, error, resource, accepts, extensions }` to base64 into the `PAYMENT-REQUIRED` header.
- `verifyPayment({ paymentHeader, requirements })` returns `{ ok: true, payer, accept, raw }` or `{ ok: false, code, reason, body }`. Run the work only when `ok`.
- `settlePayment({ verified })` returns `{ network, payer, transaction, raw }` for the `X-PAYMENT-RESPONSE` header. Run it after the work succeeds, never before.
- `feeSplit(priceAtomics, bps, recipient)` returns the price, net, fee and recipient split.

## Rules for the agent

- Use real recipient and fee-payer addresses supplied by the user. Do not invent addresses and do not put a private key in code. This library never needs one.
- Test locally with the loopback pattern in `examples/loopback-demo.mjs` (a local stub facilitator). Real deployments point `facilitator` at a live settlement service that moves real funds, so ask the user before pointing a route at one.
- Pair it with `@three-ws/x402-fetch` on the buyer side when writing an end-to-end test.
