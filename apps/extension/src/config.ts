/** API base URL */
export const API_BASE_URL = "https://example.com";

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
} as const;
