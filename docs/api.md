# API reference — `@three-ws/x402-server`

The complete public surface of the seller-side SDK. Every export, every
signature, every option, return shape, and error. For task-oriented examples see
[examples.md](./examples.md); for the narrative overview see the
[README](../README.md).

All exports are named ESM exports from the package root:

```js
import {
  paid, buildChallenge, verifyPayment, settlePayment, feeSplit,
  createX402Server, fetchAdapter,
  X402Error, PaymentRequiredError,
  X402_VERSION, MAX_FEE_BPS,
  DEFAULT_FACILITATOR_URL, DEFAULT_BASE_URL,
  NETWORK_SOLANA_MAINNET, NETWORK_BASE_MAINNET, NETWORK_BASE_SEPOLIA,
} from '@three-ws/x402-server';
```

---

## Contents

- [Concepts](#concepts) — atomic units, lanes, the verify → dispatch → settle flow
- [Functions](#functions)
  - [`paid()`](#paidoptions-handler)
  - [`buildChallenge()`](#buildchallengeoptions)
  - [`verifyPayment()`](#verifypaymentargs-expected)
  - [`settlePayment()`](#settlepaymentargs)
  - [`feeSplit()`](#feesplitpriceatomics-bps-recipient)
  - [`createX402Server()`](#createx402serveroptions)
- [Objects](#objects)
  - [`fetchAdapter`](#fetchadapter)
- [Errors](#errors)
  - [`X402Error`](#x402error)
  - [`PaymentRequiredError`](#paymentrequirederror)
- [Constants](#constants)
- [Types](#types)
- [Error codes](#error-codes)

---

## Concepts

**Atomic units.** Every `price` / `amount` is a whole-number string in the
asset's smallest unit. USDC and `$THREE` are 6-decimal, so `$1.00` = `'1000000'`,
`$0.01` = `'10000'`. Fractions (`'1.5'`) and non-numeric strings throw
`invalid_input`.

**Lanes.** A *lane* is the ergonomic name for a network: `'solana'`, `'base'`,
`'base-sepolia'`. Each resolves to a CAIP-2 network id
([constants](#constants)). `payTo` and `network` are keyed by lane.

**verify → dispatch → settle.** The fixed order the server enforces. A buyer's
payment is verified against the facilitator *before* your handler runs; your
handler runs (dispatch); settlement happens *after* the handler succeeds. A
handler that throws never settles → no funds move.

---

## Functions

### `paid(options, handler)`

```ts
paid(options: PaidOptions, handler: Function): (...args: any[]) => Promise<unknown>
```

Wrap a request handler so it requires payment. Returns a function whose calling
convention depends on the [`adapter`](#fetchadapter):

- **default (node adapter):** `(req, res, next?) => Promise<…>` — Express /
  Connect / Fastify / Vercel / Node `http`.
- **`adapter: fetchAdapter`:** `(request: Request) => Promise<Response>` —
  Workers / Deno / Bun / edge.

**Behavior**

1. Builds the `402` challenge for the request (using `resourceUrl = ctx.url`).
2. If no `X-PAYMENT` header → responds `402` with the challenge body **and** a
   base64 `PAYMENT-REQUIRED` header.
3. Verifies the header against the route's `accepts[]`. On `ok: false` →
   re-challenges with the fresh 402 body and the rejection's status.
4. Dispatches your handler with `(req, res, payment)` (node) or
   `(request, payment)` (fetch). `payment` = `{ payer, network, amount, accept }`.
5. After the handler succeeds, settles, fires `onSettled(receipt)`, and attaches
   the `X-PAYMENT-RESPONSE` receipt header.

**Options** — `PaidOptions` extends [`BuildChallengeOptions`](#buildchallengeoptions)
with:

| Option | Type | Default | Description |
|---|---|---|---|
| `facilitator` | `string` | `X402_FACILITATOR_URL` env | Per-route facilitator override for `/verify` + `/settle`. |
| `onSettled` | `(receipt: Receipt) => void` | — | Called after a successful settlement. Throwing here is swallowed (a logging error must not unsettle a paid call). |
| `adapter` | `PaidAdapter` | node `(req,res)` | Pass [`fetchAdapter`](#fetchadapter) for a `(request) => Response` runtime. |

Plus all [`buildChallenge` options](#buildchallengeoptions): `price` (required),
`payTo` (required), `asset`, `network`, `feePayer`, `acceptThree`, `threeAmount`,
`feeBps`, `feeTo`, `maxTimeoutSeconds`, `description`, `serviceName`, `tags`,
`iconUrl`.

**Handler**

- node: `async (req, res, payment) => void` — write the response yourself
  (`res.json(...)` / `res.end(...)`). The receipt header is attached afterward if
  the response is still writable; otherwise the receipt is delivered via
  `onSettled`.
- fetch: `async (request, payment) => Response | object` — return a `Response`
  (the receipt header is cloned onto it) or a plain object (JSON-encoded `200`).

`payment` is present only on a paid call: `{ payer, network, amount, accept }`.

**Throws**

- At construction: `X402Error` `code: 'invalid_input'` if `handler` is not a
  function, or if `feeBps > 0` without `feeTo`. `code: 'missing_fee_payer'` is
  thrown lazily at request time when a Solana accept lacks `feePayer` (challenge
  build).
- At request time: facilitator outages surface as `X402Error` `status: 502`
  (`facilitator_unreachable` on `/verify`, `settle_uncertain` / `settle_failed`
  on `/settle`). These propagate out of the returned handler — catch them in your
  framework's error middleware.

---

### `buildChallenge(options)`

```ts
buildChallenge(options: BuildChallengeOptions): Challenge
```

Build the v2 `402` envelope. **No facilitator needed** — pure construction. The
returned object is what you base64 into the `PAYMENT-REQUIRED` header and/or send
as the `402` body.

**Options** — `BuildChallengeOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `price` | `string \| number` | — (**required** unless `accepts` given) | Atomic amount. Whole number string. |
| `asset` | `'usdc' \| 'three' \| { solana?, base? }` | `'usdc'` | Settlement asset (see [`resolveAsset`](#asset-resolution)). |
| `payTo` | `PayTo` | — (**required** unless `accepts` given) | Pay-to per lane. ≥ 1 lane. |
| `network` | `Lane \| Lane[]` | every lane in `payTo` | Lanes to advertise. |
| `feePayer` | `string` | — | Solana facilitator sponsor account. Required for a Solana accept. |
| `acceptThree` | `boolean` | `false` | Add a `$THREE` Solana accept after USDC. |
| `threeAmount` | `string \| number` | `price` | Atomic `$THREE` amount for the `acceptThree` entry. |
| `feeBps` | `number` | — | Fee in bps; clamped to `[0, 1000]`. Surfaces `fee` on the envelope when `> 0` with `feeTo`. |
| `feeTo` | `string` | — | Fee recipient. |
| `maxTimeoutSeconds` | `number` | `60` | Buyer's window to land the payment. Must be a positive integer or it falls back to `60`. |
| `resourceUrl` | `string` | `null` | Resource URL echoed into `resource.url` and each accept's `resource`. |
| `description` | `string` | — | Resource description. |
| `mimeType` | `string` | `'application/json'` | Resource MIME type. |
| `serviceName` | `string` | — | Discovery name (truncated to 32 chars). |
| `tags` | `string[]` | — | Discovery tags (max 5). |
| `iconUrl` | `string` | — | Discovery icon URL. |
| `error` | `string` | `'X-PAYMENT header is required'` | Human reason on the envelope. |
| `accepts` | `Accept[]` | — | Pre-built accepts (raw path). Overrides `price`/`asset`/`payTo`. |
| `extensions` | `Record<string,unknown>` | `{}` | Merged into the envelope `extensions`. |

**Returns** — [`Challenge`](#types):

```ts
{
  x402Version: 2,
  error: string,
  resource: { url: string | null, mimeType: string,
              description?, serviceName?, tags?, iconUrl? },
  accepts: Accept[],          // Solana-first; one per advertised lane (+ $THREE if opted in)
  extensions: Record<string, unknown>,
  fee?: FeeSplit | null,      // only when feeBps > 0 && feeTo
}
```

#### Asset resolution

`asset` resolves to a per-lane mint/contract:

| `asset` value | Solana | Base / Base Sepolia |
|---|---|---|
| `'usdc'` (default) / falsy | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `'three'` | `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump` | **throws** `invalid_input` (Solana-only) |
| `'0x…' / 'Sol…'` (string) | that address on every lane | that address on every lane |
| `{ solana, base }` | `asset.solana` (else USDC) | `asset.base` (else USDC) |

Each accept's `extra` names the token so wallets label it: Solana USDC →
`{ name: 'USDC', decimals: 6, feePayer }`, Solana `$THREE` →
`{ name: 'THREE', decimals: 6, feePayer }`, Base →
`{ name: 'USD Coin', version: '2', decimals: 6 }`.

**Throws** — `X402Error` `code: 'invalid_input'` for missing/non-integer `price`,
missing `payTo`, an unknown lane, a lane in `network` without a matching `payTo`,
a non-integer `threeAmount`, or `asset: 'three'` on a non-Solana lane.
`code: 'missing_fee_payer'` when a Solana accept lacks `feePayer`.

---

### `verifyPayment(args, expected?)`

```ts
verifyPayment(args: VerifyArgs | string, expected?: Accept[] | Accept | Challenge): Promise<VerifyResult>
```

Decode the base64 `X-PAYMENT` header and verify it against your advertised
requirements via the facilitator's `POST /verify`.

**Call shapes**

```js
// Object form (recommended)
await verifyPayment({ paymentHeader, requirements, signal });
// Positional form
await verifyPayment(xPaymentHeaderString, expected);
```

`requirements` / `expected` is normalized from any of: an `Accept[]`, a full
`Challenge` (its `.accepts` is used), a `{ requirements }` or `{ accepts }`
wrapper, or a single `Accept`.

**Matching** — the decoded payload's `network` selects the matching requirement;
if the network isn't offered, the result is `unsupported_network`. With no
network on the payload, the first requirement is used (the facilitator does the
deep EIP-712 / SPL matching).

**Returns** — [`VerifyResult`](#types) = `Verified | Rejected`:

```ts
// Verified
{ ok: true, payer, network, amount, accept, paymentPayload, requirement, raw }
// Rejected (a fresh 402 you can return directly)
{ ok: false, code, status, reason, body: { x402Version: 2, error, accepts } }
```

**Throws** — does **not** throw on a rejected/under-paid payment (returns
`ok: false`). Throws `X402Error`:
- `code: 'invalid_input'` if `requirements` is empty.
- `status: 502` `code: 'facilitator_unreachable'` if `/verify` is unreachable or
  returns `5xx` — no funds moved, safe to retry.
- An `AbortError` propagates if `signal` aborts.

---

### `settlePayment(args)`

```ts
settlePayment(args: { verified: Verified } | Verified): Promise<Receipt>
```

Settle a verified payment on-chain via the facilitator's `POST /settle`. Accepts
either `{ verified }` or the `Verified` object directly (optionally with a
`signal`). **Run only after the work succeeds.**

**Returns** — [`Receipt`](#types):

```ts
{ network: string, payer: string | null, transaction: string | null, raw: unknown }
```

base64 it into the `X-PAYMENT-RESPONSE` header.

**Throws** — `X402Error`:
- `code: 'invalid_input'` if not given a verified object (missing
  `paymentPayload` / `requirement`).
- `code: 'settle_failed'` `status: 502` when the facilitator reports `success !==
  true` (`.body` carries the facilitator response).
- `code: 'settle_uncertain'` `status: 502` when `/settle` is unreachable —
  verified and the work ran, status unknown; **check on-chain before retry**.
- `code: 'facilitator_bad_response'` `status: 502` if the settled network or
  payer mismatches the verified one.

---

### `feeSplit(priceAtomics, bps, recipient)`

```ts
feeSplit(priceAtomics: bigint | number | string, bps: number, recipient: string): FeeSplit | null
```

Carve a platform fee **out** of the listed price. `fee = floor(price × bps /
10_000)`, `net = price − fee`. The buyer is never marked up.

**Returns** — [`FeeSplit`](#types) `{ price, net, fee, bps, recipient }`, or
`null` when no fee applies:
- `bps` clamps to `[0, 1000]`; a clamped value of `0` → `null`.
- empty `recipient` → `null`.
- `price <= 0` or unparsable → `null`.
- a sub-atomic fee (floors to `0`) → `null` (creator keeps the whole price).

**Throws** — never. Invalid input returns `null`.

```js
feeSplit('1000000', 250, 'r');  // { price:'1000000', net:'975000', fee:'25000', bps:250, recipient:'r' }
feeSplit('1000000', 5000, 'r'); // bps clamped to 1000 → fee '100000'
feeSplit('1000000', 0, 'r');    // null
feeSplit('1000000', 250, '');   // null
feeSplit('3', 250, 'r');        // null (fee floors to 0)
```

---

### `createX402Server(options)`

```ts
createX402Server(options?: X402ServerClientOptions): X402ServerClient
```

Bind a facilitator URL, `fetch`, and auth headers into a reusable client.

**Options** — `X402ServerClientOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `facilitator` | `string` | `X402_FACILITATOR_URL` env, else `''` | Facilitator base URL. |
| `baseUrl` | `string` | — | Alias for `facilitator`. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | `fetch` implementation. |
| `apiKey` | `string` | — | Bearer token → `Authorization: Bearer …`. |
| `headers` | `Record<string,string>` | — | Default headers on every facilitator call. |

**Returns** — `X402ServerClient`:
`{ buildChallenge, verifyPayment, settlePayment, paid }` — the same four
functions, bound to this client's facilitator/fetch/auth.

**Throws** — `X402Error` `code: 'no_fetch'` if no `fetch` is available and none
is passed (the error is raised when the bound client first issues a request).

> The top-level `paid` / `verifyPayment` / `settlePayment` / `buildChallenge`
> exports are backed by a lazily-created shared client, so they work without
> calling `createX402Server` first. They read `X402_FACILITATOR_URL` for the
> facilitator host.

---

## Objects

### `fetchAdapter`

A `PaidAdapter` for Web `Request` / `Response` runtimes. Pass it as the `adapter`
option to [`paid()`](#paidoptions-handler) and your handler becomes
`(request, payment) => Response | object`.

- The challenge is returned as a JSON `Response` (status `402`) with
  `cache-control: no-store` and a base64 `PAYMENT-REQUIRED` header.
- A handler returning a `Response` gets the `X-PAYMENT-RESPONSE` receipt header
  cloned onto a copy; a handler returning a plain object is JSON-encoded as a
  `200` with the receipt header.

```js
import { paid, fetchAdapter } from '@three-ws/x402-server';

export default {
  fetch: paid(
    { price: '10000', payTo: { base: '0xYou' }, network: ['base'], adapter: fetchAdapter },
    async (request, payment) => Response.json({ ok: true, billedTo: payment.payer }),
  ),
};
```

---

## Errors

### `X402Error`

```ts
class X402Error extends Error {
  name: 'X402Error';
  code: string;
  status: number | null;
  detail?: string;
  retryAfter?: number;
  body: unknown;
}
```

Constructed as `new X402Error(message, { code, status, detail, retryAfter, body })`.

| Property | Type | Description |
|---|---|---|
| `code` | `string` | Stable machine code (default `'error'`). See [error codes](#error-codes). |
| `status` | `number \| null` | HTTP status to surface (default `null`). |
| `detail` | `string` (optional) | Extra facilitator context, set only when present. |
| `retryAfter` | `number` (optional) | Seconds before retry, from `Retry-After` / `retry_after`. |
| `body` | `unknown` | Raw facilitator body or a fresh 402 body (default `null`). |

### `PaymentRequiredError`

```ts
class PaymentRequiredError extends X402Error {
  accepts: unknown | null;   // the 402 challenge accepts[], when present
}
```

Subclass thrown on HTTP `402` by the internal facilitator HTTP client. Defaults
`code: 'payment_required'`, `status: 402`. `accepts` carries the challenge so a
payment-aware client can pay it. On the seller side you mostly *emit* 402s rather
than catch this.

---

## Constants

| Export | Value | Notes |
|---|---|---|
| `X402_VERSION` | `2` | The x402 wire format version this SDK speaks. |
| `MAX_FEE_BPS` | `1000` | Hard ceiling (10%) on `feeBps` / `feeSplit`. |
| `DEFAULT_FACILITATOR_URL` | `''` | No baked-in facilitator — you supply one. |
| `DEFAULT_BASE_URL` | `''` | Same value, re-exported from the HTTP core. |
| `NETWORK_SOLANA_MAINNET` | `'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'` | CAIP-2 Solana mainnet (truncated genesis hash). |
| `NETWORK_BASE_MAINNET` | `'eip155:8453'` | CAIP-2 Base mainnet. |
| `NETWORK_BASE_SEPOLIA` | `'eip155:84532'` | CAIP-2 Base Sepolia (testnet). |

---

## Types

Shipped in `src/index.d.ts`.

```ts
type Lane = 'solana' | 'base' | 'base-sepolia';
type Asset = 'usdc' | 'three' | { solana?: string; base?: string };

interface PayTo { solana?: string; base?: string; 'base-sepolia'?: string }

interface Accept {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource?: string;
  extra: { name: string; decimals: number; version?: string; feePayer?: string; [k: string]: unknown };
}

interface FeeSplit { price: string; net: string; fee: string; bps: number; recipient: string }

interface Challenge {
  x402Version: 2;
  error: string;
  resource: { url: string | null; mimeType: string; description?: string; serviceName?: string; tags?: string[]; iconUrl?: string };
  accepts: Accept[];
  extensions: Record<string, unknown>;
  fee?: FeeSplit | null;
}

interface Verified {
  ok: true; payer: string | null; network: string; amount: string;
  accept: Accept; paymentPayload: unknown; requirement: Accept; raw: unknown;
}
interface Rejected {
  ok: false; code: string; status: number; reason: string;
  body: { x402Version: 2; error: string; accepts: Accept[] };
}
type VerifyResult = Verified | Rejected;

interface Receipt { network: string; payer: string | null; transaction: string | null; raw: unknown }
interface Payment { payer: string | null; network: string; amount: string; accept: Accept }
```

---

## Error codes

| `code` | `status` | Raised by | Meaning |
|---|---|---|---|
| `invalid_input` | `null` | `buildChallenge`, `paid` (construct), `verifyPayment`, `settlePayment` | Bad arguments (price/payTo/asset/handler/fee/empty requirements). |
| `missing_fee_payer` | `null` | `buildChallenge` (Solana accept) | Solana accept without `feePayer`. |
| `payment_required` | `402` | `verifyPayment` result, `PaymentRequiredError` | Missing/failed `X-PAYMENT`. |
| `invalid_payment` | `402` | `verifyPayment` result | Bad base64/JSON, or a payment that fails `/verify`. |
| `unsupported_network` | `400` (→ `402` in the 402 body) | `verifyPayment` result | Buyer paid an unadvertised network. |
| `facilitator_unreachable` | `502` | `verifyPayment` | `/verify` down / `5xx` — no funds moved. |
| `settle_uncertain` | `502` | `settlePayment` | `/settle` unreachable after work — status unknown. |
| `settle_failed` | `502` | `settlePayment` | Facilitator reported settlement failed. |
| `facilitator_bad_response` | `502` | `settlePayment` | Settled network/payer mismatched the verified one. |
| `no_fetch` | `null` | HTTP core | No `fetch` available. |
| `network_error` | `null` | HTTP core | Low-level fetch failure (mapped up to `facilitator_unreachable` / `settle_uncertain`). |
