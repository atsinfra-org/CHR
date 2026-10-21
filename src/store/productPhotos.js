import { breechesInfo } from "./breeches";

/**
 * The photograph for each product, shared by the store cards and the cart so
 * the same item always shows the same picture. Files live in
 * /public/assests/{membership,tack}/ — swap a file to change a photo, and
 * tune `focus` (CSS object-position) if the crop needs moving.
 */
export const PLAN_PHOTOS = {
  ONE_TIME_RIDE: { image: "/assests/membership/one-time.jpg", focus: "70% 30%" },
  GOLD: { image: "/assests/membership/gold.jpg", focus: "50% 25%" },
  PLATINUM: { image: "/assests/membership/platinum.jpg", focus: "62% 30%" },
};

export const TACK_PHOTOS = {
  TACK_HELMET: { image: "/assests/tack/helmet.jpeg", focus: "50% 50%" },
  TACK_CHAPS: { image: "/assests/tack/chaps.webp", focus: "50% 50%" },
  TACK_HALF_BOOTS: { image: "/assests/tack/half-boots.jpg", focus: "75% 60%" },
  TACK_FULL_BOOTS: { image: "/assests/tack/full-boots-web.jpg", focus: "50% 50%" },
};

/** `{ image, focus }` for a catalog product, or null when it has no photo. */
export function photoFor(product) {
  // Photos managed in Admin -> Tack Shop win; the built-in ones below are the fallback.
  const managed = Array.isArray(product?.images) ? product.images.find((i) => i && typeof i.url === "string") : null;
  if (managed) return { image: managed.url, focus: "50% 40%" };
  const breeches = breechesInfo(product?.sku);
  if (breeches) return { image: breeches.images[0], focus: "50% 40%" };
  return PLAN_PHOTOS[product?.plan_code] ?? TACK_PHOTOS[product?.sku] ?? null;
}
