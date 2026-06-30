# Examples — `@three-ws/x402-server`

Runnable recipes for the seller side of x402. Each is complete — copy it, set
your facilitator and payout addresses, and run it. For the full API see
[api.md](./api.md); for the overview see the [README](../README.md).

> **Before you run any of these:** point the SDK at your facilitator (the service
> that runs `/verify` and `/settle`) and set your payout addresses.
>
> ```bash
> export X402_FACILITATOR_URL="https://your-facilitator.example.com"
> ```
>
> Prices are **atomic units**: 6-decimal USDC means `'10000'` = `$0.01`,
> `'1000000'` = `$1.00`.

## Contents

1. [Express seller — meter an existing API](#1-express-seller--meter-an-existing-api)
2. [Vercel serverless function](#2-vercel-serverless-function)
3. [Raw Node `http` handler (no framework)](#3-raw-node-http-handler-no-framework)
4. [USDC-only — both lanes, with a fee](#4-usdc-only--both-lanes-with-a-fee)
5. [USDC + optional `$THREE`](#5-usdc--optional-three)
6. [Fetch-style runtime (Workers / Deno / Bun)](#6-fetch-style-runtime-workers--deno--bun)
7. [Reusable client + record every call](#7-reusable-client--record-every-call)

---

## 1. Express seller — meter an existing API

The fastest path: wrap an existing route handler with `paid()`.

```js
// express-seller.mjs  →  node express-seller.mjs
import express from 'express';
import { paid } from '@three-ws/x402-server';

const app = express();
app.use(express.json());

// Your real work — unchanged.
async function embed(text) {
  return Array.from(text).slice(0, 8).map((c) => c.charCodeAt(0) / 255);
}

app.post('/v1/embed', paid(
  {
    price: '2000',                          // $0.002 USDC
    asset: 'usdc',
    payTo: { base: '0xYourPayoutAddress' }, // your EVM payout address
    network: ['base'],
  },
  async (req, res, payment) => {
    const vector = await embed(String(req.body?.text ?? ''));
    res.json({ vector, billedTo: payment.payer });
  },
));

app.listen(3000, () => console.log('paid embed API on http://localhost:3000'));
```

Unpaid `POST /v1/embed` → `402` with the challenge. A buyer-side x402 client pays
and re-sends; the handler runs once, settlement lands, and the response carries
the `X-PAYMENT-RESPONSE` receipt.

---

## 2. Vercel serverless function

`paid()` returns a standard `(req, res)` handler — drop it straight into
`api/`.

```js
// api/report.mjs  (Vercel)
import { paid } from '@three-ws/x402-server';

async function generate(topic) {
  return `Report on ${topic}: …`;
}

export default paid(
  {
    price: '100000',                        // $0.10 USDC
    asset: 'usdc',
    payTo: { base: '0xYourPayoutAddress' },
    network: ['base'],
    description: 'On-demand research report',
  },
  async (req, res, payment) => {
    const report = await generate(req.body?.topic ?? 'AI agents');
    res.json({ report, billedTo: payment.payer });
  },
);
```

Set `X402_FACILITATOR_URL` in your Vercel project env. That's all the wiring the
function needs.

---

## 3. Raw Node `http` handler (no framework)

Drive the four primitives yourself when you want full control over the
verify → dispatch → settle flow.

```js
// raw-seller.mjs  →  node raw-seller.mjs
import { createServer } from 'node:http';
import { buildChallenge, verifyPayment, settlePayment } from '@three-ws/x402-server';

const ROUTE = {
  price: '50000',                         // $0.05 USDC
  asset: 'usdc',
  payTo: { base: '0xYourPayoutAddress' },
  network: ['base'],
};

async function doWork(body) {
  return { summary: String(body?.text ?? '').slice(0, 80) };
}

createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host}${req.url}`;
    const accepts = buildChallenge({ ...ROUTE, resourceUrl: url }).accepts;

    const header = req.headers['x-payment'];
    if (!header) {
      // 1 — challenge. Body + base64 PAYMENT-REQUIRED header.
      const body = buildChallenge({ ...ROUTE, resourceUrl: url });
      res.statusCode = 402;
      res.setHeader('content-type', 'application/json');
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
      return res.end(JSON.stringify(body));
    }

    // 2 — verify. No work runs unless the payment is valid.
    const verified = await verifyPayment({ paymentHeader: header, requirements: accepts });
    if (!verified.ok) {
      res.statusCode = verified.status;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(verified.body));
    }

    // 3 — dispatch the work, THEN settle (a throw here moves no funds).
    const result = await doWork(await readJson(req));
    const receipt = await settlePayment({ verified });

    res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify(receipt)).toString('base64'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, payer: verified.payer, tx: receipt.transaction }));
  } catch (err) {
    // X402Error: err.code, err.status (502 for facilitator faults), err.body
    res.statusCode = err.status ?? 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err.code ?? 'error', message: err.message }));
  }
}).listen(3000, () => console.log('raw paid endpoint on :3000'));

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
```

---

## 4. USDC-only — both lanes, with a fee

Advertise Solana **and** Base from one config and take a 2.5% platform cut, split
*out* of the price (the buyer pays exactly `price`).

```js
// dual-lane.mjs
import { paid } from '@three-ws/x402-server';

export default paid(
  {
    price: '1000000',                       // $1.00 USDC
    asset: 'usdc',
    payTo: {
      solana: 'YourSolanaPayToAddress',     // SPL pay-to
      base:   '0xYourEvmPayoutAddress',      // EVM pay-to
    },
    network: ['solana', 'base'],            // advertise both; buyer chooses
    feePayer: 'YourFacilitatorFeePayer',    // required for the Solana accept
    feeBps: 250,                            // 2.5% fee, carved out of price
    feeTo:  'YourFeeRecipient',
    description: 'Document summarization',
    serviceName: 'Acme Summarize',
  },
  async (req, res, payment) => {
    res.json({ summary: 'done', billedTo: payment.payer, network: payment.network });
  },
);
```

Preview the split without an HTTP call:

```js
import { feeSplit } from '@three-ws/x402-server';
feeSplit('1000000', 250, 'YourFeeRecipient');
// → { price: '1000000', net: '975000', fee: '25000', bps: 250, recipient: 'YourFeeRecipient' }
```

The buyer pays `$1.00`; your creator nets `$0.975`; `$0.025` goes to `feeTo`.

---

## 5. USDC + optional `$THREE`

`$THREE` is an **optional** Solana SPL token (mint
`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`, 6 decimals). USDC stays the
default; `acceptThree: true` advertises `$THREE` *alongside* USDC on the Solana
lane, so a wallet's token chooser surfaces both while a first-accept client still
settles USDC.

```js
// usdc-plus-three.mjs
import { paid } from '@three-ws/x402-server';

export default paid(
  {
    price: '50000',                         // $0.05 USDC (the default asset)
    payTo: { solana: 'YourSolanaPayToAddress' },
    feePayer: 'YourFacilitatorFeePayer',
    acceptThree: true,                      // adds a 2nd Solana accept for $THREE
    threeAmount: '50000000',                // 50 $THREE (6-decimal atomics); omit to reuse `price`
    description: 'Pose seed generation',
  },
  async (req, res, payment) => {
    res.json({ ok: true, asset: payment.accept.extra.name }); // "USDC" or "THREE"
  },
);
```

To make `$THREE` the **only** asset on a route (Solana-only — an EVM lane
throws), set `asset: 'three'`:

```js
import { paid } from '@three-ws/x402-server';

export default paid(
  {
    price: '10000000',                      // 10 $THREE
    asset: 'three',
    payTo: { solana: 'YourSolanaPayToAddress' },
    feePayer: 'YourFacilitatorFeePayer',
  },
  async (req, res) => res.json({ ok: true }),
);
```

Omit `acceptThree` / `asset: 'three'` entirely and the route is USDC-only.

---

## 6. Fetch-style runtime (Workers / Deno / Bun)

Pass the built-in `fetchAdapter` to get a `(request) => Response` handler. The
handler receives `(request, payment)` and returns a `Response`.

```js
// worker.mjs  (Cloudflare Workers / Deno / Bun)
import { paid, fetchAdapter } from '@three-ws/x402-server';

export default {
  fetch: paid(
    {
      price: '10000', asset: 'usdc',
      payTo: { base: '0xYourPayoutAddress' }, network: ['base'],
      adapter: fetchAdapter,
    },
    async (request, payment) => {
      const { text } = await request.json();
      return Response.json({ summary: text.slice(0, 80), billedTo: payment.payer });
    },
  ),
};
```

On Workers, set `X402_FACILITATOR_URL` as a binding, or pass `facilitator: env.X402_FACILITATOR_URL`
in the options.

---

## 7. Reusable client + record every call

Bind a facilitator and auth once with `createX402Server`, then reuse it across
routes. Use `onSettled` to feed a dashboard or webhook on every paid call.

```js
// metered-service.mjs
import express from 'express';
import { createX402Server } from '@three-ws/x402-server';

const server = createX402Server({
  facilitator: process.env.X402_FACILITATOR_URL,
  apiKey: process.env.FACILITATOR_API_KEY,   // → Authorization: Bearer …
});

const app = express();
app.use(express.json());

function recordCall(receipt) {
  // ship to your analytics / billing ledger
  console.log('settled', receipt.network, receipt.payer, receipt.transaction);
}

app.post('/v1/pose-seed', server.paid(
  {
    price: '5000', asset: 'usdc',
    payTo: { base: '0xYourPayoutAddress' }, network: ['base'],
    serviceName: 'Pose seeds', tags: ['3d', 'animation'],
    onSettled: recordCall,                   // fires after every successful settlement
  },
  async (req, res) => res.json({ seed: `seed:${req.body?.prompt ?? ''}` }),
));

app.listen(3000);
```

`onSettled` runs after settlement lands; throwing inside it is swallowed so a
logging error can never unsettle a paid call.
