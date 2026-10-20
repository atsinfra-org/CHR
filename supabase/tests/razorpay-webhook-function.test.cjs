// razorpay-webhook handler tests with a fake Supabase client: no network, no Razorpay, no database, no secrets.
// Run from the website repo root:   node supabase/tests/razorpay-webhook-function.test.cjs
//
// What this pins down about the handler (the HTTP side of duplicate protection; the database side is phase17,
// phase18 and duplicate-payment-concurrency.sh):
//   * the signature is HMAC-SHA256 of the RAW request body with the webhook secret, compared in constant time;
//   * nothing reaches the database unless the signature is valid;
//   * the idempotency key handed to the database is Razorpay's own per-delivery id, or a deterministic hash of
//     the body when that header is missing, so a retried delivery always carries the same key;
//   * only payment.captured is acted on; failures are acknowledged and ignored (the customer may retry);
//   * the handler never decides the outcome of a duplicate: it calls the same database function every time.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { stripTypeScriptTypes } = require('node:module');

const compile = (file, stubs = {}) => {
  let code = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  const names = [];
  code = code
    .replace(/import \{([\s\S]*?)\} from (['"])(.+?)\2;?/g, (_, list, __, mod) => `const {${list.replace(/\bas\b/g, ':')}} = require(${JSON.stringify(mod)});`)
    .replace(/export (async )?function (\w+)/g, (_, a, n) => (names.push(n), `${a || ''}function ${n}`))
    .replace(/export const (\w+)/g, (_, n) => (names.push(n), `const ${n}`));
  code += '\n' + names.map((n) => `exports.${n} = ${n};`).join('\n');
  const exp = {};
  new Function('require', 'exports', 'module', code)((id) => (id in stubs ? stubs[id] : require(id)), exp, { exports: exp });
  return exp;
};

let pass = 0, fail = 0;
// Written straight to stdout: console.log is redirected below to capture what the HANDLER logs.
const out = (s) => process.stdout.write(s + '\n');
const ok = (n, c, e = '') => { c ? pass++ : fail++; out((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + e)); };

// WEBHOOK_FILE lets a deliberately broken copy be tested, to prove these tests can fail.
const FILE = process.env.WEBHOOK_FILE || path.join(__dirname, '..', 'functions', 'razorpay-webhook', 'index.ts');
// Throwaway values made up for this test. They are not real keys.
const SECRET = 'whsec_test_' + crypto.randomBytes(8).toString('hex');
const SERVICE_KEY = 'service_role_KEY_SHOULD_NEVER_LEAK_' + crypto.randomBytes(4).toString('hex');
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');

const mk = ({ secret = SECRET, rpcResult } = {}) => {
  const calls = [];
  const created = [];
  const db = { rpc: async (fn, args) => { calls.push([fn, args]); return rpcResult ? rpcResult(fn, args) : { data: { id: 'pay-row', status: 'success' }, error: null }; } };
  let handler;
  global.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => ({ RAZORPAY_WEBHOOK_SECRET: secret, SUPABASE_URL: 'http://db.local', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY })[k] } };
  compile(FILE, { 'jsr:@supabase/supabase-js@2': { createClient: (url, key) => { created.push({ url, key }); return db; } } });
  return { handler, calls, created };
};

const captured = (over = {}) => JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_TEST1', order_id: 'order_TEST1', amount: 200000, currency: 'INR', status: 'captured', method: 'card', ...over } } },
});
const post = (h, body, headers = {}) => h(new Request('http://x/razorpay-webhook', { method: 'POST', headers, body }));
const text = async (r) => r.text();

(async () => {
  const errs = [], warns = [], logs = [];
  const oe = console.error, ow = console.warn, ol = console.log;
  console.error = (...a) => errs.push(a.map(String).join(' ') + JSON.stringify(a));
  console.warn = (...a) => warns.push(a.map(String).join(' ') + JSON.stringify(a));
  console.log = (...a) => logs.push(a.map(String).join(' ') + JSON.stringify(a));
  const everything = () => errs.join('\n') + warns.join('\n') + logs.join('\n');

  // ── Refusals: nothing may reach the database ────────────────────────────
  {
    const t = mk();
    const r = await t.handler(new Request('http://x', { method: 'GET' }));
    ok('GET is refused', r.status === 405 && t.calls.length === 0);
  }
  {
    const t = mk({ secret: null });   // null, not undefined: undefined would fall back to the default secret
    const body = captured();
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body) });
    ok('without a configured webhook secret the handler refuses everything (500) and does nothing', r.status === 500 && t.calls.length === 0 && t.created.length === 0);
  }
  {
    const t = mk();
    const r = await post(t.handler, captured(), {});
    ok('a request with no signature header is refused (400)', r.status === 400 && t.calls.length === 0 && t.created.length === 0);
  }
  {
    const t = mk();
    const body = captured();
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body, 'a-different-secret') });
    ok('a signature made with the wrong secret is refused (400) and nothing reaches the database', r.status === 400 && (await text(r)) === 'Invalid signature' && t.calls.length === 0 && t.created.length === 0);
  }
  {
    const t = mk();
    const body = captured();
    const good = sign(body);
    const r1 = await post(t.handler, body + ' ', { 'X-Razorpay-Signature': good });                // body altered by one byte
    const r2 = await post(t.handler, body, { 'X-Razorpay-Signature': good.slice(0, -2) });         // truncated signature
    const r3 = await post(t.handler, body, { 'X-Razorpay-Signature': good.toUpperCase() });        // wrong case: not a valid match
    const r4 = await post(t.handler, body, { 'X-Razorpay-Signature': '' });                         // empty
    ok('an altered body, a truncated signature, an upper-cased one and an empty one are all refused', [r1, r2, r3, r4].every((r) => r.status === 400) && t.calls.length === 0);
  }
  {
    const t = mk();
    const body = captured({ amount: 1 });                                                           // attacker lowers the amount but reuses a real signature
    const realSig = sign(captured({ amount: 200000 }));
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': realSig });
    ok('a captured signature cannot be reused for a different amount', r.status === 400 && t.calls.length === 0);
  }
  {
    const t = mk();
    const body = '{"event": "payment.captured", "payload": {BROKEN';
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body) });
    ok('a correctly signed but unreadable body is refused (400) before any database call', r.status === 400 && t.calls.length === 0);
  }

  // ── The signature covers the RAW body ───────────────────────────────────
  {
    const t = mk();
    const compact = captured();
    const pretty = JSON.stringify(JSON.parse(compact), null, 4);
    const r1 = await post(t.handler, pretty, { 'X-Razorpay-Signature': sign(compact), 'x-razorpay-event-id': 'evt_raw' });   // same data, re-formatted: must fail
    const r2 = await post(t.handler, pretty, { 'X-Razorpay-Signature': sign(pretty), 'x-razorpay-event-id': 'evt_raw' });    // the exact bytes that were signed: ok
    ok('the signature is checked over the raw bytes (re-formatting breaks it), not over parsed JSON', r1.status === 400 && r2.status === 200 && t.calls.length === 1);
  }

  // ── A valid payment.captured: what the database is asked to do ──────────
  let firstCall;
  {
    const t = mk();
    const body = captured();
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_abc' });
    firstCall = t.calls[0];
    ok('a valid captured event gets 200 and exactly one database call to process_payment_webhook', r.status === 200 && (await text(r)) === 'OK' && t.calls.length === 1 && firstCall[0] === 'process_payment_webhook');
    ok('the database call carries Razorpay\'s own delivery id as its idempotency key', firstCall[1].p_event_id === 'evt_abc' && firstCall[1].p_event_type === 'payment.captured');
    ok('it passes the gateway order and payment ids, success, the amount converted from paise, and the currency', firstCall[1].p_gateway_order_id === 'order_TEST1' && firstCall[1].p_gateway_payment_id === 'pay_TEST1' && firstCall[1].p_status === 'success' && firstCall[1].p_amount === 2000 && firstCall[1].p_currency === 'INR');
    ok('the service-role client is created only after the signature passed, and only for that call', t.created.length === 1 && t.created[0].key === SERVICE_KEY);
  }
  {
    const t = mk();
    const body = captured({ amount: 123456 });
    await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_amt' });
    ok('paise are converted exactly (123456 paise = 1234.56)', t.calls[0][1].p_amount === 1234.56);
  }
  {
    const t = mk();
    const body = captured({ amount: 'oops' });
    await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_bad_amt' });
    ok('a non-numeric amount is passed on as null (the database then refuses to settle it)', t.calls[0][1].p_amount === null);
  }

  // ── Duplicates ──────────────────────────────────────────────────────────
  {
    const t = mk();
    const body = captured();
    const headers = { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_dup' };
    const a = await post(t.handler, body, headers);
    const b = await post(t.handler, body, headers);
    const c = await post(t.handler, body, headers);
    const keys = t.calls.map((c2) => c2[1].p_event_id);
    ok('the SAME delivery three times is acknowledged each time (200) so Razorpay stops retrying', [a, b, c].every((r) => r.status === 200));
    ok('every repeat carries the identical idempotency key; the handler does not decide the outcome, the database function does', keys.length === 3 && new Set(keys).size === 1 && keys[0] === 'evt_dup');
    ok('a repeat is not treated differently by the handler (same function, same arguments)', JSON.stringify(t.calls[0]) === JSON.stringify(t.calls[1]) && JSON.stringify(t.calls[1]) === JSON.stringify(t.calls[2]));
  }
  {
    const t = mk();
    const b1 = captured(), b2 = captured({ amount: 200001 });
    const h = (b) => ({ 'X-Razorpay-Signature': sign(b) });                // no x-razorpay-event-id header at all
    await post(t.handler, b1, h(b1)); await post(t.handler, b1, h(b1)); await post(t.handler, b2, h(b2));
    const [k1, k2, k3] = t.calls.map((c) => c[1].p_event_id);
    ok('without the event-id header the key is a hash of the body: the same body always gets the same key', /^body:[0-9a-f]{64}$/.test(k1) && k1 === k2);
    ok('and a different body gets a different key', k3 !== k1);
    ok('the fallback key is keyed with the secret, so it cannot be computed without it', k1 === 'body:' + sign(b1));
  }

  // ── What is NOT acted on ────────────────────────────────────────────────
  {
    const t = mk();
    for (const [name, body] of [
      ['payment.failed', captured().replace('payment.captured', 'payment.failed')],
      ['payment.authorized', captured().replace('payment.captured', 'payment.authorized')],
      ['order.paid', JSON.stringify({ event: 'order.paid', payload: {} })],
      ['a captured event with no order id', captured({ order_id: undefined })],
      ['a captured event with no payment id', captured({ id: undefined })],
      ['an event with no type', JSON.stringify({ payload: {} })],
    ]) {
      const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_' + name });
      ok(`${name}: acknowledged (200) and ignored, no database call`, r.status === 200 && (await text(r)) === 'Ignored' && t.calls.length === 0);
    }
  }

  // ── Database answers ────────────────────────────────────────────────────
  {
    const t = mk({ rpcResult: () => ({ data: null, error: { message: 'UNKNOWN_GATEWAY_ORDER_ID' } }) });
    const body = captured();
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_unknown' });
    ok('an order this project does not know is acknowledged (200): a retry could never fix it', r.status === 200);
  }
  {
    const t = mk({ rpcResult: () => ({ data: null, error: { message: 'connection reset' } }) });
    const body = captured();
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_db_down' });
    ok('any other database error is answered with 500, so Razorpay delivers it again later', r.status === 500 && (await text(r)) === 'Processing error');
  }
  {
    const t = mk({ rpcResult: () => ({ data: { id: 'same-row', status: 'success' }, error: null }) });
    const body = captured();
    const r = await post(t.handler, body, { 'X-Razorpay-Signature': sign(body), 'x-razorpay-event-id': 'evt_already_done' });
    ok('when the database says the payment was already settled, the handler still answers 200', r.status === 200);
  }

  console.error = oe; console.warn = ow; console.log = ol;
  ok('logs never contain the webhook secret, the service-role key or a signature', !everything().includes(SECRET) && !everything().includes(SERVICE_KEY) && !/[0-9a-f]{64}/.test(everything().replace(/body:[0-9a-f]{64}/g, '')));
  ok('logs never contain a card or customer field (only ids)', !/card|email|phone|contact/i.test(everything()));

  out(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
