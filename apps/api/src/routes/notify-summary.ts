import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";
import { sendTelegramMessage, formatStudiesSummary } from "../telegram.js";
import { auditLog, getCorrelationId } from "../lib/audit-log.js";

const router: RouterType = Router();

const summaryRecent = new Map<string, number>();
const SUMMARY_DEDUP_MS = 30 * 1000; // 30 seconds

function makeSummaryKey(
  telegramId: string,
  summary: {
    totalNew: number;
    topStudies: {
      title: string;
      reward: string;
      completionTime?: string | null;
      places?: string | null;
      url: string;
      mobileSupported: boolean;
    }[];
  },
  reappeared: boolean,
): string {
  const urls = summary.topStudies
    .map((s) => s.url)
    .sort()
    .join("|");
  return `${telegramId}::${reappeared ? "reappeared" : "new"}::${summary.totalNew}::${urls}`;
}

function claimSummary(
  telegramId: string,
  summary: {
    totalNew: number;
    topStudies: {
      title: string;
      reward: string;
      completionTime?: string | null;
      places?: string | null;
      url: string;
      mobileSupported: boolean;
    }[];
  },
  reappeared: boolean,
): boolean {
  const key = makeSummaryKey(telegramId, summary, reappeared);
  const now = Date.now();
  const prev = summaryRecent.get(key);
  if (prev && now - prev < SUMMARY_DEDUP_MS) {
    return true;
  }
  summaryRecent.set(key, now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of summaryRecent) {
    if (now - timestamp > SUMMARY_DEDUP_MS) {
      summaryRecent.delete(key);
    }
  }
}, 60 * 1000);

const summaryStudySchema = z.object({
  title: z.string().min(1),
  reward: z.string().min(1),
  completionTime: z.string().nullish(),
  places: z.string().nullish(),
  url: z.string().url(),
  mobileSupported: z.boolean().default(false),
});

const summarySchema = z.object({
  extensionId: z.string().min(1, "Extension ID is required"),
  reappeared: z.boolean().optional().default(false),
  summary: z.object({
    totalNew: z.number().int().min(1),
    topStudies: z.array(summaryStudySchema).min(1).max(5),
  }),
});

/**
 * POST /api/notify-summary
 *
 * Sends a batch summary notification when many new studies appear at once.
 * - Sends a single formatted summary message to Telegram.
 */
router.post("/notify-summary", async (req, res) => {
  try {
    const correlationId = getCorrelationId(
      req.headers as Record<string, unknown>,
    );
    console.log(
      `[API] 📥 POST /api/notify-summary — raw body:`,
      JSON.stringify(req.body),
    );
    const { extensionId, summary, reappeared } = summarySchema.parse(req.body);

    // Find user by extension ID
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.extensionInstallId, extensionId));

    if (!user) {
      const resp = {
        success: false,
        message: "Extension not registered. Please link your extension first.",
      };
      console.log(
        `[API] ❌ notify-summary FAILED: extensionId=${extensionId} not found`,
      );
      res.status(404).json(resp);
      return;
    }

    // Shadowban check — silently pretend success
    if (user.isShadowbanned) {
      console.log(
        `[API] 🔇 notify-summary SHADOWBANNED: user ${user.id} — silently skipping`,
      );
      res.json({
        success: true,
        message: "Summary notification sent successfully.",
        data: { deduplicated: false },
      });
      return;
    }

    // Check if user has a Telegram ID
    if (!user.telegramId) {
      const resp = {
        success: false,
        message:
          "No Telegram account linked. Please use /token in the Telegram bot.",
      };
      console.log(
        `[API] ❌ notify-summary FAILED: user ${user.id} has no telegramId`,
      );
      res.status(400).json(resp);
      return;
    }

    const isDuplicateSummary = claimSummary(
      user.telegramId,
      summary,
      reappeared,
    );
    if (isDuplicateSummary) {
      const resp = {
        success: true,
        message: "Summary notification already sent recently.",
        data: { deduplicated: true },
      };
      console.log(
        `[API] ⏭️ notify-summary SKIPPED (deduplicated): total=${summary.totalNew}`,
      );
      auditLog({
        eventType: "NOTIFICATION_SENT",
        success: true,
        userId: user.id,
        telegramId: user.telegramId ?? undefined,
        extensionId,
        notificationType: "SUMMARY",
        summaryTotalNew: summary.totalNew,
        summaryStudyUrls: summary.topStudies.map((s) => s.url).join(" | "),
        summaryStudyTitles: summary.topStudies
          .map((s) => `${s.title} (${s.reward})`)
          .join(" | "),
        reappeared,
        deduplicated: true,
        dedupSource: "summary-30s-cache",
        correlationId,
      });
      res.json(resp);
      return;
    }

    // Send Telegram summary notification
    const message = formatStudiesSummary(summary.totalNew, summary.topStudies, {
      reappeared,
    });
    console.log(
      `[API] 📨 Sending summary Telegram notification to ${user.telegramId}...`,
    );
    await sendTelegramMessage(user.telegramId, message);
    console.log(`[API] ✅ Summary Telegram message sent successfully`);

    // Update last_online (don't increment notifications_sent for summaries)
    await db
      .update(users)
      .set({
        notificationsSent: sql`${users.notificationsSent} + 1`,
        lastOnline: new Date(),
      })
      .where(eq(users.id, user.id));

    const resp = {
      success: true,
      message: "Summary notification sent successfully.",
      data: { deduplicated: false },
    };
    console.log(
      `[API] ✅ notify-summary SUCCESS: sent summary (${summary.totalNew} studies) to Telegram user ${user.telegramId}`,
    );
    auditLog({
      eventType: "NOTIFICATION_SENT",
      success: true,
      userId: user.id,
      telegramId: user.telegramId ?? undefined,
      extensionId,
      notificationType: "SUMMARY",
      summaryTotalNew: summary.totalNew,
      summaryStudyUrls: summary.topStudies.map((s) => s.url).join(" | "),
      summaryStudyTitles: summary.topStudies
        .map((s) => `${s.title} (${s.reward})`)
        .join(" | "),
      reappeared,
      deduplicated: false,
      correlationId,
    });
    res.json(resp);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const resp = {
        success: false,
        message: "Validation error",
        errors: error.flatten().fieldErrors,
      };
      console.log(
        `[API] ❌ notify-summary VALIDATION ERROR —`,
        JSON.stringify(resp),
      );
      res.status(400).json(resp);
      return;
    }
    console.error(`[API] ❌ notify-summary UNEXPECTED ERROR:`, error);
    throw error;
  }
});

export default router;
