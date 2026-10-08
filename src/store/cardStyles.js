// Shared by the membership and tack cards: fade a photo into the card on its
// left and bottom edges so nothing hard-edged sits behind the text.
export const PHOTO_MASK = {
  WebkitMaskImage: "linear-gradient(to right, transparent 0%, #000 38%), linear-gradient(to bottom, #000 78%, transparent 100%)",
  maskImage: "linear-gradient(to right, transparent 0%, #000 38%), linear-gradient(to bottom, #000 78%, transparent 100%)",
  WebkitMaskComposite: "source-in",
  maskComposite: "intersect",
};
