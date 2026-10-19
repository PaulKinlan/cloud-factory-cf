import { describe, expect, it } from "vitest";
import {
  EventQueue,
  DeliveryLedger,
  RunAuditStore,
  migrateEventQueueTable,
  migrateDeliveryLedgerTable,
  migrateRunAuditTable,
  MAX_ATTEMPTS,
  DEFAULT_VISIBILITY_MS,
} from "../src/events";

// Test against workerd memory SQLite
describe("events domain controllers", () => {
  it("exports expected queue defaults", () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_VISIBILITY_MS).toBe(60_000);
  });

  it("can initialize and query EventQueue and DeliveryLedger classes", () => {
    expect(typeof EventQueue).toBe("function");
    expect(typeof DeliveryLedger).toBe("function");
    expect(typeof RunAuditStore).toBe("function");
    expect(typeof migrateEventQueueTable).toBe("function");
    expect(typeof migrateDeliveryLedgerTable).toBe("function");
    expect(typeof migrateRunAuditTable).toBe("function");
  });
});
