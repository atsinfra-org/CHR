// Account erasure, step 2 of 2: disables the member's login after the database step has anonymised the
// profile (0031_account_erasure.sql). NOT DEPLOYED by the change that added it.
//
// WHO CAN CALL IT: only a signed-in ADMIN. Deploy WITH gateway JWT verification (the default; do not pass
// --no-verify-jwt). The function then re-checks is_admin() as that caller, and every database guard
// (switch, waiting period, blockers, in-progress review) is enforced inside admin_execute_erasure() itself —
// this function adds no way around them.
//
// WHAT IT DOES, in order:
//   1. admin_execute_erasure(request)   as the admin: anonymises the profile; safe to repeat.
//   2. auth.admin.updateUserById(id)   as the service role: replaces the sign-in email with a placeholder that
//                                       names no one, clears the sign-in profile metadata (name, picture) and bans
//                                       the login. If this fails the function stops and reports failure.
//   3. auth.admin.deleteUser(id, true)  as the service role: a SOFT delete — the sign-in is disabled but the
//                                       auth row stays, so no cascade can reach memberships or ledgers
//                                       (a hard delete would; see the 0031 header).
//   4. admin_finish_erasure(request, ok) as the admin: closes the request ONLY when the DATABASE shows the login
//                                       is disabled (0032 reads auth.users itself; the boolean sent here is only
//                                       advice). Otherwise it records the failure and leaves the request open.
//
// It never reports success unless the login was actually disabled, and it never prints identities:
// the only things logged are error codes.
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. None is
// returned to the caller or written to a log. No new secret is needed.
//
// VERIFY BEFORE RELYING ON IT (IMPLEMENTED_NOT_FULLY_VERIFIED), using a TEST account, never a real member:
//   (a) the ban and soft delete block sign-in AND password reset for that account;
//   (b) after step 2 the auth record holds no real email or name (auth.users.email, raw_user_meta_data) and the
//       linked sign-in identities (auth.identities.identity_data, e.g. a Google profile) hold none either.
//       Step 2 clears the first two; whether Supabase keeps copies in auth.identities after a soft delete is NOT
//       confirmed here. See docs/privacy/ERASURE_VERIFICATION.md.
import { createClient } from "jsr:@supabase/supabase-js@2";

import { cleanError, erasedEmail, isUuid, json, LOGIN_BAN_DURATION } from "./logic.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "not signed in" });

  let body: { request_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (!isUuid(body.request_id)) return json(400, { error: "request_id must be a uuid" });
  const requestId = body.request_id;

  const url = Deno.env.get("SUPABASE_URL")!;
  // Acts as the CALLER: row-level security and every admin check apply to them.
  const asAdmin = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const who = await asAdmin.rpc("is_admin");
  if (who.error || who.data !== true) return json(403, { error: "NOT_AUTHORIZED" });

  // 1. Database step (idempotent; enforces every guard).
  const step = await asAdmin.rpc("admin_execute_erasure", { p_request_id: requestId });
  if (step.error) return json(409, cleanError(step.error));
  const userId = (step.data as { user_id?: unknown } | null)?.user_id;
  if (!isUuid(userId)) return json(500, { error: "unexpected reply from the database step" });

  // 2. Scrub what identifies the person in the sign-in record, and ban the login.
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const scrubbed = await service.auth.admin.updateUserById(userId, {
    email: erasedEmail(userId),
    email_confirm: true,
    user_metadata: {},
    ban_duration: LOGIN_BAN_DURATION,
  });
  if (scrubbed.error) console.error("account-erasure: scrub step failed", scrubbed.error.status ?? "", scrubbed.error.code ?? "");

  // 3. Disable the login (soft delete; keeps the row so no cascade can run). Not attempted if the scrub failed:
  //    a login that is gone but still carries the person's email would look finished and not be.
  let loginDisabled = false;
  if (!scrubbed.error) {
    const disabled = await service.auth.admin.deleteUser(userId, true);
    loginDisabled = !disabled.error;
    if (disabled.error) console.error("account-erasure: login step failed", disabled.error.status ?? "", disabled.error.code ?? "");
  }

  // 4. Close the request only if the login really was disabled (the database checks the auth row itself).
  const finish = await asAdmin.rpc("admin_finish_erasure", { p_request_id: requestId, p_login_disabled: loginDisabled });
  if (finish.error) return json(500, cleanError(finish.error));

  // The database's answer decides, not this function's own flag: on a retry the login may already be disabled
  // (a second delete call can error) and the request can then be closed; and a flag that says "ok" is never
  // enough if the database does not see the login disabled.
  const completed = (finish.data as { completed?: unknown } | null)?.completed === true;
  if (!completed) {
    return json(502, { completed: false, error: "LOGIN_STEP_FAILED", message: "The account details were removed but the sign-in could not be disabled. Run this step again." });
  }
  return json(200, { completed: true });
});
