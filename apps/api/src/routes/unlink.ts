import { Router, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";
import { auditLog, getCorrelationId } from "../lib/audit-log.js";

const router: RouterType = Router();

/**
 * POST /api/unlink
 *
 * Unlinks the extension from a user's account.
 * Accepts `telegramId` (from the bot).
 */
router.post("/unlink", async (req, res) => {
  try {
    const correlationId = getCorrelationId(
      req.headers as Record<string, unknown>,
    );
    const { telegramId } = req.body;

    if (!telegramId || typeof telegramId !== "string") {
      res.status(400).json({
        success: false,
        message: "telegramId is required.",
      });
      return;
    }

    console.log(`[API] POST /api/unlink — telegramId=${telegramId}`);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId));

    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found.",
      });
      return;
    }

    await db
      .update(users)
      .set({ extensionInstallId: `pending-${telegramId}` })
      .where(eq(users.id, user.id));

    console.log(`[API] User ${user.id} unlinked.`);
    auditLog({
      eventType: "EXTENSION_UNLINK_COMMAND",
      success: true,
      userId: user.id,
      telegramId,
      extensionId: user.extensionInstallId,
      correlationId,
    });

    res.json({
      success: true,
      message: "Extension unlinked.",
    });
  } catch (error) {
    console.error("[API] Error in /api/unlink:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

export default router;
