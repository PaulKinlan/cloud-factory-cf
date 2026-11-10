import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
/**
 * Two follow-ups from the review of this delta, both about the probe bookkeeping.
 *
 * fjpb: the marker was written only AFTER the awaited export+merge, so two concurrent
 * requests for the same spelling could both decide to probe, both merge, and - because
 * mergeLegacyConnectRow SUMS pings - count the legacy evidence twice.
 *
 * 973u: nothing short-circuited once the repository was sealed, so every delivery to an
 * already-migrated repository still ran the per-candidate SELECTs and rewrote
 * legacy_read_through with a fresh migrated_at.
 */
describe("RepoCoordinator legacy probe bookkeeping", () => {
  const CONTROL_KEY = "test-control-key";

  async function seedLegacyPings(legacyRepo: string, pings: number): Promise<void> {
    const legacyStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(legacyRepo));
    await runInDurableObject(legacyStub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO webhook_connect (id, last_ping_at, last_event_at, last_event, pings, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "default",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "push",
        pings,
        "2026-01-01T00:00:00Z",
      );
    });
  }

  async function canonicalPings(prefixedStub: DurableObjectStub): Promise<number> {
    const res = await prefixedStub.fetch("https://repo-coordinator.internal/connect");
    const body = (await res.json()) as { connect?: { pings?: number } };
    return Number(body.connect?.pings ?? 0);
  }

  it("does not probe a spelling another request has already claimed", async () => {
    const legacyRepo = "lease-org/lease-repo";
    const prefixedRepo = `github:${legacyRepo}`;
    await seedLegacyPings(legacyRepo, 3);

    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));

    // A claim written a moment ago: another request is (or was, recently) probing.
    await runInDurableObject(prefixedStub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO _schema_migrations (name, migrated_at) VALUES (?, ?)",
        `legacy_claim:${legacyRepo}`,
        Date.now(),
      );
    });

    await prefixedStub.fetch("https://repo-coordinator.internal/stats");

    expect(await canonicalPings(prefixedStub)).toBe(0);
    await runInDurableObject(prefixedStub, (_instance, state) => {
      const probed = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM _schema_migrations WHERE name = ?", `legacy_probed:${legacyRepo}`)
        .toArray();
      expect(probed).toHaveLength(0);
    });

    // An expired lease is taken over rather than stranding the candidate forever.
    await runInDurableObject(prefixedStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE _schema_migrations SET migrated_at = ? WHERE name = ?",
        Date.now() - 10 * 60 * 1000,
        `legacy_claim:${legacyRepo}`,
      );
    });

    await prefixedStub.fetch("https://repo-coordinator.internal/stats");

    expect(await canonicalPings(prefixedStub)).toBe(3);
    await runInDurableObject(prefixedStub, (_instance, state) => {
      const probed = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM _schema_migrations WHERE name = ?", `legacy_probed:${legacyRepo}`)
        .toArray();
      expect(probed).toHaveLength(1);
      // The lease is released once the probe completes.
      const claim = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM _schema_migrations WHERE name = ?", `legacy_claim:${legacyRepo}`)
        .toArray();
      expect(claim).toHaveLength(0);
    });
  });

  it("does not touch the database once the repository is sealed", async () => {
    const legacyRepo = "sealed-org/sealed-repo";
    const prefixedRepo = `github:${legacyRepo}`;
    await seedLegacyPings(legacyRepo, 2);

    const prefixedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(prefixedRepo));

    // First request migrates and seals.
    await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    expect(await canonicalPings(prefixedStub)).toBe(2);

    const sealedAt = async (): Promise<number> =>
      runInDurableObject(prefixedStub, (_instance, state) => {
        const rows = state.storage.sql
          .exec<{ migrated_at: number }>("SELECT migrated_at FROM _schema_migrations WHERE name = 'legacy_read_through'")
          .toArray();
        expect(rows).toHaveLength(1);
        return Number(rows[0]!.migrated_at);
      });

    const before = await sealedAt();
    // Enough wall clock that a rewritten row would carry a different timestamp.
    await new Promise((resolve) => setTimeout(resolve, 15));
    for (let i = 0; i < 3; i += 1) {
      await prefixedStub.fetch("https://repo-coordinator.internal/stats");
    }
    const after = await sealedAt();

    expect(after).toBe(before);
    // And the seal was not rewritten with a new outcome: pings are still 2, not 4 or 6.
    expect(await canonicalPings(prefixedStub)).toBe(2);
  });
});
