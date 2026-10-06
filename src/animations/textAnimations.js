/**
 * Splits text into lines/words for staggered reveal animations.
 * Lightweight alternative to SplitType — sufficient for headline-scale reveals.
 */
export function splitIntoWords(text) {
  return text.split(" ").filter(Boolean);
}

export function splitIntoLines(lines) {
  return Array.isArray(lines) ? lines : [lines];
}
