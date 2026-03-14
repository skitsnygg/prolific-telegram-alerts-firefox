import { env } from "./env.js";

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

export async function sendTelegramMessage(chatId: string, text: string) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to send Telegram message to ${chatId}:`, error);
    throw new Error(`Telegram API error: ${response.status}`);
  }

  return response.json();
}

export function formatStudyNotification(study: {
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  postedAt: string;
  mobileSupported?: boolean;
}) {
  const lines = [
    `🔬 <b>New Study Available!</b>`,
    ``,
    `💰 <b>Reward:</b> ${study.reward}`,
  ];

  if (study.completionTime) {
    lines.push(`⏱ <b>Time:</b> ${study.completionTime}`);
  }

  if (study.places) {
    lines.push(`👥 <b>Places:</b> ${study.places}`);
  }

  lines.push(`📋 <b>Title:</b> ${study.title}`);

  if (study.mobileSupported) {
    lines.push(`📱 <b>Mobile supported</b> — <a href="${study.url}">open</a>`);
  }

  return lines.join("\n");
}

export function formatStudyReappeared(study: {
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  postedAt: string;
  mobileSupported?: boolean;
}) {
  const lines = [
    `🔄 <b>Study Re-appeared!</b>`,
    ``,
    `💰 <b>Reward:</b> ${study.reward}`,
  ];

  if (study.completionTime) {
    lines.push(`⏱ <b>Time:</b> ${study.completionTime}`);
  }

  if (study.places) {
    lines.push(`👥 <b>Places:</b> ${study.places}`);
  }

  lines.push(`📋 <b>Title:</b> ${study.title}`);

  if (study.mobileSupported) {
    lines.push(`📱 <b>Mobile supported</b> — <a href="${study.url}">open</a>`);
  }

  return lines.join("\n");
}

export function formatStudiesSummary(
  totalNew: number,
  topStudies: {
    title: string;
    reward: string;
    completionTime?: string | null;
    places?: string | null;
    url: string;
    mobileSupported?: boolean;
  }[],
  options?: {
    reappeared?: boolean;
  },
) {
  const isReappeared = options?.reappeared === true;
  const lines = [
    isReappeared
      ? `🔄 <b>${totalNew} Re-appeared Studies Available!</b>`
      : `📊 <b>${totalNew} New Studies Available!</b>`,
    ``,
  ];

  for (let i = 0; i < topStudies.length; i++) {
    const study = topStudies[i]!;
    if (i > 0) lines.push(``); // empty line between studies

    lines.push(`💰 ${study.reward}`);
    if (study.completionTime) {
      lines.push(`⏱ ${study.completionTime}`);
    }
    if (study.places) {
      lines.push(`👥 ${study.places}`);
    }
    lines.push(`📋 ${study.title}`);
    if (study.mobileSupported) {
      lines.push(`📱 Mobile supported — <a href="${study.url}">open</a>`);
    }
  }

  const remaining = totalNew - topStudies.length;
  if (remaining > 0) {
    lines.push(``);
    lines.push(`<i>…and ${remaining} more</i>`);
  }

  return lines.join("\n");
}
