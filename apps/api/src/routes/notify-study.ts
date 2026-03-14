import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";
import {
  sendTelegramMessage,
  formatStudyNotification,
  formatStudyReappeared,
} from "../telegram.js";
import { auditLog, getCorrelationId } from "../lib/audit-log.js";

const router: RouterType = Router();

/**
 * Per-extensionId rate limiter (sliding window).
 * Prevents a single user from flooding Telegram regardless of IP.
 * Allows up to 30 notifications per 60 seconds per extension.
 */
const PER_EXT_MAX = 30;
const PER_EXT_WINDOW_MS = 60 * 1000;
const perExtTimestamps = new Map<string, number[]>();

function isExtensionRateLimited(extensionId: string): boolean {
  const now = Date.now();
  const windowStart = now - PER_EXT_WINDOW_MS;
  const timestamps = (perExtTimestamps.get(extensionId) ?? []).filter(
    (t) => t > windowStart,
  );
  if (timestamps.length >= PER_EXT_MAX) {
    perExtTimestamps.set(extensionId, timestamps);
    return true;
  }
  timestamps.push(now);
  perExtTimestamps.set(extensionId, timestamps);
  return false;
}

// Clean up stale entries every 5 minutes
setInterval(
  () => {
    const windowStart = Date.now() - PER_EXT_WINDOW_MS;
    for (const [id, timestamps] of perExtTimestamps) {
      const fresh = timestamps.filter((t) => t > windowStart);
      if (fresh.length === 0) perExtTimestamps.delete(id);
      else perExtTimestamps.set(id, fresh);
    }
  },
  5 * 60 * 1000,
);

const studySchema = z.object({
  title: z.string().min(1),
  reward: z.string().min(1),
  completionTime: z.string().nullish(),
  places: z.string().nullish(),
  url: z.string().url(),
  postedAt: z.string(),
  mobileSupported: z.boolean().default(false),
});

const notifyStudySchema = z.object({
  extensionId: z.string().min(1, "Extension ID is required"),
  study: studySchema,
  reappeared: z.boolean().optional().default(false),
});

/**
 * In-memory deduplication cache.
 * Maps study URL to a set of user keys (telegramId) that already received it.
 * Uses telegramId instead of extensionId so dedup works per-user regardless
 * of how many tabs/extension instances are open.
 * Entries are cleaned up after 4 hours.
 */
const recentNotifications = new Map<
  string,
  { userKeys: Set<string>; timestamp: number }
>();
const DEDUP_TTL = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Short-lived dedup for re-appeared notifications.
 * Prevents duplicate sends from concurrent tabs while still allowing
 * future re-appearance alerts after a brief cooldown.
 */
const reappearedRecent = new Map<string, number>();
const REAPPEARED_DEDUP_MS = 30 * 1000; // 30 seconds

function cleanupDedup() {
  const now = Date.now();
  for (const [key, entry] of recentNotifications) {
    if (now - entry.timestamp > DEDUP_TTL) {
      recentNotifications.delete(key);
    }
  }

  for (const [key, timestamp] of reappearedRecent) {
    if (now - timestamp > REAPPEARED_DEDUP_MS) {
      reappearedRecent.delete(key);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupDedup, 10 * 60 * 1000);

/**
 * Atomically check-and-mark a study as sent for a given user key.
 * Returns true if it was already marked (duplicate), false if newly claimed.
 * This MUST be called synchronously (no awaits between check and mark)
 * to prevent race conditions with concurrent requests.
 */
function claimStudy(studyUrl: string, userKey: string): boolean {
  let entry = recentNotifications.get(studyUrl);
  if (!entry) {
    entry = { userKeys: new Set(), timestamp: Date.now() };
    recentNotifications.set(studyUrl, entry);
  }
  if (entry.userKeys.has(userKey)) {
    return true; // duplicate
  }
  entry.userKeys.add(userKey);
  return false; // newly claimed
}

function unclaimStudy(studyUrl: string, userKey: string) {
  const entry = recentNotifications.get(studyUrl);
  if (entry) {
    entry.userKeys.delete(userKey);
    if (entry.userKeys.size === 0) {
      recentNotifications.delete(studyUrl);
    }
  }
}

function claimReappeared(studyUrl: string, userKey: string): boolean {
  const key = `${studyUrl}::${userKey}`;
  const now = Date.now();
  const prev = reappearedRecent.get(key);
  if (prev && now - prev < REAPPEARED_DEDUP_MS) {
    return true;
  }
  reappearedRecent.set(key, now);
  return false;
}

/**
 * POST /api/notify-study
 *
 * Receives a detected study from the extension and sends a Telegram notification.
 * - Deduplicates study notifications.
 * - Sends formatted notification to Telegram.
 */
router.post("/notify-study", async (req, res) => {
  try {
    const correlationId = getCorrelationId(
      req.headers as Record<string, unknown>,
    );
    console.log(
      `[API] 📥 POST /api/notify-study — raw body:`,
      JSON.stringify(req.body),
    );
    const { extensionId, study, reappeared } = notifyStudySchema.parse(
      req.body,
    );

    // Per-extensionId rate limit check
    if (isExtensionRateLimited(extensionId)) {
      res.status(429).json({
        success: false,
        message:
          "Too many notifications from this extension. Please slow down.",
      });
      return;
    }

    // Find user by extension ID
    const [user] = await db
      .select({
        id: users.id,
        telegramId: users.telegramId,
        isShadowbanned: users.isShadowbanned,
      })
      .from(users)
      .where(eq(users.extensionInstallId, extensionId));

    if (!user) {
      const resp = {
        success: false,
        message: "Extension not registered. Please link your extension first.",
      };
      console.log(
        `[API] ❌ notify-study FAILED: extensionId=${extensionId} not found — responding:`,
        JSON.stringify(resp),
      );
      res.status(404).json(resp);
      return;
    }

    console.log(
      `[API] 👤 User found: id=${user.id}, telegramId=${user.telegramId}`,
    );

    // Shadowban check — silently pretend success
    if (user.isShadowbanned) {
      console.log(
        `[API] 🔇 notify-study SHADOWBANNED: user ${user.id} — silently skipping`,
      );
      res.json({
        success: true,
        message: "Study notification sent successfully.",
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
        `[API] ❌ notify-study FAILED: user ${user.id} has no telegramId — responding:`,
        JSON.stringify(resp),
      );
      res.status(400).json(resp);
      return;
    }

    // Atomic deduplication: check-and-claim in one synchronous step.
    // This prevents race conditions when multiple tabs send the same study
    // concurrently — the second request will see the claim before any async
    // work (DB update, Telegram send) has completed.
    // Dedup is keyed by telegramId so it works per-user regardless of
    // how many extension instances are open.
    // Re-appeared studies bypass dedup entirely.
    if (!reappeared) {
      const wasDuplicate = claimStudy(study.url, user.telegramId);
      if (wasDuplicate) {
        const resp = {
          success: true,
          message: "Study notification already sent (deduplicated).",
          data: { deduplicated: true },
        };
        console.log(
          `[API] ⏭️ notify-study SKIPPED (deduplicated): "${study.title}" — responding:`,
          JSON.stringify(resp),
        );
        auditLog({
          eventType: "NOTIFICATION_SENT",
          success: true,
          userId: user.id,
          telegramId: user.telegramId ?? undefined,
          extensionId,
          notificationType: "NEW",
          studyUrl: study.url,
          studyTitle: study.title,
          studyReward: study.reward,
          studyPlaces: study.places ?? undefined,
          studyPostedAt: study.postedAt,
          reappeared: false,
          deduplicated: true,
          dedupSource: "server-4h-cache",
          correlationId,
        });
        res.json(resp);
        return;
      }
    } else {
      const wasDuplicateReappeared = claimReappeared(
        study.url,
        user.telegramId,
      );
      if (wasDuplicateReappeared) {
        const resp = {
          success: true,
          message: "Re-appeared study notification already sent recently.",
          data: { deduplicated: true },
        };
        console.log(
          `[API] ⏭️ notify-study SKIPPED (reappeared dedup): "${study.title}" — responding:`,
          JSON.stringify(resp),
        );
        auditLog({
          eventType: "NOTIFICATION_SENT",
          success: true,
          userId: user.id,
          telegramId: user.telegramId ?? undefined,
          extensionId,
          notificationType: "REAPPEARED",
          studyUrl: study.url,
          studyTitle: study.title,
          studyReward: study.reward,
          studyPlaces: study.places ?? undefined,
          studyPostedAt: study.postedAt,
          reappeared: true,
          deduplicated: true,
          dedupSource: "reappeared-30s-cache",
          correlationId,
        });
        res.json(resp);
        return;
      }

      console.log(
        `[API] 🔄 notify-study: re-appeared study — passing short-window dedup for "${study.title}"`,
      );
    }

    // Send Telegram notification
    // If this fails, unclaim so the user can retry.
    try {
      const message = reappeared
        ? formatStudyReappeared(study)
        : formatStudyNotification(study);
      console.log(
        `[API] 📨 Sending Telegram notification to ${user.telegramId}${reappeared ? " (re-appeared)" : ""}...`,
      );
      await sendTelegramMessage(user.telegramId, message);
      console.log(`[API] ✅ Telegram message sent successfully`);
    } catch (sendError) {
      // Unclaim so a retry can succeed (only if we claimed)
      if (!reappeared) {
        unclaimStudy(study.url, user.telegramId);
      }
      throw sendError;
    }

    // Increment notifications counter and update last_online
    await db
      .update(users)
      .set({
        notificationsSent: sql`${users.notificationsSent} + 1`,
        lastOnline: new Date(),
      })
      .where(eq(users.id, user.id));

    const resp = {
      success: true,
      message: "Study notification sent successfully.",
      data: { deduplicated: false },
    };
    console.log(
      `[API] ✅ notify-study SUCCESS: sent "${study.title}" (${study.reward}) to Telegram user ${user.telegramId} — responding:`,
      JSON.stringify(resp),
    );
    auditLog({
      eventType: "NOTIFICATION_SENT",
      success: true,
      userId: user.id,
      telegramId: user.telegramId ?? undefined,
      extensionId,
      notificationType: reappeared ? "REAPPEARED" : "NEW",
      studyUrl: study.url,
      studyTitle: study.title,
      studyReward: study.reward,
      studyPlaces: study.places ?? undefined,
      studyCompletionTime: study.completionTime ?? undefined,
      studyMobileSupported: study.mobileSupported,
      studyPostedAt: study.postedAt,
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
        `[API] ❌ notify-study VALIDATION ERROR — responding:`,
        JSON.stringify(resp),
      );
      res.status(400).json(resp);
      return;
    }
    console.error(`[API] ❌ notify-study UNEXPECTED ERROR:`, error);
    throw error;
  }
});

export default router;
