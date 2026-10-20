// account-erasure handler tests with a fake Supabase client (no network, no Deno, no TypeScript package).
// Run from the website repo root:   node supabase/tests/account-erasure-function.test.cjs
const path = require('path');
const fs = require('fs');
const { stripTypeScriptTypes } = require('node:module');

// Loads a .ts file: Node strips the types, then a small shim turns the file's ES imports and exports into
// CommonJS so the modules it imports can be replaced with fakes.
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
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : e); };

const FN = path.join(__dirname, '..', 'functions', 'account-erasure') + path.sep;
const logic = compile(FN + 'logic.ts');
const U = 'b85dee9e-1b66-4679-bdef-f7f9debe5cb8', R = '0c1d5f0e-2b7a-4f0e-9a51-3c7f2e9d1a44';

ok('uuid check', logic.isUuid(U) && !logic.isUuid('x') && !logic.isUuid(null) && !logic.isUuid('../1'));
ok('the identity-check code passes through', logic.cleanError({ message: 'IDENTITY_NOT_VERIFIED', details: 'Confirm first' }).error === 'IDENTITY_NOT_VERIFIED');
ok('the placeholder email is a never-deliverable address with the id only', logic.erasedEmail(U) === 'erased-' + U + '@erased.invalid' && logic.erasedEmail(U).endsWith('.invalid'));
ok('known database code passes through with its detail', JSON.stringify(logic.cleanError({ message: 'ERASURE_BLOCKED', details: 'active_membership' })) === JSON.stringify({ error: 'ERASURE_BLOCKED', message: 'active_membership' }));
ok('raw database text is never shown', logic.cleanError({ message: 'duplicate key value violates unique constraint "x" (a@b.c)' }).error === 'ERASURE_FAILED' && !JSON.stringify(logic.cleanError({ message: 'secret@x.y' })).includes('secret'));

const calls = [];
const state = { isAdmin: true, execute: { data: { user_id: U }, error: null }, finish: { data: { completed: true }, error: null }, deleteError: null, scrubError: null, dbLoginDisabled: false };
const makeClient = (key) => ({
  rpc: async (fn, args) => {
    calls.push(['rpc:' + key, fn, args]);
    if (fn === 'is_admin') return { data: state.isAdmin, error: null };
    if (fn === 'admin_execute_erasure') return state.execute;
    if (fn === 'admin_finish_erasure') return state.finish === 'db' ? { data: state.dbLoginDisabled ? { completed: true } : { completed: false, reason: 'login_not_disabled' }, error: null } : state.finish;
    return { data: null, error: { message: 'unexpected' } };
  },
  auth: { admin: {
    updateUserById: async (id, attrs) => { calls.push(['updateUserById', id, attrs]); return { error: state.scrubError }; },
    deleteUser: async (id, soft) => { calls.push(['deleteUser', id, soft]); if (!state.deleteError) state.dbLoginDisabled = true; return { error: state.deleteError }; },
  } },
});
let handler;
global.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => ({ SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' })[k] } };
compile(FN + 'index.ts', { 'jsr:@supabase/supabase-js@2': { createClient: (url, key) => makeClient(key === 'svc' ? 'service' : 'caller') }, './logic.ts': logic });
const call = (body, headers = { Authorization: 'Bearer t' }, method = 'POST') =>
  handler(new Request('http://x', { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined })).then(async (r) => ({ status: r.status, json: await r.json() }));

(async () => {
  const quiet = console.error; console.error = () => {};
  ok('GET refused', (await call(null, {}, 'GET')).status === 405);
  ok('no sign-in refused', (await call({ request_id: R }, {})).status === 401);
  ok('bad json refused', (await call('{nope')).status === 400);
  ok('bad id refused', (await call({ request_id: 'x' })).status === 400);
  calls.length = 0; state.isAdmin = false;
  let r = await call({ request_id: R });
  ok('a non-admin is refused before anything runs', r.status === 403 && !calls.some((c) => c[1] === 'admin_execute_erasure' || c[0] === 'deleteUser'));

  state.isAdmin = true; calls.length = 0; state.finish = 'db'; state.dbLoginDisabled = false;
  r = await call({ request_id: R });
  ok('happy path: database step, scrub, soft delete, then finish', r.status === 200 && r.json.completed === true
    && calls.map((c) => (c[0] === 'deleteUser' || c[0] === 'updateUserById' ? c[0] : c[1])).join(',') === 'is_admin,admin_execute_erasure,updateUserById,deleteUser,admin_finish_erasure');
  ok('the login is soft-deleted (never a hard delete)', calls.find((c) => c[0] === 'deleteUser')[2] === true);
  ok('the service-role client is used only for the login step', calls.filter((c) => c[0] === 'rpc:service').length === 0);
  ok('finish reports the login as disabled', calls.find((c) => c[1] === 'admin_finish_erasure')[2].p_login_disabled === true);
  const scrub = calls.find((c) => c[0] === 'updateUserById');
  ok('the sign-in email is replaced by a placeholder that names no one', scrub[1] === U && scrub[2].email === 'erased-' + U + '@erased.invalid' && scrub[2].email_confirm === true);
  ok('the sign-in profile metadata is cleared and the login is banned', JSON.stringify(scrub[2].user_metadata) === '{}' && /^[0-9]+h$/.test(scrub[2].ban_duration) && parseInt(scrub[2].ban_duration) >= 24 * 365);
  ok('the scrub touches only the erased member, and sends no password or token', Object.keys(scrub[2]).sort().join(',') === 'ban_duration,email,email_confirm,user_metadata');

  state.execute = { data: null, error: { message: 'ERASURE_BLOCKED', details: 'active_membership' } }; calls.length = 0;
  r = await call({ request_id: R });
  ok('a database guard stops everything: 409, no login change', r.status === 409 && r.json.error === 'ERASURE_BLOCKED' && !calls.some((c) => c[0] === 'deleteUser'));
  state.execute = { data: null, error: { message: 'ERASURE_DISABLED', details: 'off' } };
  ok('the off switch is honoured', (await call({ request_id: R })).json.error === 'ERASURE_DISABLED');
  state.execute = { data: { user_id: 'not-a-uuid' }, error: null }; calls.length = 0;
  ok('an unreadable database reply is not trusted', (await call({ request_id: R })).status === 500 && !calls.some((c) => c[0] === 'deleteUser'));

  state.execute = { data: { user_id: U }, error: null }; state.deleteError = { status: 500, code: 'x' }; state.dbLoginDisabled = false; calls.length = 0;
  r = await call({ request_id: R });
  ok('login step failure: 502, NOT reported as completed, failure recorded', r.status === 502 && r.json.completed === false
    && calls.find((c) => c[1] === 'admin_finish_erasure')[2].p_login_disabled === false);
  // The scrub fails: nothing else is attempted, and the request is NOT reported finished.
  state.deleteError = null; state.scrubError = { status: 500, code: 'x' }; state.dbLoginDisabled = false; calls.length = 0;
  r = await call({ request_id: R });
  ok('a failed scrub stops before the soft delete and is not reported as completed', r.status === 502 && r.json.completed === false
    && !calls.some((c) => c[0] === 'deleteUser') && calls.some((c) => c[1] === 'admin_finish_erasure'));
  // A caller-side "ok" is never enough: the database says the login is still enabled.
  state.scrubError = null; state.finish = { data: { completed: false, reason: 'login_not_disabled' }, error: null }; calls.length = 0;
  r = await call({ request_id: R });
  ok('success needs the database to confirm the login is disabled', r.status === 502 && r.json.completed === false);
  // A retry when the login was already disabled by an earlier run: the delete call may error, the database decides.
  state.finish = 'db'; state.deleteError = { status: 404, code: 'user_not_found' }; state.dbLoginDisabled = true; calls.length = 0;
  r = await call({ request_id: R });
  ok('a retry after a half-finished run completes when the database sees the login disabled', r.status === 200 && r.json.completed === true);
  state.deleteError = null; state.finish = { data: { completed: true }, error: null }; calls.length = 0;
  r = await call({ request_id: R });
  ok('a retry after that failure completes', r.status === 200 && r.json.completed === true);
  state.finish = { data: null, error: { message: 'weird db text with a@b.c' } };
  r = await call({ request_id: R });
  ok('a finish failure does not leak database text', r.status === 500 && !JSON.stringify(r.json).includes('a@b.c'));
  console.error = quiet;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
