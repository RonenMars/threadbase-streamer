import type { ProviderName } from "../../providers";
import { CODEX_USAGE_LIMIT_RE, CODEX_USAGE_RESET_TIP_RE } from "../questions/codexScreen";

/**
 * Notification copy, per language.
 *
 * The languages are the ones tb-mobile ships (`locales/`): a push in a language
 * the app itself cannot display would be the only screen in it. Anything else
 * falls back to English.
 *
 * What the copy may say is bounded by the privacy policy: which session and
 * which agent, never what the agent said or what it wants to run. So a
 * permission push names the *kind* of action ("run a command") in our words,
 * never the command, and a question push counts the options rather than
 * quoting them. See waitingInputMessage, and docs/design/notification-copy.md
 * for what each kind says and why.
 *
 * The non-English strings are machine-written and want a native review.
 */

export type AttentionKind = "turn_done" | "permission" | "question" | "failed" | "limited";

/** What a permission gate asks for, as far as the gate's own chrome tells us. */
export type GateAction = "command" | "edit";

/**
 * The metadata a push may carry beyond the session's identity. Every field is
 * something the streamer measured or classified, never text the agent wrote.
 */
export interface AttentionFacts {
  /** turn_done: whole minutes from the submit to the turn's end. */
  turnMinutes?: number;
  /** permission: what the gate asks to do, when recognised. */
  action?: GateAction;
  /** question: how many options the (single) question offers. */
  optionCount?: number;
  /** failed: `ManagedSession.failureCode`. */
  failureCode?: string;
  /** limited: when the limit resets, as the agent printed it (a clock time). */
  resetsAt?: string;
}

interface Line {
  subtitle: string;
  body: string;
}

type Copy = (agent: string, facts: AttentionFacts) => Record<AttentionKind, () => Line>;

const COPY: Record<string, Copy> = {
  en: (a, f) => ({
    turn_done: () => ({
      subtitle: `${a} finished`,
      body: f.turnMinutes ? `Worked for ${f.turnMinutes} min.` : "Tap to read the reply.",
    }),
    permission: () => ({
      subtitle:
        f.action === "command"
          ? `${a} wants to run a command`
          : f.action === "edit"
            ? `${a} wants to edit a file`
            : `${a} needs your approval`,
      body: "Paused until you answer.",
    }),
    question: () => ({
      subtitle: `${a} asked a question`,
      body: f.optionCount
        ? `${f.optionCount} options — paused until you pick one.`
        : "Paused until you answer.",
    }),
    failed: () => ({
      subtitle: `${a} could not start`,
      body:
        f.failureCode === "project_dir_missing"
          ? "The project folder no longer exists on this computer."
          : f.failureCode === "instant_exit"
            ? `${a} exited as it started. Check it is installed and signed in.`
            : f.failureCode === "codex_active_writer"
              ? "This conversation is open in another terminal. Fork it to continue here."
              : "Open the session for details.",
    }),
    limited: () => ({
      subtitle: `${a} hit its usage limit`,
      body: f.resetsAt ? `Resets at ${f.resetsAt}. Paused until then.` : "Paused until it resets.",
    }),
  }),
  he: (a, f) => ({
    turn_done: () => ({
      subtitle: `${a} סיים`,
      body: f.turnMinutes ? `עבד ${f.turnMinutes} דק׳.` : "הקישו כדי לקרוא את התשובה.",
    }),
    permission: () => ({
      subtitle:
        f.action === "command"
          ? `${a} רוצה להריץ פקודה`
          : f.action === "edit"
            ? `${a} רוצה לערוך קובץ`
            : `${a} ממתין לאישור שלך`,
      body: "מושהה עד שתענו.",
    }),
    question: () => ({
      subtitle: `ל-${a} יש שאלה`,
      body: f.optionCount ? `${f.optionCount} אפשרויות — מושהה עד שתבחרו.` : "מושהה עד שתענו.",
    }),
    failed: () => ({
      subtitle: `${a} לא הצליח להתחיל`,
      body:
        f.failureCode === "project_dir_missing"
          ? "תיקיית הפרויקט כבר לא קיימת במחשב הזה."
          : f.failureCode === "instant_exit"
            ? `${a} נסגר מיד עם ההפעלה. ודאו שהוא מותקן ומחובר.`
            : f.failureCode === "codex_active_writer"
              ? "השיחה פתוחה בטרמינל אחר. פצלו אותה כדי להמשיך כאן."
              : "פתחו את הסשן לפרטים.",
    }),
    limited: () => ({
      subtitle: `${a} הגיע למגבלת השימוש`,
      body: f.resetsAt ? `מתאפס ב-${f.resetsAt}. מושהה עד אז.` : "מושהה עד לאיפוס.",
    }),
  }),
  ar: (a, f) => ({
    turn_done: () => ({
      subtitle: `انتهى ${a}`,
      body: f.turnMinutes ? `مدة العمل: ${f.turnMinutes} د.` : "اضغط لقراءة الرد.",
    }),
    permission: () => ({
      subtitle:
        f.action === "command"
          ? `${a} يريد تشغيل أمر`
          : f.action === "edit"
            ? `${a} يريد تعديل ملف`
            : `${a} بانتظار موافقتك`,
      body: "متوقف حتى تجيب.",
    }),
    question: () => ({
      subtitle: `لدى ${a} سؤال`,
      body: f.optionCount ? `عدد الخيارات: ${f.optionCount} — متوقف حتى تختار.` : "متوقف حتى تجيب.",
    }),
    failed: () => ({
      subtitle: `تعذّر تشغيل ${a}`,
      body:
        f.failureCode === "project_dir_missing"
          ? "مجلد المشروع لم يعد موجودًا على هذا الجهاز."
          : f.failureCode === "instant_exit"
            ? `أُغلق ${a} فور تشغيله. تأكد من تثبيته وتسجيل الدخول.`
            : f.failureCode === "codex_active_writer"
              ? "هذه المحادثة مفتوحة في طرفية أخرى. انسخها للمتابعة هنا."
              : "افتح الجلسة للتفاصيل.",
    }),
    limited: () => ({
      subtitle: `بلغ ${a} حد الاستخدام`,
      body: f.resetsAt
        ? `يُعاد الضبط عند ${f.resetsAt}. متوقف حتى ذلك الحين.`
        : "متوقف حتى إعادة الضبط.",
    }),
  }),
  ru: (a, f) => ({
    turn_done: () => ({
      subtitle: `${a} закончил`,
      body: f.turnMinutes ? `Работал ${f.turnMinutes} мин.` : "Нажмите, чтобы прочитать ответ.",
    }),
    permission: () => ({
      subtitle:
        f.action === "command"
          ? `${a} хочет выполнить команду`
          : f.action === "edit"
            ? `${a} хочет изменить файл`
            : `${a} ждёт вашего разрешения`,
      body: "Пауза, пока вы не ответите.",
    }),
    question: () => ({
      subtitle: `У ${a} есть вопрос`,
      body: f.optionCount
        ? `Вариантов: ${f.optionCount} — пауза, пока вы не выберете.`
        : "Пауза, пока вы не ответите.",
    }),
    failed: () => ({
      subtitle: `${a} не удалось запустить`,
      body:
        f.failureCode === "project_dir_missing"
          ? "Папки проекта больше нет на этом компьютере."
          : f.failureCode === "instant_exit"
            ? `${a} завершился сразу после запуска. Проверьте, что он установлен и выполнен вход.`
            : f.failureCode === "codex_active_writer"
              ? "Этот разговор открыт в другом терминале. Сделайте форк, чтобы продолжить здесь."
              : "Откройте сессию, чтобы узнать подробности.",
    }),
    limited: () => ({
      subtitle: `${a} исчерпал лимит`,
      body: f.resetsAt
        ? `Сброс в ${f.resetsAt}. Пауза до этого времени.`
        : "Пауза до сброса лимита.",
    }),
  }),
};

/** Scannable at a glance in a stack of notifications, in any language. */
const TITLE_MARK: Record<AttentionKind, string> = {
  turn_done: "✅",
  permission: "✋",
  question: "💬",
  failed: "❌",
  limited: "⏳",
};

/** Android's guideline for a title that is not cut off; the branch gives way first. */
const TITLE_MAX = 30;

/** Branches whose name tells the user nothing about which session this is. */
const DEFAULT_BRANCHES = new Set(["", "main", "master", "HEAD"]);

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

/**
 * `✅ my-app · fix/login`: which session, in the first 30 characters. Two
 * sessions of one project differ by branch, so the branch is shown unless it is
 * a default one, and shortened (then dropped) before the project name is.
 */
export function attentionTitle(kind: AttentionKind, projectName: string, branch?: string): string {
  const head = `${TITLE_MARK[kind]} ${projectName || "Threadbase"}`;
  if (branch == null || DEFAULT_BRANCHES.has(branch)) return head;
  const room = TITLE_MAX - head.length - " · ".length;
  if (room < 4) return head;
  const shown = branch.length <= room ? branch : `${branch.slice(0, room - 1)}…`;
  return `${head} · ${shown}`;
}

/**
 * Subtitle and body. iOS shows the subtitle on its own line; Android has no
 * subtitle, so there the event leads the body instead of being lost.
 */
export function attentionText(
  kind: AttentionKind,
  provider: ProviderName | undefined,
  locale: string | null | undefined,
  platform: string | undefined,
  facts: AttentionFacts = {},
): { subtitle?: string; body: string } {
  const line = COPY[pushLanguage(locale)](agentLabel(provider), facts)[kind]();
  return platform === "android"
    ? { body: `${line.subtitle}. ${line.body}` }
    : { subtitle: line.subtitle, body: line.body };
}

/** A reset time as the agent printed it: short, and it must hold a digit. */
const RESET_AT_RE = /try again at\s+([^\n]{1,40}?)\.?\s*$/i;

/**
 * Classify a permission gate from its own chrome — the tool title Claude paints
 * at the top of the box, the prompt line, Codex's approval heading. Only
 * layouts seen on a real screen are recognised; anything else stays a plain
 * "needs your approval", which is what every gate said before.
 */
export function describeGate(gate: { prompt?: string; detail?: string }): {
  kind: "permission" | "limited";
  facts: AttentionFacts;
} {
  const prompt = gate.prompt ?? "";
  if (CODEX_USAGE_LIMIT_RE.test(prompt) || CODEX_USAGE_RESET_TIP_RE.test(prompt)) {
    const resetsAt = RESET_AT_RE.exec(gate.detail ?? "")?.[1];
    return {
      kind: "limited",
      facts: resetsAt && /\d/.test(resetsAt) ? { resetsAt } : {},
    };
  }
  const title = gate.detail?.split("\n")[0]?.trim();
  if (title === "Bash command" || prompt === "Codex requests command approval") {
    return { kind: "permission", facts: { action: "command" } };
  }
  if (/^Do you want to make this edit\b/.test(prompt)) {
    return { kind: "permission", facts: { action: "edit" } };
  }
  return { kind: "permission", facts: {} };
}
