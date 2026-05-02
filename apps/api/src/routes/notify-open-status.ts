import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";
import {
  formatAcceptedStatusNotification,
  sendTelegramMessage,
} from "../telegram.js";
import { auditLog, getCorrelationId } from "../lib/audit-log.js";

const router: RouterType = Router();
const LOG = "[Study Alerts][API]";

const providerSchema = z.enum(["prolific", "cloudresearch"]);
const openSourceSchema = z.enum(["automatic", "manual"]);

const acceptedStatusRecent = new Map<string, number>();
const ACCEPTED_STATUS_DEDUP_MS = 10 * 60 * 1000;

function isIsoLikeTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const acceptedStatusSchema = z.object({
  provider: providerSchema,
  title: z.string().min(1).nullish(),
  url: z.string().url().nullish(),
  openSource: openSourceSchema,
  openedAt: z
    .string()
    .min(1)
    .refine(isIsoLikeTimestamp, "openedAt must be an ISO timestamp"),
  acceptedAt: z
    .string()
    .min(1)
    .refine(isIsoLikeTimestamp, "acceptedAt must be an ISO timestamp"),
});

const notifyOpenStatusSchema = z.object({
  extensionId: z.string().min(1, "Extension ID is required"),
  status: acceptedStatusSchema,
});

function makeAcceptedStatusKey(
  telegramId: string,
  status: z.infer<typeof acceptedStatusSchema>,
): string {
  return [
    telegramId,
    status.provider,
    status.openedAt,
    status.url ?? "",
  ].join("::");
}

function claimAcceptedStatus(
  telegramId: string,
  status: z.infer<typeof acceptedStatusSchema>,
): boolean {
  const key = makeAcceptedStatusKey(telegramId, status);
  const now = Date.now();
  const previous = acceptedStatusRecent.get(key);
  if (previous && now - previous < ACCEPTED_STATUS_DEDUP_MS) {
    return true;
  }

  acceptedStatusRecent.set(key, now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of acceptedStatusRecent) {
    if (now - timestamp > ACCEPTED_STATUS_DEDUP_MS) {
      acceptedStatusRecent.delete(key);
    }
  }
}, 60 * 1000);

router.post("/notify-open-status", async (req, res) => {
  try {
    const correlationId = getCorrelationId(
      req.headers as Record<string, unknown>,
    );
    const { extensionId, status } = notifyOpenStatusSchema.parse(req.body);

    console.log(
      `${LOG} accepted-status request provider=${status.provider} openSource=${status.openSource} title="${status.title ?? "unknown"}"`,
    );

    const [user] = await db
      .select({
        id: users.id,
        telegramId: users.telegramId,
        isShadowbanned: users.isShadowbanned,
      })
      .from(users)
      .where(eq(users.extensionInstallId, extensionId));

    if (!user) {
      res.status(404).json({
        success: false,
        message: "Extension not registered. Please link your extension first.",
      });
      return;
    }

    if (user.isShadowbanned) {
      console.log(
        `${LOG} accepted-status shadowbanned user=${user.id} provider=${status.provider}`,
      );
      res.json({
        success: true,
        message: "Accepted-status notification sent successfully.",
        data: { deduplicated: false },
      });
      return;
    }

    if (!user.telegramId) {
      res.status(400).json({
        success: false,
        message:
          "No Telegram account linked. Please use /token in the Telegram bot.",
      });
      return;
    }

    const isDuplicate = claimAcceptedStatus(user.telegramId, status);
    if (isDuplicate) {
      console.log(
        `${LOG} accepted-status deduplicated provider=${status.provider} openSource=${status.openSource}`,
      );
      auditLog({
        eventType: "NOTIFICATION_SENT",
        success: true,
        userId: user.id,
        telegramId: user.telegramId,
        extensionId,
        provider: status.provider,
        notificationType: "ACCEPTED_STATUS",
        studyUrl: status.url ?? undefined,
        studyTitle: status.title ?? undefined,
        deduplicated: true,
        dedupSource: "accepted-status-10m-cache",
        message: `accepted-status ${status.openSource}`,
        correlationId,
      });
      res.json({
        success: true,
        message: "Accepted-status notification already sent recently.",
        data: { deduplicated: true },
      });
      return;
    }

    const message = formatAcceptedStatusNotification(status);
    await sendTelegramMessage(user.telegramId, message);

    await db
      .update(users)
      .set({
        notificationsSent: sql`${users.notificationsSent} + 1`,
        lastOnline: new Date(),
      })
      .where(eq(users.id, user.id));

    console.log(
      `${LOG} accepted-status sent provider=${status.provider} openSource=${status.openSource}`,
    );
    auditLog({
      eventType: "NOTIFICATION_SENT",
      success: true,
      userId: user.id,
      telegramId: user.telegramId,
      extensionId,
      provider: status.provider,
      notificationType: "ACCEPTED_STATUS",
      studyUrl: status.url ?? undefined,
      studyTitle: status.title ?? undefined,
      deduplicated: false,
      message: `accepted-status ${status.openSource}`,
      correlationId,
    });
    res.json({
      success: true,
      message: "Accepted-status notification sent successfully.",
      data: { deduplicated: false },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Validation error",
        errors: error.flatten().fieldErrors,
      });
      return;
    }

    console.error(`${LOG} accepted-status unexpected error`, error);
    throw error;
  }
});

export default router;
