import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";

const router: RouterType = Router();

const statusSchema = z.object({
  extensionId: z.string().min(1, "Extension ID is required"),
  extensionVersion: z.string().min(1).optional(),
});

/**
 * POST /api/status
 *
 * Check user's access status.
 */
router.post("/status", async (req, res) => {
  try {
    const { extensionId, extensionVersion } = statusSchema.parse(req.body);
    console.log(`[API] POST /api/status — extensionId=${extensionId}`);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.extensionInstallId, extensionId));

    if (!user) {
      console.log(`[API] status FAILED: extensionId=${extensionId} not found`);
      res.status(404).json({
        success: false,
        message: "Extension not registered.",
      });
      return;
    }

    // ── Build update payload ──────────────────────────────────────────────
    const updatePayload: Record<string, unknown> = {
      lastOnline: new Date(),
    };

    if (
      extensionVersion &&
      extensionVersion !== (user.extensionVersion ?? undefined)
    ) {
      updatePayload.extensionVersion = extensionVersion;
    }

    await db.update(users).set(updatePayload).where(eq(users.id, user.id));

    const isActive = true;

    console.log(`[API] status OK: user=${user.id}, active=${isActive}`);
    res.json({
      success: true,
      message: "Account is active.",
      data: {
        isActive,
        telegramLinked: !!user.telegramId,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.log(
        `[API] status VALIDATION ERROR:`,
        error.flatten().fieldErrors,
      );
      res.status(400).json({
        success: false,
        message: "Validation error",
        errors: error.flatten().fieldErrors,
      });
      return;
    }
    console.error(`[API] status UNEXPECTED ERROR:`, error);
    throw error;
  }
});

export default router;
