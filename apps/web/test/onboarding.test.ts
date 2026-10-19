import { describe, expect, it } from "vitest";
// The header control and the dialog are part of the contract, so assert on the markup.
import indexHtml from "../index.html?raw";
import {
  STALE_AFTER_MS,
  ageLabel,
  connectSummary,
  installUrl,
  parseRepository,
  pillLabel,
  webhookUrl,
  type ConnectEvidence,
} from "../src/onboarding";

/**
 * GitHub onboarding gate (cloud-factory-cf-7gq.2): the decisions behind the header
 * pill and the Connect GitHub dialog, tested without a DOM or a network.
 */

function evidence(overrides: Partial<ConnectEvidence> = {}): ConnectEvidence {
  return {
    repository: "acme/widget",
    lastPingAt: null,
    lastEventAt: null,
    lastEvent: null,
    pings: 0,
    ...overrides,
  };
}

const NOW = Date.parse("2026-10-19T16:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

describe("webhook url", () => {
  it("points GitHub at the repository's own webhook route", () => {
    expect(webhookUrl("https://factory.example", "acme", "widget")).toBe(
      "https://factory.example/webhooks/github/acme/widget",
    );
    // A trailing slash on the origin must not produce a double slash.
    expect(webhookUrl("https://factory.example/", "acme", "widget")).toBe(
      "https://factory.example/webhooks/github/acme/widget",
    );
  });

  it("encodes a scope that is unusual but still valid", () => {
    expect(webhookUrl("https://factory.example", "acme corp", "w/g")).toBe(
      "https://factory.example/webhooks/github/acme%20corp/w%2Fg",
    );
  });
});

describe("install link", () => {
  it("builds the App install URL and carries the scope as state", () => {
    expect(installUrl("cloud-factory", "acme/widget")).toBe(
      "https://github.com/apps/cloud-factory/installations/new?state=acme%2Fwidget",
    );
    expect(installUrl("/cloud-factory/", "acme/widget")).toContain("/apps/cloud-factory/installations/new");
  });
});

describe("scope parsing", () => {
  it("accepts owner/repo and refuses anything else", () => {
    expect(parseRepository("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
    expect(parseRepository("  acme/widget  ")).toEqual({ owner: "acme", repo: "widget" });
    expect(parseRepository("acme/widget/extra")).toBeNull();
    expect(parseRepository("acme")).toBeNull();
    expect(parseRepository("")).toBeNull();
    expect(parseRepository("acme/wid get")).toBeNull();
  });

  it("labels the pill with the scope, or says there is none", () => {
    expect(pillLabel({ owner: "acme", repo: "widget" })).toBe("acme/widget");
    expect(pillLabel(null)).toBe("No repository");
  });
});

describe("connection summary", () => {
  it("never turns silence into a green light", () => {
    expect(connectSummary(null, NOW)).toEqual({ label: "Not checked yet", tone: "muted" });
    expect(connectSummary(evidence(), NOW)).toEqual({ label: "Waiting for GitHub's ping", tone: "warn" });
  });

  it("calls it connected only once the ping has arrived", () => {
    expect(connectSummary(evidence({ lastPingAt: iso(0), lastEventAt: iso(0), pings: 1 }), NOW)).toEqual({
      label: "Connected · ping just now",
      tone: "ok",
    });
    expect(connectSummary(evidence({ lastPingAt: iso(5 * 60_000), pings: 1 }), NOW)).toEqual({
      label: "Connected · ping 5m ago",
      tone: "ok",
    });
  });

  it("warns when events arrive but the handshake never did", () => {
    expect(connectSummary(evidence({ lastEventAt: iso(60_000), lastEvent: "push" }), NOW)).toEqual({
      label: "Receiving events · no ping yet (1m ago)",
      tone: "warn",
    });
  });

  it("does not call a day-old ping healthy", () => {
    const stale = connectSummary(evidence({ lastPingAt: iso(STALE_AFTER_MS + 60_000), pings: 1 }), NOW);
    expect(stale.tone).toBe("warn");
    expect(stale.label).toContain("check the hook");
  });

  it("formats ages without drifting", () => {
    expect(ageLabel(NOW, null)).toBe("never");
    expect(ageLabel(NOW, iso(30_000))).toBe("just now");
    expect(ageLabel(NOW, iso(5 * 60_000))).toBe("5m ago");
    expect(ageLabel(NOW, iso(3 * 3_600_000))).toBe("3h ago");
    expect(ageLabel(NOW, iso(2 * 86_400_000))).toBe("2d ago");
    // An unparseable timestamp is shown, not turned into "never".
    expect(ageLabel(NOW, "not a date")).toBe("not a date");
  });
});

describe("markup contract", () => {
  it("puts a real dialog behind the header pill", () => {
    const pill = /<button[^>]*id="repo-pill"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(pill).not.toBe("");
    expect(pill).toContain('aria-haspopup="dialog"');
    expect(pill).toContain('aria-controls="connect-dialog"');
    expect(indexHtml).toContain('<dialog id="connect-dialog"');
    // Native modal behaviour (focus trapping, Escape) comes from <dialog>.
    expect(indexHtml).toMatch(/<dialog[^>]*id="connect-dialog"/);
  });

  it("shows the webhook URL read-only and keeps the key out of the DOM's value", () => {
    const url = /<input[^>]*id="connect-url"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(url).toContain("readonly");
    const key = /<input[^>]*id="connect-key"[^>]*>/.exec(indexHtml)?.[0] ?? "";
    expect(key).toContain('type="password"');
    expect(key).toContain('autocomplete="off"');
    // The key lives in the page only; nothing here persists it.
    expect(indexHtml).not.toContain("localStorage");
  });

  it("offers install, copy and check controls", () => {
    expect(indexHtml).toContain('id="connect-install"');
    expect(indexHtml).toContain('id="connect-copy"');
    expect(indexHtml).toContain('id="connect-check"');
    expect(indexHtml).toContain('id="connect-status"');
    expect(indexHtml).toContain('aria-live="polite"');
  });
});
