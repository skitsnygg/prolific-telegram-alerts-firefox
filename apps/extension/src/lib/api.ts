import { API_BASE_URL } from "../config.js";
import { runtime } from "./browser.js";

const LOG = "[Prolific Alerts][API]";

interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: Record<string, string[]>;
  statusCode?: number;
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

async function apiRequest<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${endpoint}`;
  console.log(`${LOG} ➔ POST ${url}`, JSON.stringify(body));
  try {
    const startTime = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as ApiResponse<T>;
    // Include HTTP status code in the response
    data.statusCode = response.status;
    const elapsed = Math.round(performance.now() - startTime);
    console.log(
      `${LOG} ⬅ ${response.status} ${endpoint} (${elapsed}ms): success=${data.success}`,
      data.message || "",
    );
    return data;
  } catch (error) {
    // Network error - could not connect to API
    console.error(`${LOG} ❌ Connection error for ${endpoint}:`, error);
    throw new ConnectionError(
      "Unable to connect to the API. The extension may need an update.",
    );
  }
}

/**
 * Confirm a Telegram token and link the extension.
 */
export async function confirmToken(token: string, extensionId: string) {
  console.log(
    `${LOG} 🎫 confirmToken() — token=${token.slice(0, 8)}..., extId=${extensionId.slice(0, 8)}...`,
  );
  return apiRequest<unknown>("/api/confirm-token", { token, extensionId });
}

/**
 * Notify the backend about a detected study.
 */
export async function notifyStudy(
  extensionId: string,
  study: {
    title: string;
    reward: string;
    completionTime?: string | null;
    places?: string | null;
    url: string;
    postedAt: string;
    mobileSupported: boolean;
  },
) {
  console.log(`${LOG} 📢 notifyStudy() — "${study.title}" (${study.reward})`);
  return apiRequest<{ deduplicated: boolean }>("/api/notify-study", {
    extensionId,
    study,
  });
}

/**
 * Notify the backend about a re-appeared study (bypasses server-side dedup).
 */
export async function notifyStudyReappeared(
  extensionId: string,
  study: {
    title: string;
    reward: string;
    completionTime?: string | null;
    places?: string | null;
    url: string;
    postedAt: string;
    mobileSupported: boolean;
  },
) {
  console.log(
    `${LOG} 🔄 notifyStudyReappeared() — "${study.title}" (${study.reward})`,
  );
  return apiRequest<{ deduplicated: boolean }>("/api/notify-study", {
    extensionId,
    study,
    reappeared: true,
  });
}

/**
 * Send a batch summary notification to the backend.
 */
export async function notifySummary(
  extensionId: string,
  summary: {
    totalNew: number;
    topStudies: {
      title: string;
      reward: string;
      completionTime?: string | null;
      places?: string | null;
      url: string;
      mobileSupported: boolean;
    }[];
  },
) {
  const bestTitle = summary.topStudies[0]?.title ?? "N/A";
  console.log(
    `${LOG} 📊 notifySummary() — ${summary.totalNew} studies, best="${bestTitle}"`,
  );
  return apiRequest("/api/notify-summary", {
    extensionId,
    summary,
  });
}

/**
 * Send a batch summary notification for re-appeared studies.
 */
export async function notifyReappearedSummary(
  extensionId: string,
  summary: {
    totalNew: number;
    topStudies: {
      title: string;
      reward: string;
      completionTime?: string | null;
      places?: string | null;
      url: string;
      mobileSupported: boolean;
    }[];
  },
) {
  const bestTitle = summary.topStudies[0]?.title ?? "N/A";
  console.log(
    `${LOG} 📊 notifyReappearedSummary() — ${summary.totalNew} studies, best="${bestTitle}"`,
  );
  return apiRequest("/api/notify-summary", {
    extensionId,
    summary,
    reappeared: true,
  });
}

/**
 * Check the user's account status.
 */
export async function checkStatus(
  extensionId: string,
  extensionVersion: string = runtime.getManifest().version,
) {
  console.log(`${LOG} 📊 checkStatus() — extId=${extensionId.slice(0, 8)}...`);
  const body: Record<string, unknown> = { extensionId, extensionVersion };
  const response = await apiRequest<{
    isActive: boolean;
    telegramLinked: boolean;
  }>("/api/status", body);

  if (response.success && response.data) {
    return {
      ...response,
      data: {
        isActive: response.data.isActive,
        telegramLinked: response.data.telegramLinked,
      },
    };
  }

  return response;
}
