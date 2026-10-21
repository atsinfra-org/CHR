import { supabase } from "../../lib/supabaseClient";

/**
 * Shop photo uploads (Admin -> Tack Shop). Files go to the public "tack-images" bucket in Supabase Storage; the bucket
 * rules (migration 0039) let only administrators upload, replace or remove, accept only JPEG, PNG and WebP, and cap a
 * file at 5 MB, so these checks in the browser are a convenience, not the protection.
 *
 * The file type is read from the file's first bytes, never trusted from its name or the browser's guess.
 * Removing a photo from a product does not delete the file: old orders and pages that showed it keep working.
 */
export const BUCKET = "tack-images";
export const MAX_BYTES = 5 * 1024 * 1024;
export const ACCEPT = "image/jpeg,image/png,image/webp";

/** "jpg" | "png" | "webp" from the file's signature, or null. */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Checks a picked file. Returns { ok, type } or { ok: false, error } with a message for the administrator. */
export async function checkImageFile(file) {
  if (!file) return { ok: false, error: "No file chosen." };
  if (file.size > MAX_BYTES) return { ok: false, error: `${file.name} is larger than 5 MB. Please use a smaller photo.` };
  if (file.size < 100) return { ok: false, error: `${file.name} is empty or damaged.` };
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = sniffImageType(head);
  if (!type) return { ok: false, error: `${file.name} is not a JPEG, PNG or WebP photo.` };
  return { ok: true, type };
}

const slug = (s) => String(s || "product").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "product";

/** Uploads one photo and returns its public URL. Each upload gets a new name, so nothing is ever overwritten. */
export async function uploadProductImage(file, sku, client = supabase) {
  const check = await checkImageFile(file);
  if (!check.ok) return { error: check.error };
  const rand = Math.random().toString(36).slice(2, 10);
  const path = `products/${slug(sku)}/${Date.now()}-${rand}.${check.type}`;
  const { error } = await client.storage.from(BUCKET).upload(path, file, { contentType: MIME[check.type], cacheControl: "31536000", upsert: false });
  if (error) {
    const msg = /row-level security|not authorized|Unauthorized|403/i.test(error.message ?? "") ? "Only administrators can upload shop photos." : "The photo could not be uploaded. Please try again.";
    return { error: msg };
  }
  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl };
}
