// Tests for email-send, email-webhook logic, templates and payment-reconcile, with a fake Supabase client
// and a fake fetch (no network, no Deno, no real email, no real payment).
// Run from the website repo root:   node supabase/tests/transactional-email-functions.test.cjs
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
  new Function('require', 'exports', 'module', 'Deno', code)((id) => (id in stubs ? stubs[id] : require(id)), exp, { exports: exp }, stubs.__Deno);
  return exp;
};

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : e); };
const FN = path.join(__dirname, '..', 'functions') + path.sep;

const logic = compile(FN + 'email-send/logic.ts');
const T = compile(FN + 'email-send/templates.ts');
const RT = compile(FN + 'email-send/resend-template.ts', { './templates.ts': T });
const R = compile(FN + 'payment-reconcile/logic.ts');

// ─── fixtures: what email_job_context() returns (database records) ──────────
const business = { name: 'Colonel Horse Riding Club', address: null, contact_email: 'club@example.org', contact_phone: null };
const receipt = { document_type: 'payment_receipt', receipt_number: 'CHR-R-2026-000012', status: 'paid', paid_at: '2026-10-19T08:30:00Z', amount: 5000, currency: 'INR',
  payment_reference: 'pay_ABC123', order_reference: 'CHR-1A2B3C4D', items: [{ name: 'Adult 8-class pack', quantity: 1, unit_price: 5000 }] };
const ctx = (template, extra) => ({ ok: true, template, to: 'member@example.org', member_name: 'Asha Rao', business, ...extra });

// ─── subjects (exact) ───────────────────────────────────────────────────────
const pay = T.renderEmail(ctx('payment_received', { receipt }), 'https://chr.example.org');
ok('A: payment subject', pay.subject === 'Payment received — Colonel Horse Riding Club');
ok('B: membership subject', T.renderEmail(ctx('membership_activated', { membership: { name: 'X', credits: 8, start_date: '2026-10-19', end_date: '2026-12-17', reschedules_allowed: 2 } })).subject === 'Your CHR membership is active');
ok('C: booking subject', T.renderEmail(ctx('booking_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-21', start_time: '06:30', end_time: '07:30' } })).subject === 'Your riding class is confirmed');
ok('D: reschedule subject', T.renderEmail(ctx('reschedule_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-22', start_time: '07:00', end_time: '08:00', original: { date: '2026-10-21', start_time: '06:30', end_time: '07:30' } } })).subject === 'Your riding class has been rescheduled');
ok('E: order subject', T.renderEmail(ctx('order_confirmation', { order: { reference: 'CHR-1', status: 'paid', payment_status: 'success', total: 450, currency: 'INR', has_in_store: true, items: [] } })).subject === 'Your CHR order confirmation');

// ─── A/D receipt: values come from the record, INR formatting, no invented tax data ─
ok('receipt shows number, INR amount, reference, order ref, paid status', ['CHR-R-2026-000012', '₹5,000.00', 'pay_ABC123', 'CHR-1A2B3C4D', 'Paid'].every((s) => pay.html.includes(s) && pay.text.includes(s)), pay.text);
ok('receipt time is shown in IST', pay.text.includes('IST') && pay.text.includes('2:00 pm'), pay.text);
ok('receipt is a payment receipt, never a tax invoice', /not a tax invoice/i.test(pay.text) && !/>\s*tax invoice/i.test(pay.html) && !/GST|CGST|SGST|IGST/.test(pay.html + pay.text));
ok('unconfigured business details are omitted, not invented', !pay.html.includes('null') && !pay.html.includes('undefined') && !/GSTIN/.test(pay.html));
ok('a configured GSTIN is shown only when present', T.renderEmail(ctx('payment_received', { receipt, business: { ...business, gstin: '27ABCDE1234F1Z5' } })).html.includes('GSTIN 27ABCDE1234F1Z5'));
ok('non-INR currency keeps its own currency', (() => { const t = T.renderEmail(ctx('payment_received', { receipt: { ...receipt, currency: 'USD', amount: 20 } })).text; return t.includes('20.00') && t.includes('Currency: USD') && !t.includes('₹'); })());
ok('plain-text alternative exists and has the link', pay.text.includes('https://chr.example.org/orders'));
ok('call-to-action button uses the https base', pay.html.includes('href="https://chr.example.org/orders"'));
ok('no button without a base URL, and http base is refused', !T.renderEmail(ctx('payment_received', { receipt }), null).html.includes('<a ') && !T.renderEmail(ctx('payment_received', { receipt }), 'http://insecure.example').html.includes('<a '));
ok('brand colours are used', pay.html.includes('#1F3A2E') && pay.html.includes('#F6F3EA') && pay.html.includes('#B08D57') && pay.html.includes('#C9A86A'));
ok('member text is escaped', T.renderEmail(ctx('payment_received', { receipt, member_name: '<script>alert(1)</script>' })).html.includes('&lt;script&gt;') && !T.renderEmail(ctx('payment_received', { receipt, member_name: '<script>x</script>' })).html.includes('<script>'));

// ─── B membership: actual credits, validity, reschedules ────────────────────
const mem = T.renderEmail(ctx('membership_activated', { membership: { name: 'Adult 8-class pack', credits: 8, start_date: '2026-10-19', end_date: '2026-12-17', reschedules_allowed: 2 } }));
ok('membership email has the real credits and validity', mem.text.includes('Classes included: 8') && mem.text.includes('19 Oct 2026') && mem.text.includes('17 Dec 2026') && mem.text.includes('Reschedules allowed: 2'), mem.text);
ok('membership email guides the first booking', /book your first class/i.test(mem.text));
ok('no reschedule line when not applicable', !T.renderEmail(ctx('membership_activated', { membership: { name: 'X', credits: 4, start_date: '2026-10-19', end_date: '2026-11-17', reschedules_allowed: null } })).text.includes('Reschedules allowed'));

// ─── C/D booking ────────────────────────────────────────────────────────────
const bk = T.renderEmail(ctx('booking_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-21', start_time: '06:30', end_time: '07:30', arrival_info: 'Please arrive 15 minutes early.' } }), 'https://chr.example.org');
ok('booking email: date, times, reference, status, arrival info', ['Wed, 21 Oct 2026', '06:30–07:30', 'AB12CD34', 'Confirmed', 'arrive 15 minutes early'].every((s) => bk.text.includes(s)), bk.text);
ok('booking email has no arrival text when not configured', !T.renderEmail(ctx('booking_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-21', start_time: '06:30', end_time: '07:30', arrival_info: null } })).text.includes('arrive'));
const rs = T.renderEmail(ctx('reschedule_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-22', start_time: '07:00', end_time: '08:00', original: { date: '2026-10-21', start_time: '06:30', end_time: '07:30' } } }));
ok('reschedule email shows old and new class', rs.text.includes('Previous class: Wed, 21 Oct 2026, 06:30–07:30') && rs.text.includes('New class: Thu, 22 Oct 2026, 07:00–08:00') && rs.text.includes('AB12CD34'), rs.text);

// ─── E order confirmation reflects the real payment status ──────────────────
const items = [{ name: 'Helmet', quantity: 2, unit_price: 450 }];
const paid = T.renderEmail(ctx('order_confirmation', { order: { reference: 'CHR-9', status: 'paid', payment_status: 'success', total: 900, currency: 'INR', has_in_store: true, collection_info: 'Collect from the club office.', items } }));
const unpaid = T.renderEmail(ctx('order_confirmation', { order: { reference: 'CHR-9', status: 'pending', payment_status: 'created', total: 900, currency: 'INR', has_in_store: true, items } }));
ok('paid order: items, qty, price, total, status, collection', ['Helmet', '× 2', '₹900.00', 'Payment status: Paid', 'Order status: Paid', 'Collect from the club office.'].every((s) => paid.text.includes(s) || paid.text.includes(s.replace('× 2', 'x 2'))), paid.text);
ok('unpaid order is not called paid', unpaid.text.includes('Payment status: Awaiting confirmation') && !/Payment has been received/.test(unpaid.text) && /not been confirmed/.test(unpaid.text), unpaid.text);

// ─── F pending: never calls it success or failure, never says pay again ─────
const pend = T.renderEmail(ctx('payment_pending', { payment: { amount: 5000, currency: 'INR', order_reference: 'CHR-1A2B3C4D', started_at: '2026-10-19T08:00:00Z' } }));
ok('pending email: verification in progress, do not pay again, no success/failure claim', /do not pay again/i.test(pend.text) && pend.text.includes('Verification in progress') && !/payment received|payment failed|has failed|successful/i.test(pend.text), pend.text);

// ─── provider classification ────────────────────────────────────────────────
const cls = (s) => logic.classifyProviderStatus(s);
const cls409 = (name) => logic.classifyProviderStatus(409, name);
ok('2xx accepted', cls(200).outcome === 'sent' && cls(202).outcome === 'sent');
ok('429/5xx/409 transient', ['429', '500', '502', '503', '409'].every((s) => cls(+s).outcome === 'transient'));
ok('422 and 400 are permanent', cls(422).outcome === 'permanent' && cls(400).outcome === 'permanent' && cls(422).category === 'invalid_request');
ok('auth failures are permanent (staff retry after fixing config)', cls(401).category === 'provider_auth' && cls(403).outcome === 'permanent');

// ─── Svix (delivery webhooks) ───────────────────────────────────────────────
(async () => {
  const keyBytes = crypto.randomBytes(24);
  const secret = 'whsec_' + keyBytes.toString('base64');
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg_1' } });
  const id = 'msg_abc', ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v1,' + crypto.createHmac('sha256', keyBytes).update(`${id}.${ts}.${body}`).digest('base64');
  ok('svix: valid signature accepted', await logic.verifySvix(secret, { id, timestamp: ts, signature: sig }, body));
  ok('svix: tampered body rejected', !(await logic.verifySvix(secret, { id, timestamp: ts, signature: sig }, body + ' ')));
  ok('svix: wrong secret rejected', !(await logic.verifySvix('whsec_' + crypto.randomBytes(24).toString('base64'), { id, timestamp: ts, signature: sig }, body)));
  ok('svix: stale timestamp rejected (replay)', !(await logic.verifySvix(secret, { id, timestamp: String(Number(ts) - 3600), signature: 'v1,' + crypto.createHmac('sha256', keyBytes).update(`${id}.${Number(ts) - 3600}.${body}`).digest('base64') }, body)));
  ok('svix: missing headers rejected', !(await logic.verifySvix(secret, { id: null, timestamp: ts, signature: sig }, body)));
  ok('svix: one good signature among several is enough', await logic.verifySvix(secret, { id, timestamp: ts, signature: 'v1,AAAA ' + sig }, body));

  // ─── payment-reconcile decisions ──────────────────────────────────────────
  const now = 1_800_000_000;
  ok('reconcile: captured -> capture (the only success signal)', R.decide([{ id: 'pay_1', status: 'captured' }], now).action === 'capture');
  ok('reconcile: authorized is NOT success', R.decide([{ id: 'pay_1', status: 'authorized', created_at: now - 60 }], now).action === 'pending');
  ok('reconcile: failed attempts only -> no state change', R.decide([{ id: 'pay_1', status: 'failed' }], now).action === 'none');
  ok('reconcile: nothing attempted -> none', R.decide([], now).action === 'none' && R.decide(undefined, now).action === 'none');
  ok('reconcile: young in-flight attempt is not announced', R.decide([{ id: 'p', status: 'authorized', created_at: now - 600 }], now).notify === false);
  ok('reconcile: 30+ minute in-flight attempt is announced once offered', R.decide([{ id: 'p', status: 'authorized', created_at: now - 1900 }], now).notify === true);
  ok('reconcile: captured wins over an earlier failed attempt', R.decide([{ id: 'a', status: 'failed' }, { id: 'b', status: 'captured' }], now).payment.id === 'b');
  ok('reconcile: paise -> rupees', R.paiseToRupees(500000) === 5000 && R.paiseToRupees(12345) === 123.45);

  // ─── email-send handler ───────────────────────────────────────────────────
  const SECRET = 'shared-secret-value';
  const loadSend = (env, db, fetchImpl) => {
    let handler;
    const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
    const logicMod = logic;
    const prevFetch = global.fetch;
    global.fetch = fetchImpl;
    const origSignal = AbortSignal.timeout;
    compile(FN + 'email-send/index.ts', {
      'jsr:@supabase/supabase-js@2': { createClient: () => db },
      './logic.ts': logicMod, './templates.ts': T, './resend-template.ts': RT, __Deno: Deno,
    });
    return { handler, restore: () => { global.fetch = prevFetch; AbortSignal.timeout = origSignal; } };
  };
  const mkReq = (body, headers = { 'x-email-secret': SECRET }) => ({ method: 'POST', headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
  const baseEnv = { EMAIL_FUNCTION_SECRET: SECRET, RESEND_API_KEY: 're_test_KEY_SHOULD_NEVER_LEAK', EMAIL_FROM: 'CHR <receipts@example.org>', SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'srv_KEY_SHOULD_NEVER_LEAK' };
  const mkDb = (jobs, contexts) => {
    const calls = [];
    return { calls, rpc: async (fn, args) => {
      calls.push([fn, args]);
      if (fn === 'claim_email_jobs') return { data: jobs, error: null };
      if (fn === 'email_job_context') return { data: contexts[args.p_job], error: null };
      if (fn === 'complete_email_job') return { data: ({ sent: 'sent', skipped: 'skipped', permanent: 'failed', transient: 'retry_scheduled' })[args.p_outcome], error: null };
      return { data: null, error: null };
    } };
  };
  const run = async (h, body, headers) => { const r = await h(mkReq(body, headers)); return { status: r.status, body: JSON.parse(await r.text()) }; };
  const completes = (db) => db.calls.filter((c) => c[0] === 'complete_email_job').map((c) => c[1]);

  { // unauthorized
    const db = mkDb([], {}); const s = loadSend(baseEnv, db, async () => { throw new Error('no network'); });
    const r1 = await run(s.handler, { sweep: true }, { 'x-email-secret': 'wrong' }); const r2 = await run(s.handler, { sweep: true }, {});
    ok('send: wrong or missing secret is refused before any work', r1.status === 401 && r2.status === 401 && db.calls.length === 0);
    s.restore();
  }
  { // not configured: nothing is claimed, so nothing is lost or falsely sent
    for (const env of [{ ...baseEnv, RESEND_API_KEY: undefined }, { ...baseEnv, EMAIL_FROM: undefined }]) {
      const db = mkDb([{ id: 'j' }], {}); const s = loadSend(env, db, async () => { throw new Error('no network'); });
      const r = await run(s.handler, { sweep: true });
      ok('send: without provider config no job is claimed or sent', r.body.reason === 'not_configured' && db.calls.length === 0);
      s.restore();
    }
  }
  const J = '11111111-1111-4111-8111-111111111111';
  const okCtx = { [J]: ctx('payment_received', { receipt }) };
  { // success: recorded as sent with provider id; recipient from the database; idempotency key; secrets stay private
    const fetchLog = [];
    const db = mkDb([{ id: J, template: 'payment_received' }], okCtx);
    const s = loadSend(baseEnv, db, async (url, init) => { fetchLog.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'resend_msg_1' }) }; });
    const r = await run(s.handler, { job_id: J, to: 'attacker@evil.example', subject: 'forged', html: '<b>forged</b>' });
    const sent = JSON.parse(fetchLog[0].init.body);
    ok('send: success is recorded as sent with the provider message id', completes(db)[0].p_outcome === 'sent' && completes(db)[0].p_message_id === 'resend_msg_1' && r.body.sent === 1);
    ok('send: recipient and content come from the database, not the request', sent.to[0] === 'member@example.org' && sent.subject === 'Payment received — Colonel Horse Riding Club' && !JSON.stringify(sent).includes('forged') && !JSON.stringify(sent).includes('attacker'));
    ok('send: Idempotency-Key equals the job id (one provider send per job)', fetchLog[0].init.headers['Idempotency-Key'] === J);
    ok('send: html and plain text are both sent', typeof sent.html === 'string' && typeof sent.text === 'string' && sent.text.length > 20);
    ok('send: provider and service keys never appear in the response', !JSON.stringify(r).includes('KEY_SHOULD_NEVER_LEAK'));
    s.restore();
  }
  { // only job_id/sweep are read: a bad id is refused
    const db = mkDb([], {}); const s = loadSend(baseEnv, db, async () => ({ ok: true, status: 200 }));
    const r = await run(s.handler, { job_id: "x'; drop table email_outbox;--" });
    ok('send: malformed job id is refused', r.status === 400 && db.calls.length === 0); s.restore();
  }
  for (const [name, impl, outcome, category] of [
    ['transient provider failure (503)', async () => ({ ok: false, status: 503, body: { cancel: async () => {} } }), 'transient', 'provider_unavailable'],
    ['rate limit (429)', async () => ({ ok: false, status: 429, body: { cancel: async () => {} } }), 'transient', 'rate_limited'],
    ['network failure', async () => { throw new Error('ECONNRESET'); }, 'transient', 'network'],
    ['permanent rejection (422)', async () => ({ ok: false, status: 422, body: { cancel: async () => {} } }), 'permanent', 'invalid_request'],
  ]) {
    const db = mkDb([{ id: J, template: 'payment_received' }], okCtx); const s = loadSend(baseEnv, db, impl);
    const r = await run(s.handler, { job_id: J });
    ok(`send: ${name} -> ${outcome}/${category}, request still answers 200`, completes(db)[0].p_outcome === outcome && completes(db)[0].p_error_category === category && r.status === 200);
    s.restore();
  }
  { // record no longer justifies the email -> skipped, provider never called
    let called = false;
    const db = mkDb([{ id: J, template: 'membership_activated' }], { [J]: { ok: false, skip_reason: 'membership_not_active' } });
    const s = loadSend(baseEnv, db, async () => { called = true; return { ok: true, status: 200 }; });
    await run(s.handler, { job_id: J });
    ok('send: no false confirmation when the record does not support it', !called && completes(db)[0].p_outcome === 'skipped' && completes(db)[0].p_error_category === 'membership_not_active');
    s.restore();
  }
  { // one bad job must not stop the rest, and errors never carry the address
    const J2 = '22222222-2222-4222-8222-222222222222';
    const errs = []; const origErr = console.error; console.error = (...a) => errs.push(JSON.stringify(a));
    const db = mkDb([{ id: J, template: 'x' }, { id: J2, template: 'payment_received' }], { [J2]: ctx('payment_received', { receipt }) });
    const origRpc = db.rpc; db.rpc = async (fn, args) => (fn === 'email_job_context' && args.p_job === J ? { data: null, error: { message: 'boom member@example.org' } } : origRpc(fn, args));
    const s = loadSend(baseEnv, db, async () => ({ ok: true, status: 200, json: async () => ({ id: 'm2' }) }));
    const r = await run(s.handler, { sweep: true }); console.error = origErr;
    const c = completes(db);
    ok('send: a job whose context fails is retried later; the next job still sends', c[0].p_outcome === 'transient' && c[1].p_outcome === 'sent' && r.status === 200);
    ok('send: logs never contain the member address', !errs.join('').includes('member@example.org'), errs.join(''));
    s.restore();
  }
  { // outcome could not be recorded: no crash
    const db = mkDb([{ id: J, template: 'payment_received' }], okCtx); const o = db.rpc;
    db.rpc = async (fn, a) => (fn === 'complete_email_job' ? { data: null, error: { message: 'db down' } } : o(fn, a));
    const origErr = console.error; console.error = () => {};
    const s = loadSend(baseEnv, db, async () => ({ ok: true, status: 200, json: async () => ({ id: 'm' }) }));
    const r = await run(s.handler, { job_id: J }); console.error = origErr;
    ok('send: failing to record an outcome does not crash the worker', r.status === 200); s.restore();
  }
  // ─── Resend 409: two opposite meanings (https://resend.com/docs/api-reference/errors) ───
  ok('409 invalid_idempotent_request (same key, different body) is permanent: never retried', cls409('invalid_idempotent_request').outcome === 'permanent' && cls409('invalid_idempotent_request').category === 'idempotency_conflict');
  ok('409 concurrent_idempotent_requests (original still running) stays retryable', cls409('concurrent_idempotent_requests').outcome === 'transient');
  ok('an unrecognised or unreadable 409 stays retryable (bounded by max_attempts)', cls409('something_else').outcome === 'transient' && cls409(null).outcome === 'transient' && cls409(undefined).category === 'provider_busy');
  ok('the error name is not trusted for other statuses', logic.classifyProviderStatus(500, 'invalid_idempotent_request').outcome === 'transient' && logic.classifyProviderStatus(200, 'invalid_idempotent_request').outcome === 'sent');
  ok('quota errors say why and still back off; plain 429 is a rate limit', logic.classifyProviderStatus(429, 'daily_quota_exceeded').category === 'quota_exceeded' && logic.classifyProviderStatus(429, 'monthly_quota_exceeded').outcome === 'transient' && logic.classifyProviderStatus(429, 'rate_limit_exceeded').category === 'rate_limited' && logic.classifyProviderStatus(429).category === 'rate_limited');
  ok('transient server and network failures remain retryable', [500, 502, 503, 504].every((c) => logic.classifyProviderStatus(c, 'application_error').outcome === 'transient') && logic.NETWORK_FAILURE.outcome === 'transient');
  ok('an unverified sender domain or bad key stays permanent', logic.classifyProviderStatus(403, 'validation_error').outcome === 'permanent' && logic.classifyProviderStatus(401, 'missing_api_key').category === 'provider_auth');
  {
    const rn = logic.readProviderErrorName;
    ok('error name: read from a normal Resend error body', (await rn({ json: async () => ({ name: 'invalid_idempotent_request', statusCode: 409, message: 'x@y.z' }) })) === 'invalid_idempotent_request');
    ok('error name: only a short lower-case token is accepted', (await rn({ json: async () => ({ name: 'Bad Name <a@b.c>' }) })) === null && (await rn({ json: async () => ({ name: 5 }) })) === null && (await rn({ json: async () => ({ name: 'a'.repeat(100) }) })) === null);
    ok('error name: an unreadable body, a thrown error or no json() all give null', (await rn({ json: async () => { throw new Error('not json'); } })) === null && (await rn({})) === null && (await rn({ json: () => { throw new Error('sync'); } })) === null && (await rn({ json: async () => null })) === null);
  }
  for (const [label, status, body, wantOutcome, wantCategory, wantStatus] of [
    ['409 payload mismatch', 409, { name: 'invalid_idempotent_request', message: 'member@example.org' }, 'permanent', 'idempotency_conflict', 'failed'],
    ['409 concurrent', 409, { name: 'concurrent_idempotent_requests', message: 'in progress' }, 'transient', 'provider_busy', 'retry_scheduled'],
    ['409 unreadable body', 409, 'NOT-JSON', 'transient', 'provider_busy', 'retry_scheduled'],
    ['429 daily quota', 429, { name: 'daily_quota_exceeded', message: 'quota' }, 'transient', 'quota_exceeded', 'retry_scheduled'],
    ['429 rate limit', 429, { name: 'rate_limit_exceeded', message: 'slow down' }, 'transient', 'rate_limited', 'retry_scheduled'],
    ['503 unavailable', 503, { name: 'service_unavailable', message: 'down' }, 'transient', 'provider_unavailable', 'retry_scheduled'],
    ['403 domain not verified', 403, { name: 'validation_error', message: 'The domain is not verified' }, 'permanent', 'provider_auth', 'failed'],
  ]) { // the real handler, against a fake Resend returning those responses
    const errs = []; const warns = []; const oe = console.error; const ol = console.log; console.error = (...a) => errs.push(JSON.stringify(a)); console.log = (...a) => warns.push(JSON.stringify(a));
    const db = mkDb([{ id: J, template: 'payment_received' }], okCtx);
    const calls = { n: 0 };
    const s = loadSend(baseEnv, db, async () => { calls.n++; return { ok: false, status, json: async () => { if (body === 'NOT-JSON') throw new Error('Unexpected token'); return body; } }; });
    const r = await run(s.handler, { job_id: J }); console.error = oe; console.log = ol;
    const c = completes(db)[0];
    ok(`send: ${label} -> ${wantOutcome} (${wantCategory}), recorded as ${wantStatus}`, c.p_outcome === wantOutcome && c.p_error_category === wantCategory && c.p_message_id === null && calls.n === 1 && r.status === 200, JSON.stringify(c));
    ok(`send: ${label} -> the provider's text and the address are never stored or logged`, !JSON.stringify(db.calls).includes('member@example.org') && !errs.join('').includes('member@example.org') && !warns.join('').includes('member@example.org') && !JSON.stringify(c).includes('The domain'));
    s.restore();
  }
  { // a job that hit a payload mismatch is not picked up again by itself: the database maps 'permanent' to 'failed' (no new attempt)
    const sql409 = fs.readFileSync(path.join(__dirname, '..', 'proposals', '0033_transactional_email.sql'), 'utf8');
    ok('migration: a permanent outcome becomes failed with no retry scheduled', /else\s+update public\.email_outbox set status = 'failed'/.test(sql409) && /p_outcome = 'transient' and v_job\.attempts < v_job\.max_attempts/.test(sql409));
  }
  { // email functions never call any payment, credit, membership or booking function
    const db = mkDb([{ id: J, template: 'payment_received' }], okCtx); const s = loadSend(baseEnv, db, async () => ({ ok: true, status: 200, json: async () => ({ id: 'm' }) }));
    await run(s.handler, { job_id: J });
    const used = new Set(db.calls.map((c) => c[0]));
    ok('send: only touches email_outbox functions (retrying email never reprocesses payment/credits)', [...used].every((f) => ['claim_email_jobs', 'email_job_context', 'complete_email_job'].includes(f)), [...used].join());
    s.restore();
  }

  // ─── payment-reconcile handler ────────────────────────────────────────────
  const loadRec = (env, db, fetchImpl) => {
    let handler;
    const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
    const prev = global.fetch; global.fetch = fetchImpl;
    compile(FN + 'payment-reconcile/index.ts', { 'jsr:@supabase/supabase-js@2': { createClient: () => db }, '../email-send/logic.ts': logic, './logic.ts': R, __Deno: Deno });
    return { handler, restore: () => { global.fetch = prev; } };
  };
  const recEnv = { ...baseEnv, RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'rzp_secret_SHOULD_NEVER_LEAK' };
  const rzp = (map) => async (url) => {
    const order = decodeURIComponent(url.split('/orders/')[1].split('/payments')[0]);
    const v = map[order];
    if (v === 'error') return { ok: false, status: 502 };
    return { ok: true, status: 200, json: async () => ({ items: v }) };
  };
  const mkRecDb = (open) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push([fn, args]); if (fn === 'payments_needing_reconciliation') return { data: open, error: null }; if (fn === 'enqueue_payment_pending_email') return { data: true, error: null }; return { data: null, error: null }; } }; };
  const open = [
    { payment_id: 'p-cap', gateway_order_id: 'order_cap' }, { payment_id: 'p-old', gateway_order_id: 'order_old' }, { payment_id: 'p-young', gateway_order_id: 'order_young' },
    { payment_id: 'p-fail', gateway_order_id: 'order_fail' }, { payment_id: 'p-err', gateway_order_id: 'order_err' },
  ];
  const nowS = Math.floor(Date.now() / 1000);
  const map = {
    order_cap: [{ id: 'pay_REAL', status: 'captured', amount: 500000, currency: 'INR' }],
    order_old: [{ id: 'pay_o', status: 'authorized', created_at: nowS - 4000 }],
    order_young: [{ id: 'pay_y', status: 'authorized', created_at: nowS - 100 }],
    order_fail: [{ id: 'pay_f', status: 'failed' }],
    order_err: 'error',
  };
  {
    const db = mkRecDb(open); const s = loadRec(recEnv, db, rzp(map));
    const r = await run(s.handler, { sweep: true });
    const proc = db.calls.filter((c) => c[0] === 'process_payment_webhook');
    ok('reconcile: a captured payment goes through the EXISTING process_payment_webhook', proc.length === 1 && proc[0][1].p_gateway_order_id === 'order_cap' && proc[0][1].p_status === 'success');
    ok('reconcile: uses a stable event id, amount in rupees and the gateway currency', proc[0][1].p_event_id === 'reconcile:pay_REAL' && proc[0][1].p_amount === 5000 && proc[0][1].p_currency === 'INR');
    const pend = db.calls.filter((c) => c[0] === 'enqueue_payment_pending_email').map((c) => c[1].p_payment_id);
    ok('reconcile: one pending notice, only for the long-unresolved payment', pend.length === 1 && pend[0] === 'p-old', JSON.stringify(pend));
    ok('reconcile: failed attempts and lookup errors change nothing', !proc.some((c) => ['order_fail', 'order_err', 'order_old', 'order_young'].includes(c[1].p_gateway_order_id)) && r.body.lookup_failed === 1);
    ok('reconcile: summary counts', r.body.checked === 5 && r.body.recovered === 1 && r.body.still_pending === 2 && r.body.pending_notified === 1, JSON.stringify(r.body));
    ok('reconcile: never creates payments/orders and never calls email send', db.calls.every((c) => ['payments_needing_reconciliation', 'process_payment_webhook', 'enqueue_payment_pending_email'].includes(c[0])));
    ok('reconcile: gateway secret not in the response', !JSON.stringify(r).includes('SHOULD_NEVER_LEAK'));
    s.restore();
  }
  { // running again changes nothing new at this layer: the same stable event id is sent; the database dedupes
    const db = mkRecDb([open[0]]); const s = loadRec(recEnv, db, rzp(map));
    await run(s.handler, {}); await run(s.handler, {});
    const ids = db.calls.filter((c) => c[0] === 'process_payment_webhook').map((c) => c[1].p_event_id);
    ok('reconcile: repeat runs use the same event id (idempotent)', ids.length === 2 && ids[0] === ids[1]); s.restore();
  }
  { // unauthorized / not configured
    const db = mkRecDb(open); const s = loadRec(recEnv, db, rzp(map));
    ok('reconcile: unauthorized refused', (await run(s.handler, {}, { 'x-email-secret': 'nope' })).status === 401 && db.calls.length === 0); s.restore();
    const db2 = mkRecDb(open); const s2 = loadRec({ ...recEnv, RAZORPAY_KEY_SECRET: undefined }, db2, rzp(map));
    ok('reconcile: without Razorpay credentials nothing runs', (await run(s2.handler, {})).body.reason === 'not_configured' && db2.calls.length === 0); s2.restore();
  }

  // ─── static security checks ───────────────────────────────────────────────
  const mobileSrc = path.join(__dirname, '..', '..', '..', 'CHR-Mobile', 'CHR-mobile-app', 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  if (fs.existsSync(mobileSrc)) {
    const leaks = walk(mobileSrc).filter((f) => /\.(ts|tsx|js)$/.test(f) && /RESEND_(API_KEY|WEBHOOK_SECRET)|EMAIL_FUNCTION_SECRET|email_send_secret|EXPO_PUBLIC_\w*(SERVICE_ROLE|SECRET)/.test(fs.readFileSync(f, 'utf8')));
    ok('mobile app contains no email-provider secret names', leaks.length === 0, leaks.join());
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'proposals', '0033_transactional_email.sql'), 'utf8');
  ok('migration: worker/context/pending functions are not granted to clients', !/grant execute on function public\.(claim_email_jobs|complete_email_job|email_job_context|record_email_provider_event|payments_needing_reconciliation|enqueue_payment_pending_email)/.test(sql));
  ok('migration: outbox has RLS and no client privileges', /alter table public\.email_outbox enable row level security/.test(sql) && /revoke all on public\.email_outbox from anon, authenticated/.test(sql));
  ok('migration: no email-provider secret value', !/re_[A-Za-z0-9]{12,}/.test(sql));

  // ═══ Resend published template for membership_activated (OFF by default) ═══════════════════════════════════
  const TEMPLATE_ID = 'f394ace4-e556-4438-a4ec-102bb7851989';
  const memCtx = (over = {}) => ctx('membership_activated', { membership: { name: 'Gold Membership', credits: 8, start_date: '2026-10-20', end_date: '2026-11-18', reschedules_allowed: 2 }, ...over });
  const DECL = RT.SUPPORTED_VARIABLE_KEYS;
  const bm = (c, o = {}) => RT.buildMembershipTemplateRequest(c, { linkBase: 'https://chr.example.org', declared: DECL, ...o });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  { // ── the adapter: payload, mapping, required and optional data ──
    const full = bm(memCtx());
    ok('template: the published template id is the default', full.ok && full.template.id === TEMPLATE_ID);
    ok('template: variables are exactly the real membership, member and club values', full.ok && same(full.template.variables, {
      MEMBER_NAME: 'Asha Rao', PLAN_NAME: 'Gold Membership', CLASS_CREDITS: '8', START_DATE: 'Tue, 20 Oct 2026', END_DATE: 'Wed, 18 Nov 2026',
      RESCHEDULES_ALLOWED: '2', DASHBOARD_URL: 'https://chr.example.org/account', CLUB_NAME: 'Colonel Horse Riding Club', CLUB_CONTACT_EMAIL: 'club@example.org' }), JSON.stringify(full.template?.variables));
    ok('template: dates use the same wording as the standard email', full.ok && full.template.variables.START_DATE === T.dayLabel('2026-10-20') && full.template.variables.END_DATE === T.dayLabel('2026-11-18'));
    ok('template: the plan name and credits come from the record (not invented)', bm(memCtx({ membership: { name: 'Platinum Membership', credits: 15, start_date: '2026-10-20', end_date: '2026-11-18', reschedules_allowed: 2 } })).template.variables.PLAN_NAME === 'Platinum Membership'
      && bm(memCtx({ membership: { name: 'Platinum Membership', credits: 15, start_date: '2026-10-20', end_date: '2026-11-18' } })).template.variables.CLASS_CREDITS === '15');
    ok('template: every key follows Resend\'s rules (ASCII letters, digits, underscore; max 50; not reserved)', DECL.every((k) => /^[A-Za-z0-9_]{1,50}$/.test(k) && !RT.RESERVED_VARIABLE_KEYS.includes(k)));
    ok('template: every value is a string of at most 2000 characters', Object.values(full.template.variables).every((v) => typeof v === 'string' && v.length <= 2000));
    ok('template: only the variables the template registered are sent', same(Object.keys(bm(memCtx(), { declared: ['MEMBER_NAME', 'PLAN_NAME', 'CLASS_CREDITS', 'START_DATE', 'END_DATE'] }).template.variables), ['MEMBER_NAME', 'PLAN_NAME', 'CLASS_CREDITS', 'START_DATE', 'END_DATE']));
    ok('template: an alias or a custom id is accepted, garbage falls back to the published id', bm(memCtx(), { templateId: 'membership-confirmation' }).template.id === 'membership-confirmation'
      && bm(memCtx(), { templateId: 'Bad Id/../x' }).template.id === TEMPLATE_ID && bm(memCtx(), { templateId: null }).template.id === TEMPLATE_ID);

    // missing OPTIONAL fields
    const bare = bm(memCtx({ member_name: null, business: {}, membership: { name: 'Gold Membership', credits: 8, start_date: '2026-10-20', end_date: '2026-11-18' } }), { linkBase: null });
    ok('template: a member with no name is greeted as "there", exactly like the standard email', bare.ok && bare.template.variables.MEMBER_NAME === 'there');
    ok('template: optional values that are missing are left out, never sent as "undefined" or "null"', bare.ok && !('RESCHEDULES_ALLOWED' in bare.template.variables) && !('DASHBOARD_URL' in bare.template.variables) && !('CLUB_ADDRESS' in bare.template.variables) && !('CLUB_CONTACT_EMAIL' in bare.template.variables) && !('CLUB_CONTACT_PHONE' in bare.template.variables) && !/undefined|null/.test(JSON.stringify(bare.template.variables)));
    ok('template: with no club name configured the club\'s own name is used', bare.template.variables.CLUB_NAME === 'Colonel Horse Riding Club');
    ok('template: no dashboard link without an https base, and an http base is refused by the caller', !('DASHBOARD_URL' in bm(memCtx(), { linkBase: null }).template.variables));
    ok('template: zero reschedules is a real value and is kept', bm(memCtx({ membership: { name: 'X', credits: 1, start_date: '2026-10-20', end_date: '2026-11-18', reschedules_allowed: 0 } })).template.variables.RESCHEDULES_ALLOWED === '0');

    // missing REQUIRED data: the template is not used at all
    for (const [label, patch] of [['plan name', { name: '' }], ['class credits', { credits: null }], ['start date', { start_date: null }], ['end date', { end_date: 'not a date' }]]) {
      const r = bm(memCtx({ membership: { name: 'Gold Membership', credits: 8, start_date: '2026-10-20', end_date: '2026-11-18', ...patch } }));
      ok(`template: missing required ${label} -> template refused, named`, r.ok === false && r.reason === 'missing_required' && r.missing.length === 1);
    }
    ok('template: no membership record at all -> refused', bm(memCtx({ membership: undefined })).reason === 'missing_membership' && bm(memCtx({ membership: null })).reason === 'missing_membership');
    ok('template: any other email type is refused by the adapter', ['payment_received', 'booking_confirmed', 'reschedule_confirmed', 'order_confirmation', 'payment_pending'].every((t) => bm(ctx(t, { membership: memCtx().membership })).reason === 'wrong_template'));
    ok('template: not configured (no list of registered variables) -> refused', bm(memCtx(), { declared: null }).reason === 'not_configured');
    ok('template: a registered variable the code cannot fill -> refused, never guessed', (() => { const r = bm(memCtx(), { declared: ['PLAN_NAME', 'FAVOURITE_HORSE'] }); return r.ok === false && r.reason === 'unsupported_variable' && same(r.missing, ['FAVOURITE_HORSE']); })());

    // safety of the values
    const evil = bm(memCtx({ member_name: '<script>alert(1)</script> "O\'Brien" & Co' })).template.variables.MEMBER_NAME;
    ok('template: a member\'s name is HTML-escaped before it goes into the template', !evil.includes('<') && !evil.includes('"') && evil.includes('&lt;script&gt;') && evil.includes('&amp;') && evil.includes('&#39;'), evil);
    ok('template: an over-long value is cut to 2000 characters', bm(memCtx({ member_name: 'a'.repeat(5000) })).template.variables.MEMBER_NAME.length === 2000);
    ok('template: nothing secret or personal beyond the name and club details is in the payload', !/member@example\.org/.test(JSON.stringify(full)));
    ok('declared variables: parsed, trimmed, de-duplicated; blank means not configured', same(RT.parseDeclaredVariables(' A , B,A,, '), ['A', 'B']) && RT.parseDeclaredVariables('') === null && RT.parseDeclaredVariables(undefined) === null && RT.parseDeclaredVariables(' , ') === null);
  }

  { // ── diagnosing the published template (the "No variables" problem) ──
    const reg = (k) => ({ id: 'v-' + k, key: k, type: 'string', fallback_value: null });
    const broken = RT.analyseTemplate({ status: 'published', html: '<p>Hello {{name}}, your membership {{ plan }} is active.</p>', variables: [] });
    ok('diagnosis: plain {{name}} placeholders are reported as literal text, not variables', broken.verdict === 'not_ready' && same(broken.literalDoublePlaceholders, ['name', 'plan']) && broken.registered.length === 0 && broken.problems.some((p) => /NO registered variables/.test(p)) && broken.problems.some((p) => /literal text/.test(p)));
    const good = RT.analyseTemplate({ status: 'published', has_unpublished_versions: false, html: '<p>Hi {{{MEMBER_NAME}}}: {{{PLAN_NAME}}}, {{{CLASS_CREDITS}}} classes, {{{START_DATE}}} to {{{END_DATE}}}</p>', variables: ['MEMBER_NAME', 'PLAN_NAME', 'CLASS_CREDITS', 'START_DATE', 'END_DATE'].map(reg) });
    ok('diagnosis: a correctly registered template is ready, and the value to configure is printed', good.verdict === 'ready' && good.suggestedDeclared === 'MEMBER_NAME,PLAN_NAME,CLASS_CREDITS,START_DATE,END_DATE' && good.problems.length === 0);
    ok('diagnosis: the suggested list is accepted by the adapter and builds a full payload', (() => { const r = bm(memCtx(), { declared: RT.parseDeclaredVariables(good.suggestedDeclared) }); return r.ok && Object.keys(r.template.variables).length === 5; })());
    ok('diagnosis: a draft, or edits not yet published, is not ready', RT.analyseTemplate({ status: 'draft', html: '', variables: good.registered.map(reg) }).verdict === 'not_ready' && RT.analyseTemplate({ status: 'published', has_unpublished_versions: true, html: '{{{PLAN_NAME}}}{{{CLASS_CREDITS}}}{{{START_DATE}}}{{{END_DATE}}}', variables: ['PLAN_NAME', 'CLASS_CREDITS', 'START_DATE', 'END_DATE'].map(reg) }).problems.some((p) => /unpublished/.test(p)));
    ok('diagnosis: a variable the code cannot supply, or a reserved name, is flagged', (() => { const a = RT.analyseTemplate({ status: 'published', html: '{{{FIRST_NAME}}} {{{FAVOURITE_HORSE}}}', variables: ['FIRST_NAME', 'FAVOURITE_HORSE'].map(reg) }); return a.verdict === 'not_ready' && same(a.reserved, ['FIRST_NAME']) && a.unsupportedByAdapter.includes('FAVOURITE_HORSE'); })());
    ok('diagnosis: a variable used in the body but never registered is flagged', RT.analyseTemplate({ status: 'published', html: '{{{PLAN_NAME}}} {{{GHOST}}}', variables: [reg('PLAN_NAME')] }).usedButNotRegistered.includes('GHOST'));
    ok('diagnosis: copes with an empty or odd response', RT.analyseTemplate({}).verdict === 'not_ready' && RT.analyseTemplate(null).verdict === 'not_ready');
  }

  // ── the real handler, with a fake Resend ──
  const TPL_ENV = { EMAIL_MEMBERSHIP_TEMPLATE_ENABLED: 'true', EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES: DECL.join(','), EMAIL_REPLY_TO: 'club@example.org', EMAIL_LINK_BASE_URL: 'https://chr.example.org' };
  const BASE_ENV = { EMAIL_REPLY_TO: 'club@example.org', EMAIL_LINK_BASE_URL: 'https://chr.example.org' };
  const capture = () => { const logs = []; const e = console.error, w = console.warn, l = console.log; console.error = (...a) => logs.push(JSON.stringify(a)); console.warn = (...a) => logs.push(JSON.stringify(a)); console.log = (...a) => logs.push(JSON.stringify(a)); return { logs, stop: () => { console.error = e; console.warn = w; console.log = l; } }; };
  const send = async (env, context, fetchImpl, tpl = context.template) => {
    const cap = capture();
    const db = mkDb([{ id: J, template: tpl }], { [J]: context });
    const s = loadSend({ ...baseEnv, ...env }, db, fetchImpl);
    const r = await run(s.handler, { job_id: J });
    s.restore(); cap.stop();
    return { db, r, logs: cap.logs.join('\n') };
  };
  const recorder = (responses) => { const calls = []; let i = 0; return { calls, fetch: async (url, init) => {
    const spec = responses[Math.min(i++, responses.length - 1)];
    calls.push({ url, key: init.headers['Idempotency-Key'], auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (spec === 'network') throw new Error('socket hang up');
    return { ok: spec.status >= 200 && spec.status < 300, status: spec.status, json: async () => { if (spec.body === 'NOT-JSON') throw new Error('x'); return spec.body ?? {}; } };
  } }; };
  const OK = { status: 200, body: { id: 'resend_msg_tpl' } };

  { // default: OFF. The membership email is byte-for-byte what it was before this feature existed.
    const stdBody = (c) => { const m = T.renderEmail(c, 'https://chr.example.org'); return { from: baseEnv.EMAIL_FROM, to: [c.to], reply_to: 'club@example.org', subject: m.subject, html: m.html, text: m.text }; };
    for (const [label, env] of [['flag unset', BASE_ENV], ['flag "TRUE"', { ...BASE_ENV, EMAIL_MEMBERSHIP_TEMPLATE_ENABLED: 'TRUE', EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES: DECL.join(',') }], ['flag "1"', { ...BASE_ENV, EMAIL_MEMBERSHIP_TEMPLATE_ENABLED: '1', EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES: DECL.join(',') }], ['flag "false"', { ...BASE_ENV, EMAIL_MEMBERSHIP_TEMPLATE_ENABLED: 'false', EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES: DECL.join(',') }]]) {
      const rec = recorder([OK]);
      const { r } = await send(env, memCtx(), rec.fetch);
      ok(`template OFF (${label}): one standard HTML+text email, identical to the previous behaviour`, rec.calls.length === 1 && same(rec.calls[0].body, stdBody(memCtx())) && !('template' in rec.calls[0].body) && r.body.sent === 1, JSON.stringify(Object.keys(rec.calls[0]?.body ?? {})));
    }
    const rec = recorder([OK]);
    await send({ ...BASE_ENV, EMAIL_MEMBERSHIP_TEMPLATE_ENABLED: 'true' }, memCtx(), rec.fetch);
    ok('template ENABLED but the registered variables are not configured -> standard email (refuses to guess)', rec.calls.length === 1 && 'html' in rec.calls[0].body && !('template' in rec.calls[0].body));
    const rec2 = recorder([OK]);
    await send({ ...TPL_ENV, EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES: 'PLAN_NAME,FAVOURITE_HORSE' }, memCtx(), rec2.fetch);
    ok('template ENABLED but a registered variable is one the code cannot fill -> standard email', rec2.calls.length === 1 && 'html' in rec2.calls[0].body && !('template' in rec2.calls[0].body));
  }

  { // ENABLED and configured: the template request
    const rec = recorder([OK]);
    const { db, r, logs } = await send(TPL_ENV, memCtx(), rec.fetch);
    const b = rec.calls[0].body;
    ok('template ON: one Resend call to /emails with the published template id and the mapped variables', rec.calls.length === 1 && rec.calls[0].url === 'https://api.resend.com/emails' && b.template.id === TEMPLATE_ID && b.template.variables.PLAN_NAME === 'Gold Membership' && b.template.variables.CLASS_CREDITS === '8');
    ok('template ON: no html, text or react is sent together with the template (Resend would reject it)', !('html' in b) && !('text' in b) && !('react' in b));
    ok('template ON: recipient, from, reply-to and subject are unchanged; the recipient is the database\'s, not the request\'s', same(b.to, ['member@example.org']) && b.from === baseEnv.EMAIL_FROM && b.reply_to === 'club@example.org' && b.subject === 'Your CHR membership is active');
    ok('template ON: the Idempotency-Key is still the job id, and the bearer key is still used', rec.calls[0].key === J && /^Bearer /.test(rec.calls[0].auth));
    ok('template ON: success is recorded exactly as before (sent, provider message id for webhook tracking)', completes(db).length === 1 && completes(db)[0].p_outcome === 'sent' && completes(db)[0].p_message_id === 'resend_msg_tpl' && r.body.sent === 1);
    ok('template ON: the member\'s address is never logged', !logs.includes('member@example.org'));
    const lookalike = await (async () => { const rc = recorder([OK]); await send({ ...TPL_ENV, EMAIL_MEMBERSHIP_TEMPLATE_ID: 'membership-confirmation' }, memCtx(), rc.fetch); return rc.calls[0].body.template.id; })();
    ok('template ON: the alias can be configured instead of the id', lookalike === 'membership-confirmation');
  }

  { // every OTHER email type stays on the existing rendering path, even with the template switched on
    const others = [
      ['payment_received', ctx('payment_received', { receipt })],
      ['booking_confirmed', ctx('booking_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-21', start_time: '06:30', end_time: '07:30' } })],
      ['reschedule_confirmed', ctx('reschedule_confirmed', { booking: { reference: 'AB12CD34', status: 'confirmed', date: '2026-10-22', start_time: '07:00', end_time: '08:00', original: { date: '2026-10-21', start_time: '06:30', end_time: '07:30' } } })],
      ['order_confirmation', ctx('order_confirmation', { order: { reference: 'CHR-1', status: 'paid', payment_status: 'success', total: 450, currency: 'INR', has_in_store: true, items: [{ name: 'Helmet', quantity: 1, unit_price: 450 }] } })],
      ['payment_pending', ctx('payment_pending', { payment: { amount: 5000, currency: 'INR', order_reference: 'CHR-1', started_at: '2026-10-19T08:00:00Z' } })],
    ];
    for (const [name, c0] of others) {
      // Adversarial: every other type also carries complete membership data, so ONLY the email-type checks keep it off the template.
      const c = { ...c0, membership: memCtx().membership };
      const on = recorder([OK]), off = recorder([OK]);
      await send(TPL_ENV, c, on.fetch);
      await send(BASE_ENV, c, off.fetch);
      ok(`${name}: with the template switched on it is still the standard HTML+text email, identical to switched off`, on.calls.length === 1 && 'html' in on.calls[0].body && 'text' in on.calls[0].body && !('template' in on.calls[0].body) && same(on.calls[0].body, off.calls[0].body) && on.calls[0].key === J);
    }
  }

  { // missing REQUIRED data with the template on: the standard email is sent instead, once
    const rec = recorder([OK]);
    const { db, r, logs } = await send(TPL_ENV, memCtx({ membership: { name: '', credits: 8, start_date: '2026-10-20', end_date: '2026-11-18' } }), rec.fetch);
    ok('missing required data: the member still gets the standard email (one call, same key)', rec.calls.length === 1 && 'html' in rec.calls[0].body && !('template' in rec.calls[0].body) && rec.calls[0].key === J && completes(db)[0].p_outcome === 'sent' && r.body.sent === 1);
    ok('missing required data: the reason is logged without the address', /missing_required/.test(logs) && /PLAN_NAME/.test(logs) && !logs.includes('member@example.org'));
  }

  { // Resend rejects the TEMPLATE request: fall back to the standard email, once
    for (const [label, status, body] of [['422 missing_required_field', 422, { name: 'missing_required_field' }], ['400 validation_error', 400, { name: 'validation_error', message: 'member@example.org' }], ['404 not_found', 404, { name: 'not_found' }], ['422, unreadable body', 422, 'NOT-JSON']]) {
      const rec = recorder([{ status, body }, OK]);
      const { db, r, logs } = await send(TPL_ENV, memCtx(), rec.fetch);
      const [t, s] = rec.calls;
      ok(`template API error ${label}: the standard email is sent instead (two calls: template, then standard)`, rec.calls.length === 2 && 'template' in t.body && 'html' in s.body && !('template' in s.body) && completes(db)[0].p_outcome === 'sent' && completes(db)[0].p_message_id === 'resend_msg_tpl' && r.body.sent === 1);
      ok(`template API error ${label}: the template call keeps the job id as its idempotency key; the standard call has its own`, t.key === J && s.key === J + ':standard' && s.key !== t.key);
      ok(`template API error ${label}: the standard email is the same as the normal one, and the provider's text and the address are never logged`, same(s.body, { from: baseEnv.EMAIL_FROM, to: ['member@example.org'], reply_to: 'club@example.org', subject: 'Your CHR membership is active', html: T.renderEmail(memCtx(), 'https://chr.example.org').html, text: T.renderEmail(memCtx(), 'https://chr.example.org').text }) && !logs.includes('member@example.org'));
    }
    const both = recorder([{ status: 422, body: { name: 'validation_error' } }, { status: 422, body: { name: 'validation_error' } }]);
    const r1 = await send(TPL_ENV, memCtx(), both.fetch);
    ok('template rejected AND the standard email rejected: a permanent failure, exactly as for any email', both.calls.length === 2 && completes(r1.db)[0].p_outcome === 'permanent' && completes(r1.db)[0].p_error_category === 'invalid_request');
    const flaky = recorder([{ status: 422, body: { name: 'validation_error' } }, { status: 503, body: { name: 'service_unavailable' } }]);
    const r2 = await send(TPL_ENV, memCtx(), flaky.fetch);
    ok('template rejected, then the standard email hits a server error: retried later like any email', completes(r2.db)[0].p_outcome === 'transient' && completes(r2.db)[0].p_error_category === 'provider_unavailable');
  }

  { // errors that must NOT fall back: the same request is retried, or stops, exactly as before
    for (const [label, spec, wantOutcome, wantCategory] of [
      ['429 rate limit', { status: 429, body: { name: 'rate_limit_exceeded' } }, 'transient', 'rate_limited'],
      ['429 daily quota', { status: 429, body: { name: 'daily_quota_exceeded' } }, 'transient', 'quota_exceeded'],
      ['500 server error', { status: 500, body: { name: 'application_error' } }, 'transient', 'provider_unavailable'],
      ['503 unavailable', { status: 503, body: { name: 'service_unavailable' } }, 'transient', 'provider_unavailable'],
      ['network failure', 'network', 'transient', 'network'],
      ['401 bad key', { status: 401, body: { name: 'missing_api_key' } }, 'permanent', 'provider_auth'],
      ['403 domain not verified', { status: 403, body: { name: 'validation_error' } }, 'permanent', 'provider_auth'],
      ['409 concurrent request', { status: 409, body: { name: 'concurrent_idempotent_requests' } }, 'transient', 'provider_busy'],
      ['409 payload mismatch', { status: 409, body: { name: 'invalid_idempotent_request' } }, 'permanent', 'idempotency_conflict'],
    ]) {
      const rec = recorder([spec, OK]);
      const { db } = await send(TPL_ENV, memCtx(), rec.fetch);
      const c = completes(db)[0];
      ok(`template call, ${label}: NO fallback send; recorded as ${wantOutcome} (${wantCategory}) like any email`, rec.calls.length === 1 && c.p_outcome === wantOutcome && c.p_error_category === wantCategory && c.p_message_id === null, JSON.stringify({ calls: rec.calls.length, c }));
    }
  }

  { // idempotency and retry behaviour are unchanged
    const rec1 = recorder([{ status: 503, body: {} }]);
    await send(TPL_ENV, memCtx(), rec1.fetch);
    const rec2 = recorder([OK]);
    await send(TPL_ENV, memCtx(), rec2.fetch);                    // the retry, later
    ok('retry: the second attempt for the same job sends the identical request with the identical Idempotency-Key', rec1.calls[0].key === J && rec2.calls[0].key === J && same(rec1.calls[0].body, rec2.calls[0].body));
    const st = recorder([OK]);
    const sa = await send(TPL_ENV, memCtx(), st.fetch);
    ok('retry: a job already marked sent is never claimed again, so no second email (the database decides)', completes(sa.db).length === 1 && sa.db.calls.filter((c) => c[0] === 'claim_email_jobs').length === 1);
    const recT = recorder([{ status: 503, body: {} }]);
    const tr = await send(TPL_ENV, memCtx(), recT.fetch);
    ok('retry: a transient failure still schedules a retry (the backoff lives in complete_email_job, untouched)', completes(tr.db)[0].p_outcome === 'transient' && tr.r.body.retry_scheduled === 1);
    ok('only email-outbox functions are called with the template on (no payment, credit or membership function)', [...new Set(tr.db.calls.map((c) => c[0]))].every((f) => ['claim_email_jobs', 'email_job_context', 'complete_email_job'].includes(f)));
  }

  { // a skipped or unreadable job does not reach Resend at all, template or not
    const rec = recorder([OK]);
    const sk = await send(TPL_ENV, { ok: false, skip_reason: 'membership_not_active' }, rec.fetch, 'membership_activated');
    ok('a membership that is no longer active is skipped: no Resend call, template or not', rec.calls.length === 0 && completes(sk.db)[0].p_outcome === 'skipped');
  }

  { // the source: the template secrets exist, and nothing else about sending changed
    const src = fs.readFileSync(FN + 'email-send/index.ts', 'utf8');
    ok('source: the template needs an exact "true" and a configured variable list; the default id is the published template', /EMAIL_MEMBERSHIP_TEMPLATE_ENABLED"\) === "true"/.test(src) && /EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES/.test(src) && RT.DEFAULT_MEMBERSHIP_TEMPLATE_ID === TEMPLATE_ID);
    ok('source: no Resend key or secret value in the adapter', !/re_[A-Za-z0-9]{12,}|whsec_|service_role/.test(fs.readFileSync(FN + 'email-send/resend-template.ts', 'utf8')));
  }

  { // ── the diagnostic tool, run as a real process (fixtures and a local fake Resend; no real network, no real key) ──
    const os = require('os'), http = require('http');
    const { execFile } = require('child_process');
    const TOOL = path.join(__dirname, '..', 'tools', 'inspect-resend-template.cjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-tpl-'));
    const runTool = (argv, env = {}) => new Promise((resolve) => execFile('node', ['--no-warnings', TOOL, ...argv], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
    const reg = (k) => ({ id: 'v-' + k, key: k, type: 'string', fallback_value: null });
    const brokenJson = path.join(tmp, 'broken.json'), goodJson = path.join(tmp, 'good.json'), brokenHtml = path.join(tmp, 'broken.html');
    fs.writeFileSync(brokenJson, JSON.stringify({ name: 'Membership Confirmation', alias: 'membership-confirmation', status: 'published', html: '<p>Hi {{name}}</p>', variables: [] }));
    fs.writeFileSync(goodJson, JSON.stringify({ name: 'Membership Confirmation', status: 'published', has_unpublished_versions: false, html: '{{{MEMBER_NAME}}} {{{PLAN_NAME}}} {{{CLASS_CREDITS}}} {{{START_DATE}}} {{{END_DATE}}}', variables: ['MEMBER_NAME', 'PLAN_NAME', 'CLASS_CREDITS', 'START_DATE', 'END_DATE'].map(reg) }));
    fs.writeFileSync(brokenHtml, '<h1>Welcome {{name}}</h1>');

    const t1 = await runTool(['--file', brokenJson]);
    ok('tool: the "No variables" template (plain {{name}}) is reported NOT READY with the reason and the fix', t1.code === 1 && /Registered variables \(0\): none/.test(t1.out) && /NOT READY/.test(t1.out) && /\{\{name\}\}/.test(t1.out) && /literal text/.test(t1.out) && /\{\{\{NAME\}\}\}/.test(t1.out), t1.out);
    const t2 = await runTool(['--file', goodJson]);
    ok('tool: a correctly registered template is READY and prints the exact secret value to configure', t2.code === 0 && /READY/.test(t2.out) && /EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES=MEMBER_NAME,PLAN_NAME,CLASS_CREDITS,START_DATE,END_DATE/.test(t2.out), t2.out);
    const t3 = await runTool(['--html', brokenHtml]);
    ok('tool: an HTML file with plain {{placeholders}} is not ready', t3.code === 1 && /\{\{name\}\}/.test(t3.out));
    const t4 = await runTool([]);
    ok('tool: with no key and no file it stops (exit 2) and says nothing was sent', t4.code === 2 && /Nothing was sent/.test(t4.out));

    let seen = [];
    let answer = { status: 200, body: JSON.parse(fs.readFileSync(goodJson, 'utf8')) };
    const server = http.createServer((rq, rs) => { seen.push({ url: rq.url, method: rq.method, auth: rq.headers.authorization }); rs.writeHead(answer.status, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(answer.body)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const FAKE_KEY = 're_FAKE_KEY_FOR_TEST_ONLY_0123456789';
    const a1 = await runTool([], { RESEND_API_KEY: FAKE_KEY, RESEND_API_BASE: base });
    ok('tool (API mode): one GET to /templates/<published id> with the bearer key, nothing posted', seen.length === 1 && seen[0].method === 'GET' && seen[0].url === '/templates/' + TEMPLATE_ID && seen[0].auth === 'Bearer ' + FAKE_KEY && a1.code === 0);
    ok('tool (API mode): the API key is never printed', !a1.out.includes(FAKE_KEY));
    seen = []; answer = { status: 200, body: JSON.parse(fs.readFileSync(brokenJson, 'utf8')) };
    const a2 = await runTool(['membership-confirmation'], { RESEND_API_KEY: FAKE_KEY, RESEND_API_BASE: base });
    ok('tool (API mode): the alias can be used, and a broken template is reported', seen[0].url === '/templates/membership-confirmation' && a2.code === 1 && !a2.out.includes(FAKE_KEY));
    answer = { status: 401, body: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } };
    const a3 = await runTool([], { RESEND_API_KEY: FAKE_KEY, RESEND_API_BASE: base });
    ok('tool (API mode): a key that may not read templates gets a clear explanation, not the key', a3.code === 2 && /HTTP 401/.test(a3.out) && /full-access key/.test(a3.out) && !a3.out.includes(FAKE_KEY));
    answer = { status: 404, body: { name: 'not_found' } };
    const a4 = await runTool([], { RESEND_API_KEY: FAKE_KEY, RESEND_API_BASE: base });
    ok('tool (API mode): a missing template is reported as HTTP 404', a4.code === 2 && /HTTP 404/.test(a4.out) && !a4.out.includes(FAKE_KEY));
    const requestsBefore = seen.length;
    const a5 = await runTool(['bad id/../x'], { RESEND_API_KEY: FAKE_KEY, RESEND_API_BASE: base });
    ok('tool (API mode): an odd template id is refused before any request is made', a5.code === 2 && seen.length === requestsBefore, `${a5.code} ${seen.length} vs ${requestsBefore}`);
    await new Promise((r) => server.close(r));
    const src2 = fs.readFileSync(TOOL, 'utf8');
    ok('tool: it only ever issues a GET, never POSTs an email, and never writes the key to disk', !/method:\s*["']POST/.test(src2) && !/writeFileSync/.test(src2));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
