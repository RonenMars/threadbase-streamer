import { describe, expect, it } from "vitest";
import {
  type NotificationPrefs,
  NotificationPrefsSchema,
  type QuietHours,
} from "../src/schemas/notification-prefs.schema";
import { allows, isQuietNow, parseStoredPrefs } from "../src/services/push/notificationPrefs";

/**
 * Quiet hours are evaluated in the phone's zone, not the server's, and an
 * overnight window belongs to the day it starts on. Every "not quiet" assertion
 * here sits beside a "quiet" one in the same setup, so a filter that returns
 * `false` for everything cannot pass.
 *
 * 2026-09-18 is a Friday.
 */

const qh = (over: Partial<QuietHours> = {}): QuietHours => ({
  enabled: true,
  tz: "UTC",
  default: { from: "22:00", to: "08:00" },
  ...over,
});

/** A UTC instant, so the test states the zone it means. */
const at = (iso: string) => new Date(iso);

describe("isQuietNow", () => {
  it("is never quiet when disabled", () => {
    expect(isQuietNow(qh({ enabled: false }), at("2026-09-18T23:00:00Z"))).toBe(false);
    expect(isQuietNow(qh(), at("2026-09-18T23:00:00Z"))).toBe(true);
  });

  it("handles a same-day window, start inclusive and end exclusive", () => {
    const q = qh({ default: { from: "09:00", to: "17:00" } });
    expect(isQuietNow(q, at("2026-09-18T08:59:00Z"))).toBe(false);
    expect(isQuietNow(q, at("2026-09-18T09:00:00Z"))).toBe(true);
    expect(isQuietNow(q, at("2026-09-18T16:59:00Z"))).toBe(true);
    expect(isQuietNow(q, at("2026-09-18T17:00:00Z"))).toBe(false);
  });

  it("carries an overnight window across midnight", () => {
    const q = qh();
    expect(isQuietNow(q, at("2026-09-18T21:59:00Z"))).toBe(false);
    expect(isQuietNow(q, at("2026-09-18T22:00:00Z"))).toBe(true);
    expect(isQuietNow(q, at("2026-09-19T07:59:00Z"))).toBe(true);
    expect(isQuietNow(q, at("2026-09-19T08:00:00Z"))).toBe(false);
  });

  it("treats from === to as an empty window, not 24 hours", () => {
    const q = qh({ default: { from: "10:00", to: "10:00" } });
    expect(isQuietNow(q, at("2026-09-18T10:00:00Z"))).toBe(false);
    expect(isQuietNow(q, at("2026-09-18T15:00:00Z"))).toBe(false);
  });

  describe("per-weekday overrides", () => {
    it("a null day has no quiet hours that evening, but the previous night's tail still applies", () => {
      const q = qh({ days: { fri: null } });
      // Friday evening: the override cancels tonight's window.
      expect(isQuietNow(q, at("2026-09-18T23:00:00Z"))).toBe(false);
      // Saturday 07:00 is the tail of FRIDAY's window, which is cancelled.
      expect(isQuietNow(q, at("2026-09-19T07:00:00Z"))).toBe(false);
      // Friday 07:00 is the tail of THURSDAY's default window, still quiet.
      expect(isQuietNow(q, at("2026-09-18T07:00:00Z"))).toBe(true);
      // Saturday evening is unaffected.
      expect(isQuietNow(q, at("2026-09-19T23:00:00Z"))).toBe(true);
    });

    it("an override replaces the default for the window that starts that day", () => {
      const q = qh({ days: { fri: { from: "23:30", to: "10:00" } } });
      expect(isQuietNow(q, at("2026-09-18T23:00:00Z"))).toBe(false);
      expect(isQuietNow(q, at("2026-09-18T23:30:00Z"))).toBe(true);
      // The tail runs to Friday's own end time, not the default's 08:00.
      expect(isQuietNow(q, at("2026-09-19T09:00:00Z"))).toBe(true);
      expect(isQuietNow(q, at("2026-09-19T10:00:00Z"))).toBe(false);
    });
  });

  describe("time zone", () => {
    it("reads the clock in the user's zone, not UTC", () => {
      // 19:30Z on Friday is 22:30 in Jerusalem (UTC+3 in September).
      const instant = at("2026-09-18T19:30:00Z");
      expect(isQuietNow(qh({ tz: "Asia/Jerusalem" }), instant)).toBe(true);
      expect(isQuietNow(qh({ tz: "UTC" }), instant)).toBe(false);
    });

    it("uses the zone's weekday, which can differ from UTC's", () => {
      // 22:30Z Friday is already Saturday 01:30 in Jerusalem: tail of Friday's window.
      const q = qh({ tz: "Asia/Jerusalem", days: { fri: null } });
      expect(isQuietNow(q, at("2026-09-18T22:30:00Z"))).toBe(false);
      expect(isQuietNow({ ...q, days: {} }, at("2026-09-18T22:30:00Z"))).toBe(true);
    });

    it("follows local time through the autumn DST change", () => {
      // New York falls back on 2026-11-01: 01:30 happens twice (EDT then EST).
      const q = qh({ tz: "America/New_York", default: { from: "01:00", to: "03:00" } });
      expect(isQuietNow(q, at("2026-11-01T05:30:00Z"))).toBe(true); // 01:30 EDT
      expect(isQuietNow(q, at("2026-11-01T06:30:00Z"))).toBe(true); // 01:30 EST
      expect(isQuietNow(q, at("2026-11-01T07:30:00Z"))).toBe(true); // 02:30 EST
      expect(isQuietNow(q, at("2026-11-01T08:30:00Z"))).toBe(false); // 03:30 EST
    });
  });
});

describe("allows", () => {
  const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
    waitingInput: true,
    sessionFailed: true,
    ...over,
  });
  const noon = at("2026-09-18T12:00:00Z");
  const night = at("2026-09-18T23:00:00Z");

  it("allows everything when the device sent no preferences", () => {
    expect(allows(null, "waitingInput", night)).toBe(true);
    expect(allows(null, "sessionFailed", night)).toBe(true);
  });

  it("gates each event on its own toggle", () => {
    const p = prefs({ waitingInput: false });
    expect(allows(p, "waitingInput", noon)).toBe(false);
    expect(allows(p, "sessionFailed", noon)).toBe(true);
  });

  it("drops inside quiet hours and delivers outside them", () => {
    const p = prefs({ quietHours: qh() });
    expect(allows(p, "waitingInput", night)).toBe(false);
    expect(allows(p, "waitingInput", noon)).toBe(true);
    expect(allows(p, "sessionFailed", night)).toBe(false);
  });
});

describe("parseStoredPrefs", () => {
  const valid: NotificationPrefs = { waitingInput: false, sessionFailed: true, quietHours: qh() };

  it("round-trips a stored blob", () => {
    expect(parseStoredPrefs(JSON.stringify(valid))).toEqual(valid);
  });

  it("fails open on NULL, garbage and a blob that no longer validates", () => {
    expect(parseStoredPrefs(null)).toBeNull();
    expect(parseStoredPrefs("{not json")).toBeNull();
    expect(parseStoredPrefs(JSON.stringify({ waitingInput: "yes" }))).toBeNull();
  });
});

describe("NotificationPrefsSchema", () => {
  const base = { waitingInput: true, sessionFailed: true };

  it("accepts a full preference object", () => {
    expect(NotificationPrefsSchema.safeParse({ ...base, quietHours: qh() }).success).toBe(true);
    expect(NotificationPrefsSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an unknown time zone", () => {
    const bad = { ...base, quietHours: qh({ tz: "Mars/Olympus" }) };
    expect(NotificationPrefsSchema.safeParse(bad).success).toBe(false);
  });

  it.each(["24:00", "9:00", "12:60", "noon"])("rejects the malformed time %s", (time) => {
    const bad = { ...base, quietHours: qh({ default: { from: time, to: "08:00" } }) };
    expect(NotificationPrefsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown weekday key", () => {
    const bad = { ...base, quietHours: { ...qh(), days: { funday: null } } };
    expect(NotificationPrefsSchema.safeParse(bad).success).toBe(false);
  });
});
