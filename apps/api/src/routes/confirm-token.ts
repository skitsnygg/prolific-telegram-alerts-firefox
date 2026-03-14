import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";
import { sendTelegramMessage } from "../telegram.js";
import { auditLog, getCorrelationId } from "../lib/audit-log.js";

const router: RouterType = Router();

const confirmTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  extensionId: z.string().min(1, "Extension ID is required"),
});

/**
 * POST /api/confirm-token
 *
 * Links a Telegram bot token to an extension instance.
 * - Validates the token exists (matches a user's telegramId).
 * - Checks token is not already linked to another extension.
 * - Links the extension.
 */
router.post("/confirm-token", async (req, res) => {
  try {
    const { token, extensionId } = confirmTokenSchema.parse(req.body);
    const correlationId = getCorrelationId(
      req.headers as Record<string, unknown>,
    );
    console.log(
      `[API] POST /api/confirm-token — token=${token}, extensionId=${extensionId}`,
    );

    // Find user by telegram token (telegramId)
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, token));

    if (!user) {
      console.log(
        `[API] confirm-token FAILED: token=${token} not found in database`,
      );
      auditLog({
        eventType: "EXTENSION_LINK_ERROR",
        success: false,
        extensionId,
        errorCode: "TOKEN_NOT_FOUND",
        message: "Token not found",
        correlationId,
      });
      res.status(404).json({
        success: false,
        message:
          "Invalid token. Please generate a new token using /token in the Telegram bot.",
      });
      return;
    }

    // Check if this token is already linked to a different extension
    // extensionInstallId starting with "pending-" is a placeholder set by the bot — not a real link
    const isLinked =
      user.extensionInstallId &&
      !user.extensionInstallId.startsWith("pending-") &&
      user.extensionInstallId !== extensionId;
    if (isLinked) {
      console.log(
        `[API] confirm-token FAILED: token=${token} already linked to extension=${user.extensionInstallId}`,
      );
      auditLog({
        eventType: "EXTENSION_LINK_ERROR",
        success: false,
        userId: user.id,
        telegramId: user.telegramId ?? undefined,
        extensionId,
        errorCode: "TOKEN_ALREADY_LINKED",
        message: "Token already linked to another extension",
        correlationId,
      });
      res.status(409).json({
        success: false,
        message:
          "This token is already linked to another extension. Send /unlink in the Telegram bot first, then try again.",
      });
      return;
    }

    // Check if this extensionId is already linked to a different user
    const [existingExtension] = await db
      .select()
      .from(users)
      .where(eq(users.extensionInstallId, extensionId));

    if (existingExtension && existingExtension.id !== user.id) {
      auditLog({
        eventType: "EXTENSION_LINK_ERROR",
        success: false,
        userId: user.id,
        telegramId: user.telegramId ?? undefined,
        extensionId,
        errorCode: "EXTENSION_ALREADY_LINKED",
        message: "Extension already linked to another account",
        correlationId,
      });
      res.status(409).json({
        success: false,
        message: "This extension is already linked to a different account.",
      });
      return;
    }

    const updateData: Record<string, unknown> = {
      extensionInstallId: extensionId,
    };

    await db.update(users).set(updateData).where(eq(users.id, user.id));

    console.log(
      `[API] confirm-token SUCCESS: token=${token} linked to extension=${extensionId}`,
    );
    auditLog({
      eventType: "EXTENSION_LINK_SUCCESS",
      success: true,
      userId: user.id,
      telegramId: user.telegramId ?? undefined,
      extensionId,
      correlationId,
    });

    // Send welcome message on Telegram after successful activation
    if (user.telegramId) {
      try {
        await sendTelegramMessage(
          user.telegramId,
          `🎉 <b>Extension linked!</b>\n` +
            `\n` +
            `You'll receive notifications here whenever a new study appears on Prolific.\n` +
            `\n` +
            `Please remember to keep Prolific tab open in your browser.\n` +
            `<b>Available commands:</b>\n` +
            `/token — Get your linking token\n` +
            `/status — Check your status\n` +
            `/unlink — Unlink extension (to re-link on a new browser)\n` +
            `/help — Show all commands\n` +
            `\n` +
            `Need help? Contact @mskd03 on telegram`,
        );
      } catch (err) {
        console.error(`[API] Failed to send activation message:`, err);
      }
    }

    res.json({
      success: true,
      message: "Token confirmed. Extension linked successfully.",
      data: {
        linked: true,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.log(
        `[API] confirm-token VALIDATION ERROR:`,
        error.flatten().fieldErrors,
      );
      auditLog({
        eventType: "EXTENSION_LINK_ERROR",
        success: false,
        extensionId:
          typeof req.body?.extensionId === "string"
            ? req.body.extensionId
            : undefined,
        errorCode: "VALIDATION_ERROR",
        message: "Invalid confirm-token payload",
        correlationId: getCorrelationId(req.headers as Record<string, unknown>),
      });
      res.status(400).json({
        success: false,
        message: "Validation error",
        errors: error.flatten().fieldErrors,
      });
      return;
    }
    console.error(`[API] confirm-token UNEXPECTED ERROR:`, error);
    throw error;
  }
});

export default router;
