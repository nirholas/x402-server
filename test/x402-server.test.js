import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createX402Server,
	buildChallenge,
	feeSplit,
	fetchAdapter,
	ThreeWsError,
	NETWORK_SOLANA_MAINNET,
	NETWORK_BASE_MAINNET,
} from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real facilitator — we assert on request shaping
// and response parsing, which is all the SDK is responsible for. (Copied
// verbatim from @three-ws/forge's test harness.)
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// A synthetic Solana fee payer + payTo (never a real address — see CLAUDE.md).
const SYNTH_SOLANA_PAYTO = 'THREEsynthetic1111111111111111111111111PayTo';
const SYNTH_SOLANA_FEEPAYER = 'THREEsynthetic1111111111111111111111FeePayer';
const SYNTH_BASE_PAYTO = '0x00000000000000000000000000000000DeaDBeef';
const SYNTH_TREASURY = 'TREASURYsynthetic111111111111111111111Treasury';

function xPaymentHeader(payload) {
	return Buffer.from(JSON.stringify(payload)).toString('base64');
}

test('buildChallenge() emits the exact v2 accepts[] envelope', () => {
	const challenge = buildChallenge({
		price: '50000',
		asset: 'usdc',
		payTo: { solana: SYNTH_SOLANA_PAYTO, base: SYNTH_BASE_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
		resourceUrl: 'https://three.ws/api/thing',
		description: 'Doc summarize',
	});

	assert.equal(challenge.x402Version, 2);
	assert.equal(challenge.error, 'X-PAYMENT header is required');
	assert.equal(challenge.resource.url, 'https://three.ws/api/thing');
	assert.equal(challenge.resource.description, 'Doc summarize');
	assert.equal(challenge.accepts.length, 2);

	// Solana leads (platform Solana-first ordering) and carries the fee payer.
	const sol = challenge.accepts[0];
	assert.equal(sol.scheme, 'exact');
	assert.equal(sol.network, NETWORK_SOLANA_MAINNET);
	assert.equal(sol.amount, '50000');
	assert.equal(sol.payTo, SYNTH_SOLANA_PAYTO);
	assert.equal(sol.asset, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
	assert.equal(sol.maxTimeoutSeconds, 60);
	assert.equal(sol.extra.name, 'USDC');
	assert.equal(sol.extra.decimals, 6);
	assert.equal(sol.extra.feePayer, SYNTH_SOLANA_FEEPAYER);

	// Base second, with the on-chain EIP-712 domain name "USD Coin" (not "USDC").
	const base = challenge.accepts[1];
	assert.equal(base.network, NETWORK_BASE_MAINNET);
	assert.equal(base.payTo, SYNTH_BASE_PAYTO);
	assert.equal(base.extra.name, 'USD Coin');
	assert.equal(base.extra.version, '2');
});

test('buildChallenge() advertises only the requested lane', () => {
	const challenge = buildChallenge({
		price: '2000',
		payTo: { solana: SYNTH_SOLANA_PAYTO, base: SYNTH_BASE_PAYTO },
		network: ['base'],
	});
	assert.equal(challenge.accepts.length, 1);
	assert.equal(challenge.accepts[0].network, NETWORK_BASE_MAINNET);
});

test('a Solana accept without a feePayer is rejected with missing_fee_payer', () => {
	assert.throws(
		() => buildChallenge({ price: '1000', payTo: { solana: SYNTH_SOLANA_PAYTO } }),
		(e) => {
			assert.ok(e instanceof ThreeWsError);
			assert.equal(e.code, 'missing_fee_payer');
			return true;
		},
	);
});

test('buildChallenge() validates price + payTo before building', () => {
	assert.throws(() => buildChallenge({ payTo: { base: SYNTH_BASE_PAYTO } }), /needs a `price`/);
	assert.throws(() => buildChallenge({ price: '1.5', payTo: { base: SYNTH_BASE_PAYTO } }), /whole atomic amount/);
	assert.throws(() => buildChallenge({ price: '1000' }), /needs `payTo`/);
});

test('verifyPayment() POSTs the v2 verify body and shapes a valid result', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_SOLANA_PAYTO, network: NETWORK_SOLANA_MAINNET } },
	]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({
		price: '50000',
		payTo: { solana: SYNTH_SOLANA_PAYTO },
		feePayer: SYNTH_SOLANA_FEEPAYER,
	}).accepts;

	const header = xPaymentHeader({ x402Version: 2, scheme: 'exact', network: NETWORK_SOLANA_MAINNET, payload: { transaction: 'abc' } });
	const verified = await server.verifyPayment({ paymentHeader: header, requirements: accepts });

	assert.equal(calls[0].url.pathname, '/verify');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.x402Version, 2);
	assert.equal(sent.paymentRequirements.network, NETWORK_SOLANA_MAINNET);
	assert.ok(sent.paymentPayload, 'decoded X-PAYMENT payload is forwarded');

	assert.equal(verified.ok, true);
	assert.equal(verified.payer, SYNTH_SOLANA_PAYTO);
	assert.equal(verified.network, NETWORK_SOLANA_MAINNET);
});

test('verifyPayment() accepts the positional (header, expected) shape', async () => {
	const { fetch } = stubFetch([{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } }]);
	const server = createX402Server({ fetch });
	const challenge = buildChallenge({ price: '1000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] });
	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '1000' } } });
	const verified = await server.verifyPayment(header, challenge);
	assert.equal(verified.ok, true);
});

test('a facilitator-rejected payment returns a fresh 402 body, not a throw', async () => {
	const { fetch } = stubFetch([{ body: { isValid: false, invalidReason: 'underpaid' } }]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({ price: '50000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] }).accepts;
	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10' } } });
	const res = await server.verifyPayment({ paymentHeader: header, requirements: accepts });

	assert.equal(res.ok, false);
	assert.equal(res.code, 'invalid_payment');
	assert.equal(res.body.x402Version, 2);
	assert.deepEqual(res.body.accepts, accepts);
});

test('a facilitator outage on /verify is a typed 502, never a rejected payment', async () => {
	const { fetch } = stubFetch([{ status: 502, body: { error: 'bad_gateway' } }]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({ price: '1000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] }).accepts;
	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '1000' } } });
	await assert.rejects(() => server.verifyPayment({ paymentHeader: header, requirements: accepts }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.status, 502);
		return true;
	});
});

test('settlePayment() POSTs /settle and shapes the receipt', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_SOLANA_PAYTO } },
		{ body: { success: true, transaction: 'TXSIG123', network: NETWORK_SOLANA_MAINNET, payer: SYNTH_SOLANA_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const accepts = buildChallenge({ price: '50000', payTo: { solana: SYNTH_SOLANA_PAYTO }, feePayer: SYNTH_SOLANA_FEEPAYER }).accepts;
	const header = xPaymentHeader({ network: NETWORK_SOLANA_MAINNET, payload: { transaction: 'abc' } });

	const verified = await server.verifyPayment({ paymentHeader: header, requirements: accepts });
	const receipt = await server.settlePayment({ verified });

	assert.equal(calls[1].url.pathname, '/settle');
	assert.equal(receipt.transaction, 'TXSIG123');
	assert.equal(receipt.network, NETWORK_SOLANA_MAINNET);
	assert.equal(receipt.payer, SYNTH_SOLANA_PAYTO);
});

test('paid() returns a 402 challenge when no X-PAYMENT header is present', async () => {
	const { fetch } = stubFetch([]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'] },
		async (_req, res) => res.end('should not run'),
	);

	const captured = { headers: {}, body: null, ended: false };
	const req = { url: '/api/thing', headers: { host: 'three.ws' } };
	const res = {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) { captured.headers[k] = v; },
		end(b) { captured.ended = true; captured.body = b; this.writableEnded = true; },
	};
	await handler(req, res);

	assert.equal(res.statusCode, 402);
	assert.ok(captured.headers['PAYMENT-REQUIRED'], 'base64 PAYMENT-REQUIRED header is set');
	const body = JSON.parse(captured.body);
	assert.equal(body.x402Version, 2);
	assert.equal(body.accepts[0].network, NETWORK_BASE_MAINNET);
});

test('paid() verifies, runs the handler, then settles on a paid call', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { isValid: true, payer: SYNTH_BASE_PAYTO } },
		{ body: { success: true, transaction: 'TX_PAID', network: NETWORK_BASE_MAINNET, payer: SYNTH_BASE_PAYTO } },
	]);
	const server = createX402Server({ fetch });
	const order = [];
	let settledReceipt = null;
	const handler = server.paid(
		{
			price: '10000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'],
			onSettled: (r) => { settledReceipt = r; },
		},
		async (_req, res, payment) => {
			order.push('work');
			assert.equal(payment.payer, SYNTH_BASE_PAYTO);
			res.end(JSON.stringify({ ok: true }));
		},
	);

	const header = xPaymentHeader({ network: NETWORK_BASE_MAINNET, payload: { authorization: { value: '10000', to: SYNTH_BASE_PAYTO } } });
	const req = { url: '/api/thing', headers: { host: 'three.ws', 'x-payment': header } };
	const res = { statusCode: 200, writableEnded: false, setHeader() {}, end() { this.writableEnded = true; } };
	const receipt = await handler(req, res);

	// verify ran before settle (and the work ran between them).
	assert.equal(calls[0].url.pathname, '/verify');
	assert.equal(calls[1].url.pathname, '/settle');
	assert.deepEqual(order, ['work']);
	assert.equal(receipt.transaction, 'TX_PAID');
	assert.equal(settledReceipt.transaction, 'TX_PAID');
});

test('paid() supports a fetch-style adapter (Request → Response)', async () => {
	const { fetch } = stubFetch([]);
	const server = createX402Server({ fetch });
	const handler = server.paid(
		{ price: '5000', payTo: { base: SYNTH_BASE_PAYTO }, network: ['base'], adapter: fetchAdapter },
		async () => new Response(JSON.stringify({ ok: true })),
	);
	const request = new Request('https://three.ws/api/thing');
	const response = await handler(request);
	assert.equal(response.status, 402);
	assert.ok(response.headers.get('PAYMENT-REQUIRED'));
	const body = await response.json();
	assert.equal(body.accepts[0].network, NETWORK_BASE_MAINNET);
});

test('feeSplit() carves the fee OUT of the price (never marks up the buyer)', () => {
	// 2.5% of $1.00 (1_000_000 atomics): buyer still pays 1_000_000, creator nets 975_000, fee 25_000.
	const split = feeSplit('1000000', 250, SYNTH_TREASURY);
	assert.equal(split.price, '1000000');
	assert.equal(split.net, '975000');
	assert.equal(split.fee, '25000');
	assert.equal(split.bps, 250);
	assert.equal(split.recipient, SYNTH_TREASURY);
});

test('feeSplit() clamps bps to 10% and returns null when no fee applies', () => {
	// Over-max bps clamps to 1000 (10%): fee 100_000 on 1_000_000.
	assert.equal(feeSplit('1000000', 5000, SYNTH_TREASURY).fee, '100000');
	// Rate 0 → no fee.
	assert.equal(feeSplit('1000000', 0, SYNTH_TREASURY), null);
	// No recipient → no fee.
	assert.equal(feeSplit('1000000', 250, ''), null);
	// Sub-atomic fee (floor → 0) → null so the creator keeps the whole price.
	assert.equal(feeSplit('3', 250, SYNTH_TREASURY), null);
});

test('buildChallenge() surfaces the fee plan on the envelope when configured', () => {
	const challenge = buildChallenge({
		price: '1000000',
		payTo: { base: SYNTH_BASE_PAYTO },
		network: ['base'],
		feeBps: 250,
		feeTo: SYNTH_TREASURY,
	});
	assert.equal(challenge.fee.fee, '25000');
	assert.equal(challenge.fee.net, '975000');
	assert.equal(challenge.fee.recipient, SYNTH_TREASURY);
});
