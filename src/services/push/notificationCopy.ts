import type { ProviderName } from "../../providers";

/**
 * Notification copy, per language.
 *
 * The languages are the ones tb-mobile ships (`locales/`): a push in a language
 * the app itself cannot display would be the only screen in it. Anything else
 * falls back to English.
 *
 * What the copy may say is bounded by the privacy policy: which session and
 * which agent, never what the agent said or what it wants to run. That is why a
 * permission push reads "needs your go-ahead" rather than naming the tool, and
 * why a question push does not carry the question. See waitingInputMessage.
 *
 * The non-English strings are machine-written and want a native review.
 */

export type AttentionKind = "turn_done" | "permission" | "question" | "failed";

type Copy = Record<AttentionKind, (agent: string) => string>;

const COPY: Record<string, Copy> = {
  en: {
    turn_done: (a) => `${a} finished — tap to read the reply and continue.`,
    permission: (a) => `${a} needs your go-ahead to continue.`,
    question: (a) => `${a} has a question for you.`,
    failed: (a) => `${a} could not start.`,
  },
  he: {
    turn_done: (a) => `התשובה של ${a} מוכנה — הקישו כדי לקרוא ולהמשיך.`,
    permission: (a) => `${a} ממתין לאישור שלך כדי להמשיך.`,
    question: (a) => `ל-${a} יש שאלה בשבילך.`,
    failed: (a) => `${a} לא הצליח להתחיל.`,
  },
  ar: {
    turn_done: (a) => `رد ${a} جاهز — اضغط للقراءة والمتابعة.`,
    permission: (a) => `${a} بانتظار موافقتك للمتابعة.`,
    question: (a) => `لدى ${a} سؤال لك.`,
    failed: (a) => `تعذّر تشغيل ${a}.`,
  },
  ru: {
    turn_done: (a) => `Ответ ${a} готов — нажмите, чтобы прочитать и продолжить.`,
    permission: (a) => `${a} ждёт вашего разрешения, чтобы продолжить.`,
    question: (a) => `У ${a} есть к вам вопрос.`,
    failed: (a) => `${a} не удалось запустить.`,
  },
};

/** Scannable at a glance in a stack of notifications, in any language. */
const TITLE_MARK: Record<AttentionKind, string> = {
  turn_done: "✅",
  permission: "✋",
  question: "💬",
  failed: "❌",
};

/** "he-IL" → "he"; unsupported or absent → "en". `iw` is Android's legacy Hebrew code. */
export function pushLanguage(locale: string | null | undefined): string {
  const lang = locale?.split(/[-_]/)[0]?.toLowerCase();
  if (lang === "iw") return "he";
  return lang && Object.hasOwn(COPY, lang) ? lang : "en";
}

const TEST_COPY: Record<string, string> = {
  en: "Test notification — push delivery works.",
  he: "התראת בדיקה — שליחת ההתראות עובדת.",
  ar: "إشعار تجريبي — تسليم الإشعارات يعمل.",
  ru: "Тестовое уведомление — доставка работает.",
};

/** What the settings screen's "Send test notification" delivers. */
export function testNotificationBody(locale: string | null | undefined): string {
  return TEST_COPY[pushLanguage(locale)];
}

export function agentLabel(provider: ProviderName | undefined): string {
  if (provider === "codex-cli") return "Codex";
  if (provider === "cursor") return "Cursor";
  return "Claude";
}

export function attentionTitle(kind: AttentionKind, projectName: string): string {
  return `${TITLE_MARK[kind]} ${projectName || "Threadbase"}`;
}

export function attentionBody(
  kind: AttentionKind,
  provider: ProviderName | undefined,
  locale: string | null | undefined,
): string {
  return COPY[pushLanguage(locale)][kind](agentLabel(provider));
}
