#!/usr/bin/env node
// Reads the published Resend template and says whether email-send can use it. READ-ONLY: it sends no email.
//
//   RESEND_API_KEY=<key> node supabase/tools/inspect-resend-template.cjs [template-id-or-alias]
//   RESEND_API_KEY=<key> node supabase/tools/inspect-resend-template.cjs --welcome <welcome template id>   the Welcome Email (variables: name, dashboard_url)
//   node supabase/tools/inspect-resend-template.cjs --file template.json        a saved copy of the API response
//   node supabase/tools/inspect-resend-template.cjs --html template.html [--variables A,B]   HTML only
//
// It calls GET https://api.resend.com/templates/{id}. A sending-only API key may be refused by that endpoint
// (Resend does not say); if so, create a temporary full-access key, run this, and delete the key. The key is read
// from the environment, is never printed, and is never written to a file.
//
// Exit code: 0 = ready, 1 = the template cannot be used yet (reasons are printed), 2 = could not read it.
const fs = require("fs");
const path = require("path");
const { stripTypeScriptTypes } = require("node:module");

// Loads the TypeScript adapter without a build step (the same shim the tests use).
const compile = (file, stubs = {}) => {
  let code = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
  const names = [];
  code = code
    .replace(/import \{([\s\S]*?)\} from (['"])(.+?)\2;?/g, (_, list, __, mod) => `const {${list.replace(/\bas\b/g, ":")}} = require(${JSON.stringify(mod)});`)
    .replace(/export (async )?function (\w+)/g, (_, a, n) => (names.push(n), `${a || ""}function ${n}`))
    .replace(/export const (\w+)/g, (_, n) => (names.push(n), `const ${n}`));
  code += "\n" + names.map((n) => `exports.${n} = ${n};`).join("\n");
  const exp = {};
  new Function("require", "exports", "module", code)((id) => (id in stubs ? stubs[id] : require(id)), exp, { exports: exp });
  return exp;
};

const FN = path.join(__dirname, "..", "functions", "email-send") + path.sep;
const templates = compile(FN + "templates.ts");
const adapter = compile(FN + "resend-template.ts", { "./templates.ts": templates });

const args = process.argv.slice(2);
const welcome = args.includes("--welcome");
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg, code = 2) => { process.stderr.write(msg + "\n"); process.exit(code); };

async function load() {
  if (flag("--file")) return JSON.parse(fs.readFileSync(flag("--file"), "utf8"));
  if (flag("--html")) {
    const vars = (flag("--variables") || "").split(",").map((s) => s.trim()).filter(Boolean);
    return { status: "published", html: fs.readFileSync(flag("--html"), "utf8"), variables: vars.map((key) => ({ key })) };
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) die("Set RESEND_API_KEY, or use --file <saved response.json> or --html <template.html>. Nothing was sent.");
  const id = args.find((a) => !a.startsWith("--") && !(flag("--file") === a) && !(flag("--html") === a) && !(flag("--variables") === a)) || (welcome ? "" : adapter.DEFAULT_MEMBERSHIP_TEMPLATE_ID);
  if (!id) die("Give the welcome template id, for example: --welcome <template id>.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) die("That template id or alias does not look right.");
  const base = process.env.RESEND_API_BASE || "https://api.resend.com";   // overridable only so the tests can use a local fake
  let res;
  try {
    res = await fetch(`${base}/templates/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    die("Could not reach Resend.");
  }
  if (!res.ok) {
    let name = "";
    try { name = (await res.json())?.name || ""; } catch { /* ignore */ }
    die(`Resend answered HTTP ${res.status}${name ? " (" + String(name).replace(/[^a-z_]/g, "") + ")" : ""}. ` +
      (res.status === 401 || res.status === 403 ? "This key may not be allowed to read templates: use a temporary full-access key, then delete it. " : "") + "Nothing was sent.");
  }
  return res.json();
}

(async () => {
  const t = await load();
  const a = adapter.analyseTemplate(t, welcome ? "welcome" : "membership");
  const out = (s = "") => process.stdout.write(s + "\n");
  out(`Template: ${t?.name ?? "(unnamed)"}   alias: ${t?.alias ?? "-"}   status: ${t?.status ?? "-"}`);
  out(`Registered variables (${a.registered.length}): ${a.registered.join(", ") || "none"}`);
  out(`{{{TRIPLE}}} placeholders in the body: ${a.triplePlaceholders.join(", ") || "none"}`);
  out(`Plain-text {{double}} placeholders in the body: ${a.literalDoublePlaceholders.join(", ") || "none"}`);
  out(`Variables email-send can supply: ${(welcome ? adapter.WELCOME_VARIABLE_KEYS : adapter.SUPPORTED_VARIABLE_KEYS).join(", ")}`);
  out();
  if (a.verdict === "ready" && welcome) {
    out("READY. The welcome email sends exactly name and dashboard_url. Set RESEND_WELCOME_TEMPLATE_ID, then EMAIL_WELCOME_TEMPLATE_ENABLED=true (last, after the test in docs/TRANSACTIONAL_EMAIL.md).");
    process.exit(0);
  }
  if (a.verdict === "ready") {
    out("READY. To use it, set these function secrets (and nothing is sent until you do):");
    out(`  EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES=${a.suggestedDeclared}`);
    out("  EMAIL_MEMBERSHIP_TEMPLATE_ENABLED=true   (last, after the test in docs/TRANSACTIONAL_EMAIL.md)");
    process.exit(0);
  }
  out("NOT READY:");
  for (const p of a.problems) out("  - " + p);
  process.exit(1);
})().catch((e) => die("Could not analyse the template: " + (e instanceof Error ? e.message.replace(/Bearer\s+\S+/g, "Bearer <hidden>") : "unknown error")));
