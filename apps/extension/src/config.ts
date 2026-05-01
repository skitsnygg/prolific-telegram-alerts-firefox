/** Default deployed API base URL. Override with VITE_API_BASE_URL for self-hosted builds. */
export const DEFAULT_API_BASE_URL = "https://prolificapi.notifyme.top";

/**
 * API base URL used by the extension at runtime.
 *
 * Keep this in sync with the manifest host permissions by setting the same
 * VITE_API_BASE_URL during build time.
 */
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

/** How often to auto-check account status (in hours) */
export const STATUS_CHECK_INTERVAL_HOURS = 3;

/** Default minimum reward in GBP that triggers a notification. */
export const DEFAULT_MIN_REWARD_GBP = 0;

/** Default minimum number of available places that triggers a notification. */
export const DEFAULT_MIN_PLACES = 1;

/** Fixed GBP → USD conversion rate. */
export const GBP_TO_USD = 1.35;

/** Storage keys */
export const STORAGE_KEYS = {
  EXTENSION_ID: "extensionInstallId",
  TOKEN: "telegramToken",
  IS_LINKED: "isLinked",
  IS_ACTIVE: "isActive",
  MIN_REWARD: "minRewardGbp",
  NOTIFICATIONS_ENABLED: "notificationsEnabled",
  MIN_PLACES: "minPlaces",
  BEEP_ENABLED: "beepEnabled",
  CLOUDRESEARCH_AUTO_REFRESH_ENABLED: "cloudResearchAutoRefreshEnabled",
} as const;
