import { describe, expect, it } from "vitest";
import { collectionNote, ledgerTypeLabel, orderNumber, orderStatusLabel, paymentSummary } from "./labels";

describe("labels", () => {
  it("ledger types are human readable, unknown ones fall back to title case", () => {
    expect(ledgerTypeLabel("absence_restore")).toBe("Absence Credit Restored");
    expect(ledgerTypeLabel("reschedule")).toBe("Reschedule");
    expect(ledgerTypeLabel("something_new")).toBe("Something New");
  });

  it("pending orders read as awaiting payment, never as paid", () => {
    expect(orderStatusLabel("pending")).toBe("Awaiting Payment Confirmation");
    expect(paymentSummary({ status: "pending" }, { status: "created", gateway: "razorpay" }).label).toBe("Awaiting confirmation");
  });

  it("only a successful payment row is reported as paid, with its method", () => {
    expect(paymentSummary({ status: "paid" }, [{ status: "success", gateway: "manual" }])).toEqual({ label: "Paid", method: "Manual (paid at the club)" });
    expect(paymentSummary({ status: "paid" }, { status: "success", gateway: "razorpay" }).method).toBe("Razorpay");
  });

  it("collection notes follow the order state and skip non in-store orders", () => {
    expect(collectionNote({ has_in_store: false, status: "paid" })).toBeNull();
    expect(collectionNote({ has_in_store: true, status: "ready_for_collection" })).toMatch(/Ready for Collection/);
    expect(collectionNote({ has_in_store: true, status: "pending" })).toMatch(/after payment/);
  });

  it("order numbers are stable and short", () => {
    expect(orderNumber("0a1b2c3d-1111-2222-3333-444455556666")).toBe("CSF-0A1B2C3D");
  });
});
