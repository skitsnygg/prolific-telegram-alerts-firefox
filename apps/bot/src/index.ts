import { Bot } from "grammy";
import { env } from "./env.js";
import { db } from "./db.js";
import { users } from "@prolific-alerts/database";
import { eq } from "drizzle-orm";

const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

const ADMIN_TELEGRAM = "@mskd03";

function getFarFutureDate(): Date {
  return new Date("2999-12-31T23:59:59.000Z");
}

async function callUnlink(telegramId: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${env.API_BASE_URL}/api/unlink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegramId }),
    });
    if (!response.ok) return null;
    return true;
  } catch (error) {
    console.error("[BOT] Failed to call /api/unlink:", error);
    return null;
  }
}

bot.command("start", async (ctx) => {
  console.log(
    `[BOT] /start command from user ${ctx.from?.id} (@${ctx.from?.username ?? "unknown"})`,
  );

  const chatId = ctx.from?.id;
  if (!chatId) {
    await ctx.reply(
      "❌ Could not identify your Telegram account. Please try again.",
    );
    return;
  }

  const startParam = ctx.match;

  if (startParam === "token") {
    const telegramId = chatId.toString();

    try {
      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.telegramId, telegramId));

      if (existingUser) {
        if (
          existingUser.extensionInstallId &&
          !existingUser.extensionInstallId.startsWith("pending-")
        ) {
          await ctx.reply(
            `✅ You're already connected!\n` +
              `\n` +
              `Your extension is linked and active.\n` +
              `If you need to re-link a new extension, use /unlink first.`,
            { parse_mode: "HTML" },
          );
          return;
        }

        await ctx.reply(
          `🔑 <b>Welcome back to Prolific Study Alerts!</b>\n` +
            `\n` +
            `🔑 <b>Your activation token:</b>\n` +
            `\n` +
            `<code>${telegramId}</code>\n` +
            `\n` +
            `Tap the token above to copy it, then paste it into the Chrome extension and click <b>Activate</b>.\n` +
            `\n` +
            `Need help? Contact ${ADMIN_TELEGRAM} 💬`,
          { parse_mode: "HTML" },
        );
        return;
      }

      await db.insert(users).values({
        extensionInstallId: `pending-${telegramId}`,
        telegramId,
        telegramUsername: ctx.from?.username ?? null,
        primaryWindowEndsAt: getFarFutureDate(),
      });

      await ctx.reply(
        `🔑 <b>Welcome to Prolific Study Alerts!</b>\n` +
          `\n` +
          `I'll notify you instantly when new studies appear on Prolific. 🔔\n` +
          `\n` +
          `🔑 <b>Your activation token:</b>\n` +
          `\n` +
          `<code>${telegramId}</code>\n` +
          `\n` +
          `Tap the token above to copy it, then paste it into the Chrome extension and click <b>Activate</b>.\n` +
          `\n` +
          `Need help? Contact ${ADMIN_TELEGRAM} 💬`,
        { parse_mode: "HTML" },
      );
      return;
    } catch (error) {
      console.error("Error generating token via deep link:", error);
      await ctx.reply("❌ Something went wrong. Please try again later.");
      return;
    }
  }

  await ctx.reply(
    `👋 <b>Welcome to Prolific Study Alerts!</b>\n` +
      `\n` +
      `I'll notify you instantly when new studies appear on Prolific.\n` +
      `\n` +
      `<b>How to get started:</b>\n` +
      `1️⃣ Install the Chrome extension\n` +
      `2️⃣ Type /token here to get your unique token\n` +
      `3️⃣ Paste the token into the extension and click <b>Activate</b>\n` +
      `\n` +
      `Need help? Contact ${ADMIN_TELEGRAM}`,
    { parse_mode: "HTML" },
  );
});

bot.command("token", async (ctx) => {
  const chatId = ctx.from?.id;
  if (!chatId) {
    await ctx.reply(
      "❌ Could not identify your Telegram account. Please try again.",
    );
    return;
  }

  const telegramId = chatId.toString();

  try {
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId));

    if (existingUser) {
      if (
        ctx.from?.username &&
        existingUser.telegramUsername !== ctx.from.username
      ) {
        await db
          .update(users)
          .set({ telegramUsername: ctx.from.username })
          .where(eq(users.id, existingUser.id));
      }

      if (
        existingUser.extensionInstallId &&
        !existingUser.extensionInstallId.startsWith("pending-")
      ) {
        await ctx.reply(
          `✅ You're already connected!\n` +
            `\n` +
            `Your extension is linked and active.\n` +
            `If you need to re-link a new extension, use /unlink first.`,
          { parse_mode: "HTML" },
        );
        return;
      }

      await ctx.reply(
        `🔑 <b>Your token:</b>\n` +
          `\n` +
          `<code>${telegramId}</code>\n` +
          `\n` +
          `Tap the token above to copy it, then paste it into the Chrome extension and click <b>Activate</b>.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    await db.insert(users).values({
      extensionInstallId: `pending-${telegramId}`,
      telegramId,
      telegramUsername: ctx.from?.username ?? null,
      primaryWindowEndsAt: getFarFutureDate(),
    });

    await ctx.reply(
      `🔑 <b>Your token:</b>\n` +
        `\n` +
        `<code>${telegramId}</code>\n` +
        `\n` +
        `Tap the token above to copy it, then paste it into the Chrome extension and click <b>Activate</b>.`,
      { parse_mode: "HTML" },
    );
  } catch (error) {
    console.error("Error generating token:", error);
    await ctx.reply("❌ Something went wrong. Please try again later.");
  }
});

bot.command("unlink", async (ctx) => {
  const chatId = ctx.from?.id;
  if (!chatId) return;

  const telegramId = chatId.toString();
  const result = await callUnlink(telegramId);

  if (result === null) {
    await ctx.reply("❌ Something went wrong. Please try again later.");
    return;
  }

  await ctx.reply(
    `🔄 Extension unlinked.\n\nUse /token to get your token and link a new extension.`,
  );
});

bot.command("reset", async (ctx) => {
  const chatId = ctx.from?.id;
  if (!chatId) return;

  const telegramId = chatId.toString();
  const result = await callUnlink(telegramId);

  if (result === null) {
    await ctx.reply("❌ Something went wrong. Please try again later.");
    return;
  }

  await ctx.reply(
    `🔄 Extension unlinked.\n\nUse /token to get your token and link a new extension.\n\n💡 <i>Tip: You can also use /unlink next time.</i>`,
    { parse_mode: "HTML" },
  );
});

bot.command("status", async (ctx) => {
  const chatId = ctx.from?.id;
  if (!chatId) return;

  const telegramId = chatId.toString();

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId));

    if (!user) {
      await ctx.reply(
        "You don't have an account yet. Use /token to get started.",
      );
      return;
    }

    const isLinked =
      !!user.extensionInstallId &&
      !user.extensionInstallId.startsWith("pending-");

    const lines = [
      `📊 <b>Your Status</b>`,
      ``,
      `🔗 Extension: ${isLinked ? "✅ Linked" : "❌ Not linked"}`,
      `🟢 Access: ✅ Active (free)`,
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error checking status:", error);
    await ctx.reply("❌ Something went wrong. Please try again later.");
  }
});

bot.command("subscribe", async (ctx) => {
  await ctx.reply(
    `✅ Prolific Study Alerts is free.\n\nNo activation is needed. Use /status to check your account.`,
  );
});

bot.command("cancel", async (ctx) => {
  await ctx.reply(
    `✅ Prolific Study Alerts is free.\n\nThere is nothing to cancel.`,
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `<b>Available Commands</b>\n` +
      `\n` +
      `/start — Welcome & setup instructions\n` +
      `/token — Get your linking token\n` +
      `/status — Check your status\n` +
      `/unlink — Unlink extension (to re-link on a new browser)\n` +
      `/help — Show this message\n` +
      `\n` +
      `Need help or have questions? Contact ${ADMIN_TELEGRAM}`,
    { parse_mode: "HTML" },
  );
});

bot.on("message", async (ctx) => {
  await ctx.reply(
    `I don't understand that command. Type /help to see available commands.`,
  );
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`🤖 Bot @${botInfo.username} is running!`);
  },
});
