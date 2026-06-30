<h1 align="center">@nirholas/x402-server</h1>

<p align="center"><strong>The seller side of <a href="https://x402.org">x402</a> — turn any HTTP endpoint into a paid one in a few lines. Build the 402 challenge, verify and settle the payment, run the work, return the receipt.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nirholas/x402-server"><img alt="npm" src="https://img.shields.io/npm/v/@nirholas/x402-server?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@nirholas/x402-server"><img alt="downloads" src="https://img.shields.io/npm/dm/@nirholas/x402-server?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@nirholas/x402-server?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@nirholas/x402-server?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#optional-three-token">Optional $THREE token</a> ·
  <a href="#payment">Payment</a>
</p>

---

> `@nirholas/x402-server` is the **seller** half of x402: the middleware and
> primitives that make an endpoint demand payment. Wrap a route with `paid()`
> and it answers an unpaid request with a `402 Payment Required` challenge —
> listing what it `accepts` (asset · amount · network · pay-to) — then, on the
> retry that carries an `X-PAYMENT` header, it verifies the payment, runs your
> handler, settles on-chain, and returns the result with an `X-PAYMENT-RESPONSE`
> receipt. It speaks two lanes: **Solana** (facilitator-settled SPL
> `transferChecked`) and **EVM / Base** (gasless
> [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
> `transferWithAuthorization`). It never signs or pays — pair it with any x402
> buyer-side client; they pay, this charges.

## Why

x402 revives HTTP `402 Payment Required` as a real payment rail: a server
answers a request with a `402` whose body lists its `accepts[]`, the client
pays, and re-sends the request with an `X-PAYMENT` header. The buyer side is a
solved problem — drop in a fetch wrapper and it pays. **The seller side is where
everyone reinvents the same machinery:** build the challenge envelope in the
exact v2 shape, advertise the right asset/fee-payer per chain, parse the
`X-PAYMENT` header, call a facilitator's `/verify`, run the work *only after*
verification, settle *only after* the work succeeds, emit the receipt, and
(optionally) skim a fee out of the price without double-charging the buyer.

This package is that machinery, done once:

- **One wrapper, a paid route.** `paid({ price, asset, payTo })` emits the 402
  and gates your handler behind a verified payment.
- **Two lanes, one API.** Solana and Base/EVM accepts come from the same config;
  the challenge advertises both and the buyer picks.
- **Settle after the work, never before.** Verification gates the handler;
  settlement runs after it returns `200`. A failed call moves no funds, so a
  retry can't double-charge.
- **Optional fee without surprise-billing.** A fee is split out of the listed
  price — the buyer's total is never marked up, and the fee ships inert (rate
  `0`, no recipient) until you turn it on.
- **USDC by default, $THREE optional.** USDC is the default settlement asset; an
  optional `$THREE` Solana SPL token can be advertised alongside it.

## Install

```bash
npm install @nirholas/x402-server
```

Node 18+ (uses the global `fetch`). Zero runtime dependencies. Framework-agnostic:
works as Express/Connect middleware, a Fastify hook, or a bare `(req, res)`
handler on Vercel / Node `http`, and a fetch-style `(request) => Response`
handler via the `fetchAdapter`.

### Configure your facilitator

This package never bakes in a facilitator host. Point it at your own facilitator
(the service that runs `/verify` and `/settle`) with either the `facilitator`
option or the `X402_FACILITATOR_URL` environment variable:

```bash
export X402_FACILITATOR_URL="https://your-facilitator.example.com"
```

Resolution order: the explicit `facilitator`/`baseUrl` option → `X402_FACILITATOR_URL`
→ empty. `buildChallenge` and `feeSplit` need no facilitator at all; only
`verifyPayment`, `settlePayment`, and `paid()` reach out to one.

## Quick start

### The one-liner — `paid()`

Wrap a handler. Unpaid requests get a `402`; paid ones run the handler:

```js
import { paid } from '@nirholas/x402-server';

export default paid(
  { price: '10000', asset: 'usdc', payTo: { base: '0xYourPayoutAddress' }, network: ['base'] },
  async (req, res) => {
    res.json({ summary: await summarize(req.body.text) });
  },
);
```

`price` is in **atomic units** of the asset — `'10000'` is `$0.01` of 6-decimal
USDC. The first unpaid `GET`/`POST` returns the challenge; the buyer pays and
re-sends with `X-PAYMENT`; your handler runs once, settlement lands, and the
response carries the on-chain receipt.

### A fuller route — both lanes, a fee, a receipt

```js
import { paid } from '@nirholas/x402-server';

export default paid(
  {
    price: '50000',                 // $0.05 USDC (6-decimal atomics)
    asset: 'usdc',
    payTo: {
      solana: 'YourSolanaPayToAddress',   // SPL pay-to
      base:   '0xYourEvmPayoutAddress',    // EVM pay-to
    },
    network: ['solana', 'base'],    // advertise both accepts; buyer chooses
    feePayer: 'YourFacilitatorFeePayer',   // required for a Solana accept
    feeBps: 250,                    // 2.5% fee, split out of the price
    feeTo:  'YourFeeRecipient',
    description: 'Document summarization',
    serviceName: 'Acme Summarize',
  },
  async (req, res, payment) => {
    // `payment` is the verified payer + accept — present only on a paid call.
    const out = await summarize(req.body.text);
    res.json({ summary: out, billedTo: payment.payer });
  },
);
```

### A fetch-style handler — `(request) => Response`

For Workers, Deno, Bun, or any Web `Request`/`Response` runtime, pass the
built-in `fetchAdapter`:

```js
import { paid, fetchAdapter } from '@nirholas/x402-server';

export default {
  fetch: paid(
    {
      price: '10000', asset: 'usdc',
      payTo: { base: '0xYourPayoutAddress' }, network: ['base'],
      adapter: fetchAdapter,
    },
    async (request, payment) => {
      const { text } = await request.json();
      return Response.json({ summary: await summarize(text), billedTo: payment.payer });
    },
  ),
};
```

### Under the hood — the raw 402 → verify → settle flow

`paid()` wraps four primitives you can drive directly when you don't want the
middleware:

```js
import {
  buildChallenge,   // → the 402 envelope (x402Version, resource, accepts[], extensions)
  verifyPayment,    // X-PAYMENT header → { ok, payer, accept } (calls the facilitator /verify)
  settlePayment,    // verified payment → on-chain settlement + receipt
  feeSplit,         // (price, bps, recipient) → { net, fee, recipient }
} from '@nirholas/x402-server';

export default async function handler(req, res) {
  const accepts = buildChallenge({
    price: '50000',
    asset: 'usdc',
    payTo: { base: '0xYourPayoutAddress' },
    network: ['base'],
    resourceUrl: req.url,
  }).accepts;

  const header = req.headers['x-payment'];
  if (!header) {
    // 1 — challenge. Body + base64 PAYMENT-REQUIRED header (a discovery crawler reads both).
    const body = buildChallenge({ resourceUrl: req.url, accepts });
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
    return res.end(JSON.stringify(body));
  }

  // 2 — verify the X-PAYMENT against the same accepts. No work runs if this fails.
  const v = await verifyPayment({ paymentHeader: header, requirements: accepts });
  if (!v.ok) { res.statusCode = 402; return res.end(JSON.stringify(v.body)); }

  // 3 — run the work, THEN settle (never before — a failed call moves no funds).
  const result = await summarize(req.body.text);
  const settled = await settlePayment({ verified: v });

  res.setHeader('X-PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify(settled)).toString('base64'));
  res.json({ result, payer: v.payer, tx: settled.transaction });
}
```

The order is always **verify → dispatch → settle**. Settlement is the last step,
so a handler that throws never charges.

## API

### `paid(options, handler) → (req, res) => void`

Wrap a request handler so it requires payment. Returns a standard `(req, res)`
function — mount it as Express/Connect middleware, a Vercel function, or a Node
`http` handler. Pass `adapter: fetchAdapter` to get a `(request) => Response`
handler instead.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `price` | `string` | — (**required**) | Amount in **atomic units** of the asset (`'10000'` = `$0.01` of 6-decimal USDC). |
| `asset` | `'usdc' \| 'three' \| { solana?, base? }` | `'usdc'` | Settlement asset. `'usdc'` resolves the canonical USDC mint/contract per chain; `'three'` resolves the optional $THREE SPL token (Solana-only); an object pins explicit addresses. |
| `payTo` | `{ solana?, base? }` | — (**required**) | Pay-to address per lane. At least one chain is required. |
| `network` | `('solana' \| 'base' \| 'base-sepolia')[]` | from `payTo` | Which accepts to advertise. Solana leads when both are present. |
| `feePayer` | `string` | — | Facilitator sponsor account. **Required for a Solana accept.** |
| `acceptThree` | `boolean` | `false` | Also advertise the optional $THREE SPL token on the Solana lane (a second accept, after USDC). |
| `threeAmount` | `string` | `price` | Atomic $THREE amount (6 decimals) for the `acceptThree` entry. Omit to reuse `price`. |
| `feeBps` | `number` | `0` | Fee in basis points, **split out of `price`** (≤ `1000` / 10%). `0` = no fee. |
| `feeTo` | `string` | — | Fee recipient. Required when `feeBps > 0` — no recipient, no fee. |
| `facilitator` | `string` | `X402_FACILITATOR_URL` env | Override the x402 facilitator base URL used for `/verify` + `/settle`. |
| `maxTimeoutSeconds` | `number` | `60` | How long the buyer has to land the signed payment. |
| `description` | `string` | — | Human label for the `resource` in the challenge (shown in wallets). |
| `serviceName` / `tags` / `iconUrl` | `string` / `string[]` / `string` | — | Discovery metadata echoed into the challenge. |
| `onSettled` | `(receipt) => void` | — | Fired after a successful settlement — record the call, fire a webhook. |
| `adapter` | `PaidAdapter` | node `(req,res)` | Pass `fetchAdapter` for a `(request) => Response` runtime. |

**Handler** — `(req, res, payment) => unknown`. `payment` is present only on a
paid call: `{ payer, network, accept, amount }`. Throwing from the handler
returns its error to the buyer and **skips settlement** — no funds move.

### `buildChallenge(options) → Challenge`

Build the v2 `402` envelope. Returns `{ x402Version, error, resource, accepts,
extensions }`; the same object is what you base64 into the `PAYMENT-REQUIRED`
header. Needs no facilitator. You can pass the ergonomic `{ price, asset, payTo,
… }` shape (above) or a pre-built `accepts[]`:

```ts
{ scheme: 'exact', network, asset, payTo, amount, maxTimeoutSeconds,
  extra: { name, decimals, feePayer? } }   // feePayer required on Solana
```

### `verifyPayment({ paymentHeader, requirements }) → Promise<VerifyResult>`

Decode the base64 `X-PAYMENT` header and verify it against `requirements` (your
`accepts[]`) via the facilitator's `/verify`. Returns `{ ok, payer, accept }` on
success, or `{ ok: false, body }` (a fresh `402` body) on a rejected/under-paid
payment. **Call your handler only when `ok`.** A facilitator outage throws a
typed `X402Error` (status `502`) rather than rejecting the payment.

### `settlePayment({ verified }) → Promise<Receipt>`

Settle the verified payment and return the receipt
`{ network, payer, transaction }`. Run this **after** the work succeeds. The
returned object is what you base64 into the `X-PAYMENT-RESPONSE` header.

### `feeSplit(priceAtomics, bps, recipient) → FeeSplit | null`

Split a fee out of the listed price: `fee = floor(price × bps / 10_000)`,
`net = price − fee`. Returns `null` when no fee applies (rate `0`, no recipient,
or a sub-atomic fee) so the buyer is charged the full price and the creator
receives all of it. `bps` is clamped to `[0, 1000]`.

```js
import { feeSplit } from '@nirholas/x402-server';

feeSplit('1000000', 250, 'YourFeeRecipient');
// → { price: '1000000', net: '975000', fee: '25000', bps: 250, recipient: 'YourFeeRecipient' }
```

### `createX402Server(options) → client`

Create a client bound to a facilitator URL, `fetch`, and optional auth headers —
useful to reuse a facilitator override or custom `fetch` across many routes.
Returns `{ buildChallenge, verifyPayment, settlePayment, paid }`.

```js
import { createX402Server } from '@nirholas/x402-server';

const server = createX402Server({ facilitator: 'https://your-facilitator.example.com' });
```

## How it works

```
buyer request (no X-PAYMENT)
        │
        ▼
   ┌──────────────┐  402  ┌──────────────────────────────────────────────┐
   │ buildChallenge├──────▶ accepts[]:  Solana (exact, feePayer)          │
   │              │       │             Base/EVM (EIP-3009 transferWith…) │
   └──────────────┘       └──────────────────────────────────────────────┘
        │ buyer signs (wallet) and retries with X-PAYMENT
        ▼
   verifyPayment ──▶ facilitator /verify ──▶ { ok, payer, accept }
        │ ok
        ▼
   your handler runs the work  ◀── settlement has NOT happened yet
        │ returns 200
        ▼
   settlePayment ──▶ on-chain settle ──▶ X-PAYMENT-RESPONSE receipt
```

On **Solana** the accept advertises a `feePayer` (the facilitator's sponsor
account); the buyer's wallet signs an SPL `transferChecked` of the named mint to
`payTo`, the facilitator co-signs as fee payer and lands it — the buyer pays no
SOL gas. On **Base/EVM** the buyer signs an EIP-3009 `transferWithAuthorization`
typed-data message locally (no on-chain tx, no gas) and the facilitator submits
it; settlement is verified by scanning the mined tx for a USDC `Transfer` to
`payTo` of at least the expected amount.

### Lanes

| Lane | Network id | Scheme | Buyer signs | Gas |
|---|---|---|---|---|
| **Solana** | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `exact` | SPL `transferChecked` (facilitator co-signs) | facilitator pays |
| **Base** | `eip155:8453` | `exact` (EIP-3009) | `transferWithAuthorization` typed data | facilitator pays |
| Base Sepolia | `eip155:84532` | `exact` (EIP-3009) | same | facilitator pays |

Solana leads the `accepts[]` so first-accept clients settle there; advertise
`network: ['base']` (or both) to lead with EVM. The same envelope is also base64
into the `PAYMENT-REQUIRED` response header so a discovery crawler can read it
off the header during a probe request.

## Optional $THREE token

USDC is the default and works with zero extra config. If you also want to accept
`$THREE` — a Solana SPL token (mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`,
6 decimals) — advertise it alongside USDC on the Solana lane with `acceptThree`:

```js
import { paid } from '@nirholas/x402-server';

export default paid(
  {
    price: '50000',                 // USDC amount (atomic)
    payTo: { solana: 'YourSolanaPayToAddress' },
    feePayer: 'YourFacilitatorFeePayer',
    acceptThree: true,              // adds a second Solana accept for $THREE
    threeAmount: '50000',           // optional $THREE amount; defaults to `price`
  },
  async (req, res) => res.json({ ok: true }),
);
```

The challenge then lists two Solana accepts — USDC first, then `$THREE` — so a
wallet's token chooser surfaces both while a first-accept client still settles
USDC. To make `$THREE` the *only* asset on a route, set `asset: 'three'` (Solana
only — advertising it on an EVM lane is rejected). `$THREE` is entirely opt-in;
omit these options and the route is USDC-only.

## Payment

Prices are quoted and charged in **atomic units** of the settlement asset — USDC
is 6-decimal, so `1_000_000` = `$1.00`. The buyer's total is exactly `price`;
the fee (when configured) is carved *out* of it:

| `feeBps` | On a `$1.00` (`1000000`) call | Creator nets | Fee |
|---|---|---|---|
| `0` (default) | buyer pays `$1.00` | `$1.00` | — |
| `250` (2.5%) | buyer pays `$1.00` | `$0.975` | `$0.025` |
| `1000` (10%, max) | buyer pays `$1.00` | `$0.90` | `$0.10` |

The fee applies **only** when both `feeBps > 0` **and** `feeTo` is set, so an
unconfigured server charges nothing — the fee feature ships inert and never
surprise-bills on deploy.

## Errors & edge cases

`verifyPayment` returns a structured result rather than throwing on a bad
payment, and `paid()` maps every state to the right HTTP status:

| Code | HTTP | Meaning | What the buyer sees / does |
|---|---|---|---|
| `payment_required` | 402 | No `X-PAYMENT`, or the header failed `/verify`. | A fresh challenge — pay and retry. |
| `invalid_payment` | 402 | The signed tx doesn't pay the declared amount/asset/recipient. | Re-sign against the advertised accept. |
| `missing_fee_payer` | 422 | A Solana accept omitted `feePayer`. | Server misconfig — set the facilitator sponsor account. |
| `unsupported_network` | 400 | Buyer paid a network the route doesn't advertise. | Pick an advertised accept. |
| `facilitator_unreachable` | 502 | The facilitator `/verify` or `/settle` is down. | **No funds moved** — safe to retry. |
| `settle_uncertain` | 502 | Verified + work ran, but settlement status is unknown. | Check on-chain before retrying to avoid double-pay. |

Two invariants make these safe: verification runs **before** your handler (a bad
payment never triggers the work), and settlement runs **after** it (a failed
handler never charges). An upstream `429` can be retried with the *same* signed
payment, because settlement only happens once the work succeeds.

## Examples

**Express — meter an existing API**

```js
import express from 'express';
import { paid } from '@nirholas/x402-server';

const app = express();
app.use(express.json());

app.post('/v1/embed', paid(
  { price: '2000', asset: 'usdc', payTo: { base: '0xYourPayoutAddress' }, network: ['base'] },
  async (req, res) => res.json({ vector: await embed(req.body.text) }),
));

app.listen(3000);
```

**Vercel / Node `http` — a paid serverless function**

```js
import { paid } from '@nirholas/x402-server';

export default paid(
  { price: '100000', asset: 'usdc', payTo: { base: '0xYourPayoutAddress' }, network: ['base'] },
  async (req, res, payment) => {
    res.json({ report: await generate(req.body.topic), billedTo: payment.payer });
  },
);
```

**Sell a tool, record every call**

```js
export default paid(
  {
    price: '5000', asset: 'usdc',
    payTo: { base: '0xYourPayoutAddress' }, network: ['base'],
    serviceName: 'Pose seeds', tags: ['3d', 'animation'],
    onSettled: (receipt) => recordCall(receipt),   // feed your dashboard / webhook
  },
  async (req, res) => res.json({ seed: await poseSeed(req.body.prompt) }),
);
```

Any x402 buyer-side client calls these with a plain `fetch` — the `402` is paid
automatically and the result comes back as if the endpoint were free.

## License

MIT © nirholas
