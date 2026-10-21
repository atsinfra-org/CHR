import { describe, expect, it } from "vitest";
import { availableTackTypes, isTackType, ofTackType, TACK_TYPES, tackTypeOf } from "./tackTypes";
import { BREECHES } from "./breeches";

const tack = [
  { sku: "TACK_HELMET" }, { sku: "TACK_BREECHES" }, { sku: "TACK_CHAPS" }, { sku: "TACK_HALF_BOOTS" }, { sku: "TACK_FULL_BOOTS" },
  ...BREECHES.map((b) => ({ sku: b.sku })), { sku: "TACK_SADDLE_PAD" },
];

describe("choosing what to buy on the Tack tab", () => {
  it("offers All, then Helmets, Breeches, Chaps, Half Boots, Full Boots in that order", () => {
    expect(TACK_TYPES.map((t) => t.label)).toEqual(["All", "Helmets", "Breeches", "Chaps", "Half Boots", "Full Boots"]);
  });
  it("each choice shows only its own products", () => {
    expect(ofTackType(tack, "helmet")).toEqual([{ sku: "TACK_HELMET" }]);
    expect(ofTackType(tack, "chaps")).toEqual([{ sku: "TACK_CHAPS" }]);
    expect(ofTackType(tack, "half-boots")).toEqual([{ sku: "TACK_HALF_BOOTS" }]);
    expect(ofTackType(tack, "full-boots")).toEqual([{ sku: "TACK_FULL_BOOTS" }]);
    expect(ofTackType(tack, "breeches").map((p) => p.sku)).toEqual(BREECHES.map((b) => b.sku));
    expect(ofTackType(tack, "all")).toHaveLength(tack.length);
  });
  it("half and full boots never mix, and an untyped product shows only under All", () => {
    expect(tackTypeOf({ sku: "TACK_HALF_BOOTS" })).toBe("half-boots");
    expect(tackTypeOf({ sku: "TACK_FULL_BOOTS" })).toBe("full-boots");
    expect(tackTypeOf({ sku: "TACK_SADDLE_PAD" })).toBeNull();
  });
  it("a type with no products gets no button", () => {
    expect(availableTackTypes([{ sku: "TACK_HELMET" }]).map((t) => t.key)).toEqual(["all", "helmet"]);
    expect(availableTackTypes(tack)).toHaveLength(6);
  });
  it("only known types are accepted from the address bar", () => {
    expect(isTackType("chaps")).toBe(true);
    expect(isTackType("<script>")).toBe(false);
  });
});
