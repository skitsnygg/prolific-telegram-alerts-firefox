import { env } from "./env.js";

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

type SupportedDevice = "Desktop" | "Tablet" | "Mobile";

function escapeHtml(value: string): string {
  return value
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;");
}

function getSupportedDevices(study: {
  supportedDevices?: SupportedDevice[];
  mobileSupported?: boolean;
}): SupportedDevice[] {
  const canonicalOrder: SupportedDevice[] = ["Desktop", "Tablet", "Mobile"];
  const explicit = study.supportedDevices ?? [];
  const devices = canonicalOrder.filter(
    (device) => explicit.indexOf(device) !== -1,
  );

  if (devices.length > 0) {
    return devices;
  }

  return study.mobileSupported ? ["Mobile"] : [];
}

function formatDevicesLine(study: {
  supportedDevices?: SupportedDevice[];
  mobileSupported?: boolean;
}, boldLabel: boolean = true): string | null {
  const devices = getSupportedDevices(study);
  if (devices.length === 0) return null;
  const label = boldLabel ? `<b>Devices:</b>` : `Devices:`;
  return `💻 ${label} ${devices.map(escapeHtml).join(", ")}`;
}

function formatStudyLink(url: string): string[] {
  const safeUrl = escapeHtml(url);
  return [`🔗 <b>Open study:</b>`, `<a href="${safeUrl}">${safeUrl}</a>`];
}

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
  supportedDevices?: SupportedDevice[];
  mobileSupported?: boolean;
}) {
  const lines = [
    `🔬 <b>New Study Available!</b>`,
    ``,
    `📋 <b>Title:</b> ${escapeHtml(study.title)}`,
    `💰 <b>Reward:</b> ${escapeHtml(study.reward)}`,
  ];

  if (study.completionTime) {
    lines.push(`⏱ <b>Time:</b> ${escapeHtml(study.completionTime)}`);
  }

  if (study.places) {
    lines.push(`👥 <b>Places:</b> ${escapeHtml(study.places)}`);
  }

  const devicesLine = formatDevicesLine(study);
  if (devicesLine) {
    lines.push(devicesLine);
  }

  lines.push(``);
  lines.push(...formatStudyLink(study.url));

  return lines.join("\n");
}

export function formatStudyReappeared(study: {
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  postedAt: string;
  supportedDevices?: SupportedDevice[];
  mobileSupported?: boolean;
}) {
  const lines = [
    `🔄 <b>Study Re-appeared!</b>`,
    ``,
    `📋 <b>Title:</b> ${escapeHtml(study.title)}`,
    `💰 <b>Reward:</b> ${escapeHtml(study.reward)}`,
  ];

  if (study.completionTime) {
    lines.push(`⏱ <b>Time:</b> ${escapeHtml(study.completionTime)}`);
  }

  if (study.places) {
    lines.push(`👥 <b>Places:</b> ${escapeHtml(study.places)}`);
  }

  const devicesLine = formatDevicesLine(study);
  if (devicesLine) {
    lines.push(devicesLine);
  }

  lines.push(``);
  lines.push(...formatStudyLink(study.url));

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
    supportedDevices?: SupportedDevice[];
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

    lines.push(`📋 <b>Title:</b> ${escapeHtml(study.title)}`);
    lines.push(`💰 ${escapeHtml(study.reward)}`);
    if (study.completionTime) {
      lines.push(`⏱ ${escapeHtml(study.completionTime)}`);
    }
    if (study.places) {
      lines.push(`👥 ${escapeHtml(study.places)}`);
    }
    const devicesLine = formatDevicesLine(study, false);
    if (devicesLine) {
      lines.push(devicesLine);
    }
    lines.push(``);
    lines.push(...formatStudyLink(study.url));
  }

  const remaining = totalNew - topStudies.length;
  if (remaining > 0) {
    lines.push(``);
    lines.push(`<i>…and ${remaining} more</i>`);
  }

  return lines.join("\n");
}
