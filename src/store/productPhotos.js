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
  TACK_BREECHES: { image: "/assests/tack/breeches.jpg", focus: "50% 55%" },
  TACK_HELMET: { image: "/assests/tack/helmet.jpg", focus: "12% 30%" },
  TACK_CHAPS: { image: "/assests/tack/chaps.jpg", focus: "50% 60%" },
  TACK_HALF_BOOTS: { image: "/assests/tack/half-boots.jpg", focus: "75% 60%" },
  TACK_FULL_BOOTS: { image: "/assests/tack/full-boots.jpg", focus: "38% 55%" },
};

/** `{ image, focus }` for a catalog product, or null when it has no photo. */
export function photoFor(product) {
  return PLAN_PHOTOS[product?.plan_code] ?? TACK_PHOTOS[product?.sku] ?? null;
}
