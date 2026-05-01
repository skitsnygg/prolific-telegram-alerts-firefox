import { env } from "./env.js";

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

type SupportedDevice = "Desktop" | "Tablet" | "Mobile";
type Provider = "prolific" | "cloudresearch";

type ProviderStudy = {
  provider?: Provider;
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  postedAt?: string;
  supportedDevices?: SupportedDevice[];
  mobileSupported?: boolean;
};

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

function getProvider(study: { provider?: Provider }): Provider {
  return study.provider ?? "prolific";
}

function getNewHeader(provider: Provider): string {
  return provider === "cloudresearch"
    ? `☁️ <b>New CloudResearch Connect Project</b>`
    : `🔬 <b>New Study Available!</b>`;
}

function getReappearedHeader(provider: Provider): string {
  return provider === "cloudresearch"
    ? `🔄 <b>CloudResearch Connect Project Re-appeared</b>`
    : `🔄 <b>Study Re-appeared!</b>`;
}

function getSummaryHeader(
  provider: Provider,
  totalNew: number,
  reappeared: boolean,
): string {
  if (provider === "cloudresearch") {
    const noun = totalNew === 1 ? "Project" : "Projects";
    return reappeared
      ? `🔄 <b>${totalNew} CloudResearch Connect ${noun} Re-appeared</b>`
      : `📊 <b>${totalNew} New CloudResearch Connect ${noun}</b>`;
  }

  return reappeared
    ? `🔄 <b>${totalNew} Re-appeared Studies Available!</b>`
    : `📊 <b>${totalNew} New Studies Available!</b>`;
}

function getTitleLabel(provider: Provider): string {
  return provider === "cloudresearch" ? "Project" : "Title";
}

function getRewardLabel(provider: Provider): string {
  return provider === "cloudresearch" ? "Payment" : "Reward";
}

function getTimeLabel(provider: Provider): string {
  return provider === "cloudresearch" ? "Estimated time" : "Time";
}

function getPlacesLabel(provider: Provider): string {
  return provider === "cloudresearch" ? "Spots" : "Places";
}

function formatProviderLink(provider: Provider, url: string): string[] {
  const safeUrl = escapeHtml(url);
  return [
    `🔗 <b>${provider === "cloudresearch" ? "Open project" : "Open study"}:</b>`,
    `<a href="${safeUrl}">${safeUrl}</a>`,
  ];
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
    console.error(`Failed to send Telegram message:`, error);
    throw new Error(`Telegram API error: ${response.status}`);
  }

  return response.json();
}

export function formatStudyNotification(study: ProviderStudy) {
  const provider = getProvider(study);
  const lines = [
    getNewHeader(provider),
    ``,
    `📋 <b>${getTitleLabel(provider)}:</b> ${escapeHtml(study.title)}`,
    `💰 <b>${getRewardLabel(provider)}:</b> ${escapeHtml(study.reward)}`,
  ];

  if (study.completionTime) {
    lines.push(
      `⏱ <b>${getTimeLabel(provider)}:</b> ${escapeHtml(study.completionTime)}`,
    );
  }

  if (study.places) {
    lines.push(
      `👥 <b>${getPlacesLabel(provider)}:</b> ${escapeHtml(study.places)}`,
    );
  }

  const devicesLine = formatDevicesLine(study);
  if (devicesLine) {
    lines.push(devicesLine);
  }

  lines.push(``);
  lines.push(...formatProviderLink(provider, study.url));

  return lines.join("\n");
}

export function formatStudyReappeared(study: ProviderStudy) {
  const provider = getProvider(study);
  const lines = [
    getReappearedHeader(provider),
    ``,
    `📋 <b>${getTitleLabel(provider)}:</b> ${escapeHtml(study.title)}`,
    `💰 <b>${getRewardLabel(provider)}:</b> ${escapeHtml(study.reward)}`,
  ];

  if (study.completionTime) {
    lines.push(
      `⏱ <b>${getTimeLabel(provider)}:</b> ${escapeHtml(study.completionTime)}`,
    );
  }

  if (study.places) {
    lines.push(
      `👥 <b>${getPlacesLabel(provider)}:</b> ${escapeHtml(study.places)}`,
    );
  }

  const devicesLine = formatDevicesLine(study);
  if (devicesLine) {
    lines.push(devicesLine);
  }

  lines.push(``);
  lines.push(...formatProviderLink(provider, study.url));

  return lines.join("\n");
}

export function formatStudiesSummary(
  provider: Provider,
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
    getSummaryHeader(provider, totalNew, isReappeared),
    ``,
  ];

  for (let i = 0; i < topStudies.length; i++) {
    const study = topStudies[i]!;
    if (i > 0) lines.push(``); // empty line between studies

    lines.push(`📋 <b>${getTitleLabel(provider)}:</b> ${escapeHtml(study.title)}`);
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
    lines.push(...formatProviderLink(provider, study.url));
  }

  const remaining = totalNew - topStudies.length;
  if (remaining > 0) {
    lines.push(``);
    lines.push(`<i>…and ${remaining} more</i>`);
  }

  return lines.join("\n");
}
