import {
  type NotificationPrefs,
  NotificationPrefsSchema,
  type QuietHours,
  type QuietWindow,
  WEEKDAYS,
  type Weekday,
} from "../../schemas/notification-prefs.schema";

/** The push kinds a preference can gate. */
export type PushEvent = "waitingInput" | "sessionFailed";

/**
 * Read a stored preference blob.
 *
 * NULL and anything that no longer parses both come back `null`, which the send
 * path treats as "everything on". Failing open is deliberate: a corrupt row
 * must not silently mute the one notification the user is waiting for.
 */
export function parseStoredPrefs(raw: string | null): NotificationPrefs | null {
  if (raw == null) return null;
  try {
    const parsed = NotificationPrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** The weekday and minute-of-day `now` falls on in `tz`. */
function localClock(now: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const key = get("weekday").slice(0, 3).toLowerCase() as Weekday;
  return { day: WEEKDAYS.indexOf(key), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** The window that STARTS on weekday index `day`, or null for none. */
function windowStartingOn(qh: QuietHours, day: number): QuietWindow | null {
  const override = qh.days?.[WEEKDAYS[day]];
  // `undefined` = no override for that day; `null` = explicitly no quiet hours.
  return override === undefined ? qh.default : override;
}

/**
 * Is `now` inside the user's quiet hours?
 *
 * A window that ends earlier than it starts runs overnight and belongs to the
 * day it starts on: Friday 22:00–08:00 covers Saturday until 08:00 and uses
 * Friday's entry, not Saturday's. `from === to` is an empty window, not 24h —
 * "always quiet" is what turning the notification off is for.
 */
export function isQuietNow(qh: QuietHours, now: Date): boolean {
  if (!qh.enabled) return false;
  const { day, minutes } = localClock(now, qh.tz);

  const today = windowStartingOn(qh, day);
  if (today) {
    const from = toMinutes(today.from);
    const to = toMinutes(today.to);
    if (from < to && minutes >= from && minutes < to) return true;
    if (from > to && minutes >= from) return true;
  }

  // The tail of an overnight window that began yesterday.
  const yesterday = windowStartingOn(qh, (day + 6) % 7);
  if (yesterday) {
    const from = toMinutes(yesterday.from);
    const to = toMinutes(yesterday.to);
    if (from > to && minutes < to) return true;
  }
  return false;
}

/** Should a push of this kind reach a device with these preferences right now? */
export function allows(prefs: NotificationPrefs | null, event: PushEvent, now: Date): boolean {
  if (prefs === null) return true;
  if (!prefs[event]) return false;
  return !(prefs.quietHours && isQuietNow(prefs.quietHours, now));
}
