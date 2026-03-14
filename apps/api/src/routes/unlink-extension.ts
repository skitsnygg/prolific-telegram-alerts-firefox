import { Router, type Router as RouterType } from "express";
import { eq, or } from "drizzle-orm";
import { users } from "@prolific-alerts/database";
import { db } from "../db.js";
import { auditLog, getCorrelationId } from "../lib/audit-log.js";

const router: RouterType = Router();
const VALID_UNINSTALL_REASONS = [
  "bug",
  "cost",
  "too_many_notifications",
  "too_few_notifications",
  "no_longer_needed",
] as const;

type UninstallReason = (typeof VALID_UNINSTALL_REASONS)[number];

function isUninstallReason(value: unknown): value is UninstallReason {
  return (
    typeof value === "string" &&
    VALID_UNINSTALL_REASONS.includes(value as UninstallReason)
  );
}

function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, 1000);
}

router.post("/uninstall-feedback", async (req, res) => {
  const { extensionId, reason, message } = req.body as {
    extensionId?: unknown;
    reason?: unknown;
    message?: unknown;
  };

  if (typeof extensionId !== "string" || !extensionId) {
    res.status(400).json({
      success: false,
      message: "Missing extensionId",
    });
    return;
  }

  if (!isUninstallReason(reason)) {
    res.status(400).json({
      success: false,
      message: "Invalid uninstall reason",
    });
    return;
  }

  const reasonMessage = sanitizeMessage(message);

  // We look for either the exact extensionId OR the pending- version since
  // the uninstallation flow already set it to pending-[extensionId]
  const targetExtensionId = extensionId;
  const pendingExtensionId = `pending-${extensionId}`;

  try {
    const updatedRows = await db
      .update(users)
      .set({
        uninstallReason: reason,
        uninstallReasonMessage: reasonMessage,
      })
      .where(
        or(
          eq(users.extensionInstallId, pendingExtensionId),
          eq(users.extensionInstallId, targetExtensionId),
        ),
      )
      .returning({ id: users.id });

    if (updatedRows.length === 0) {
      res.status(404).json({
        success: false,
        message: "User not found for that extensionId",
      });
      return;
    }

    res.json({
      success: true,
      message: "Feedback saved",
    });
  } catch (error) {
    console.error("[API] Error in /api/uninstall-feedback:", error);
    res.status(500).json({
      success: false,
      message: "Unable to save feedback",
    });
  }
});

/**
 * GET /api/unlink-extension
 *
 * Called automatically when a user uninstalls the Chrome extension
 * (via chrome.runtime.setUninstallURL). Resets extension_install_id so
 * the user can re-link without manually sending /unlink in the bot.
 *
 * Accepts `extensionId` as a query parameter.
 * Returns a simple HTML page (this is opened in a browser tab on uninstall).
 */
router.get("/unlink-extension", async (req, res) => {
  const extensionId = req.query.extensionId as string | undefined;
  const correlationId = getCorrelationId(
    req.headers as Record<string, unknown>,
  );

  if (!extensionId || typeof extensionId !== "string") {
    res.status(400).send("<h1>Invalid request</h1>");
    return;
  }

  console.log(
    `[API] GET /api/unlink-extension — extensionId=${extensionId.slice(0, 12)}...`,
  );

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.extensionInstallId, extensionId));

    if (user) {
      await db
        .update(users)
        .set({
          extensionInstallId: `pending-${extensionId}`,
        })
        .where(eq(users.id, user.id));

      console.log(
        `[API] Extension auto-unlinked for user ${user.id} on uninstall`,
      );
      auditLog({
        eventType: "EXTENSION_UNLINK_UNINSTALL",
        success: true,
        userId: user.id,
        telegramId: user.telegramId ?? undefined,
        extensionId,
        correlationId,
      });
    } else {
      console.log(`[API] No user found for extensionId — nothing to unlink`);
    }

    const jsExtensionId = extensionId ?? "";

    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'",
    );

    res.send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Extension Uninstalled</title>
    <style>
      :root {
        color-scheme: light;
      }

      body {
        margin: 0;
        padding: 24px;
        font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: #f7f7fb;
        color: #111827;
      }

      .card {
        max-width: 560px;
        margin: 0 auto;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        box-shadow: 0 6px 18px rgba(17, 24, 39, 0.06);
        padding: 24px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }

      p {
        margin: 0 0 16px;
        line-height: 1.45;
        color: #374151;
      }

      .survey-title {
        margin: 20px 0 12px;
        font-size: 16px;
        font-weight: 600;
      }

      .option {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        margin-bottom: 10px;
        cursor: pointer;
      }

      .option:hover {
        border-color: #d1d5db;
        background: #fdfdfd;
      }

      .option input {
        cursor: pointer;
        margin-top: 3px;
      }

      .option label {
        cursor: pointer;
        width: 100%;
        user-select: none;
      }

      .bug-details {
        margin-top: 12px;
        display: none;
      }

      textarea {
        width: 100%;
        min-height: 96px;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        padding: 10px;
        font: inherit;
        box-sizing: border-box;
        resize: vertical;
      }

      button {
        margin-top: 10px;
        border: 0;
        background: #111827;
        color: #ffffff;
        border-radius: 10px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }

      button:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }

      .status {
        margin-top: 10px;
        min-height: 20px;
        font-size: 14px;
        color: #4b5563;
      }

      .footer {
        margin-top: 20px;
        font-size: 14px;
        color: #4b5563;
      }

      .footer b {
        color: #111827;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Extension uninstalled</h1>
      <p>Your extension has been unlinked. Thank you for trying Prolific Alerts.</p>

      <div class="survey-title">Quick question: why are you leaving?</div>

      <div class="option">
        <input id="reason-bug" type="radio" name="reason" value="bug" />
        <label for="reason-bug">Bug (something is not working right)</label>
      </div>
      <div class="option">
        <input id="reason-cost" type="radio" name="reason" value="cost" />
        <label for="reason-cost">Not useful enough for me</label>
      </div>
      <div class="option">
        <input id="reason-notifications-few" type="radio" name="reason" value="too_few_notifications" />
        <label for="reason-notifications-few">Too few task notifications</label>
      </div>
      <div class="option">
        <input id="reason-notifications-many" type="radio" name="reason" value="too_many_notifications" />
        <label for="reason-notifications-many">Too many task notifications</label>
      </div>
      <div class="option">
        <input id="reason-need" type="radio" name="reason" value="no_longer_needed" />
        <label for="reason-need">I no longer need it</label>
      </div>

      <div id="bug-details" class="bug-details">
        <textarea id="bug-message" placeholder="What went wrong?"></textarea>
        <button id="bug-save" type="button">Send details</button>
      </div>

      <div id="status" class="status"></div>

      <p class="footer">If you reinstall later, use <b>/token</b> in Telegram to link again.</p>
    </main>

    <script>
      const extensionId = ${JSON.stringify(jsExtensionId)};
      const bugDetails = document.getElementById("bug-details");
      const bugMessage = document.getElementById("bug-message");
      const bugSave = document.getElementById("bug-save");
      const status = document.getElementById("status");
      const reasonInputs = document.querySelectorAll('input[name="reason"]');
      const options = document.querySelectorAll('.option');

      // Make the entire option div clickable
      options.forEach((option) => {
        option.addEventListener('click', (e) => {
          if (e.target.tagName !== 'INPUT') {
            const input = option.querySelector('input');
            if (input && !input.checked) {
              input.checked = true;
              input.dispatchEvent(new Event('change'));
            }
          }
        });
      });

      async function saveFeedback(reason, message) {
        if (!extensionId) {
          console.warn("Missing extensionId! Sending request anyway to demonstrate network activity.");
        }

        const response = await fetch("/api/uninstall-feedback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            extensionId,
            reason,
            message,
          }),
        });

        if (!response.ok) {
          throw new Error("save_failed_" + response.status);
        }
        return response.json();
      }

      reasonInputs.forEach((input) => {
        input.addEventListener("change", async (event) => {
          if (!event.target.checked) return;
          
          const selectedReason = event.target.value;
          const isBug = selectedReason === "bug";

          bugDetails.style.display = isBug ? "block" : "none";

          try {
            await saveFeedback(selectedReason, null);
            status.textContent = isBug
              ? "Thanks — reason saved. Please share what went wrong below."
              : "Thanks for your feedback.";
          } catch (err) {
            console.error("Survey save error:", err);
            status.textContent = "Could not save feedback right now. (Testing? You might be already unlinked)";
          }
        });
      });

      bugSave.addEventListener("click", async () => {
        const message = bugMessage.value.trim();

        if (!message) {
          status.textContent = "Please add a short message about the bug.";
          return;
        }

        bugSave.disabled = true;
        try {
          await saveFeedback("bug", message);
          status.textContent = "Thanks — bug details saved.";
        } catch (err) {
          console.error("Bug details save error:", err);
          status.textContent = "Could not save bug details right now. (Testing? You might be already unlinked)";
        } finally {
          bugSave.disabled = false;
        }
      });
    </script>
  </body>
</html>`);
  } catch (error) {
    console.error("[API] Error in /api/unlink-extension:", error);
    res.status(500).send("<h1>Something went wrong</h1>");
  }
});

export default router;
