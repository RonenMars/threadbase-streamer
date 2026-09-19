import { z } from "zod";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** IANA zone names resolve in `Intl`; anything else throws a RangeError. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const TimeSchema = z.string().regex(HHMM, "expected HH:MM, 24-hour");

export const QuietWindowSchema = z.object({ from: TimeSchema, to: TimeSchema });

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const QuietHoursSchema = z.object({
  enabled: z.boolean(),
  /** The phone's zone. Without it "22:00" means the server's clock, not the user's. */
  tz: z.string().refine(isValidTimeZone, "unknown IANA time zone"),
  default: QuietWindowSchema,
  /**
   * A weekday listed here replaces `default` for the window that STARTS that
   * day. `null` means no quiet hours that day.
   */
  days: z.partialRecord(z.enum(WEEKDAYS), QuietWindowSchema.nullable()).optional(),
});

/**
 * What one device wants to be told about.
 *
 * `waitingInput` gates every push that means "the agent is waiting on you" —
 * finished, needs a go-ahead, has a question. `sessionFailed` gates the
 * "session could not start" push.
 */
export const NotificationPrefsSchema = z.object({
  waitingInput: z.boolean(),
  sessionFailed: z.boolean(),
  quietHours: QuietHoursSchema.optional(),
});

export type QuietWindow = z.infer<typeof QuietWindowSchema>;
export type QuietHours = z.infer<typeof QuietHoursSchema>;
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;
