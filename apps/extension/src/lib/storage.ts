import { v4 } from "./uuid.js";
import {
  STORAGE_KEYS,
  DEFAULT_MIN_REWARD_GBP,
  DEFAULT_MIN_PLACES,
} from "../config.js";
import { storage } from "./browser.js";

const LOG = "[Study Alerts][Storage]";

/**
 * Get or generate a unique extension install ID.
 * This persists across sessions via chrome.storage.local.
 */
export async function getExtensionId(): Promise<string> {
  const result = await storage.local.get(STORAGE_KEYS.EXTENSION_ID);
  if (result[STORAGE_KEYS.EXTENSION_ID]) {
    console.log(
      `${LOG} 🆔 getExtensionId(): existing ID=${(result[STORAGE_KEYS.EXTENSION_ID] as string).slice(0, 8)}...`,
    );
    return result[STORAGE_KEYS.EXTENSION_ID] as string;
  }

  const id = v4();
  await storage.local.set({ [STORAGE_KEYS.EXTENSION_ID]: id });
  console.log(
    `${LOG} 🆕 getExtensionId(): generated new ID=${id.slice(0, 8)}...`,
  );
  return id;
}

/**
 * Save linking state after successful token confirmation.
 */
export async function saveLinkedState(data: { token: string }) {
  console.log(`${LOG} 💾 saveLinkedState(): persisting linked state`);
  await storage.local.set({
    [STORAGE_KEYS.TOKEN]: data.token,
    [STORAGE_KEYS.IS_LINKED]: true,
    [STORAGE_KEYS.IS_ACTIVE]: true,
  });
  console.log(`${LOG} 💾 saveLinkedState(): done`);
}

/**
 * Get the current linked state from storage.
 */
export async function getLinkedState() {
  console.log(`${LOG} 📖 getLinkedState(): reading...`);
  const result = await storage.local.get([
    STORAGE_KEYS.IS_LINKED,
    STORAGE_KEYS.IS_ACTIVE,
    STORAGE_KEYS.EXTENSION_ID,
  ]);

  const state = {
    isLinked: result[STORAGE_KEYS.IS_LINKED] as boolean | undefined,
    isActive: result[STORAGE_KEYS.IS_ACTIVE] as boolean | undefined,
    extensionId: result[STORAGE_KEYS.EXTENSION_ID] as string | undefined,
  };
  console.log(
    `${LOG} 📖 getLinkedState(): isLinked=${state.isLinked}, isActive=${state.isActive}`,
  );
  return state;
}

/**
 * Update status from API response.
 */
export async function updateStatus(data: { isActive: boolean }) {
  console.log(`${LOG} 💾 updateStatus(): isActive=${data.isActive}`);
  await storage.local.set({
    [STORAGE_KEYS.IS_ACTIVE]: data.isActive,
  });
}

/**
 * Get whether notifications are enabled. Defaults to true.
 */
export async function getNotificationsEnabled(): Promise<boolean> {
  const result = await storage.local.get(
    STORAGE_KEYS.NOTIFICATIONS_ENABLED,
  );
  const val = result[STORAGE_KEYS.NOTIFICATIONS_ENABLED];
  const enabled = val === undefined ? true : (val as boolean);
  console.log(`${LOG} 📖 getNotificationsEnabled(): ${enabled}`);
  return enabled;
}

/**
 * Set whether notifications are enabled.
 */
export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  console.log(`${LOG} 💾 setNotificationsEnabled(): ${enabled}`);
  await storage.local.set({
    [STORAGE_KEYS.NOTIFICATIONS_ENABLED]: enabled,
  });
}

/**
 * Get the minimum reward threshold (GBP). Defaults to 0.
 */
export async function getMinReward(): Promise<number> {
  const result = await storage.local.get(STORAGE_KEYS.MIN_REWARD);
  const val = result[STORAGE_KEYS.MIN_REWARD];
  const reward = typeof val === "number" ? val : DEFAULT_MIN_REWARD_GBP;
  console.log(`${LOG} 📖 getMinReward(): £${reward.toFixed(2)}`);
  return reward;
}

/**
 * Set the minimum reward threshold (GBP).
 */
export async function setMinReward(value: number): Promise<void> {
  console.log(`${LOG} 💾 setMinReward(): £${value.toFixed(2)}`);
  await storage.local.set({ [STORAGE_KEYS.MIN_REWARD]: value });
}

/**
 * Get the minimum number of places required to trigger a notification. Defaults to 1.
 */
export async function getMinPlaces(): Promise<number> {
  const result = await storage.local.get(STORAGE_KEYS.MIN_PLACES);
  const val = result[STORAGE_KEYS.MIN_PLACES];
  const places = typeof val === "number" ? val : DEFAULT_MIN_PLACES;
  console.log(`${LOG} 📖 getMinPlaces(): ${places}`);
  return places;
}

/**
 * Set the minimum number of places required to trigger a notification.
 */
export async function setMinPlaces(value: number): Promise<void> {
  console.log(`${LOG} 💾 setMinPlaces(): ${value}`);
  await storage.local.set({ [STORAGE_KEYS.MIN_PLACES]: value });
}

/**
 * Get whether the beep alert sound is enabled. Defaults to true.
 */
export async function getBeepEnabled(): Promise<boolean> {
  const result = await storage.local.get(STORAGE_KEYS.BEEP_ENABLED);
  const val = result[STORAGE_KEYS.BEEP_ENABLED];
  const enabled = val === undefined ? true : (val as boolean);
  console.log(`${LOG} 📖 getBeepEnabled(): ${enabled}`);
  return enabled;
}

/**
 * Set whether the beep alert sound is enabled.
 */
export async function setBeepEnabled(enabled: boolean): Promise<void> {
  console.log(`${LOG} 💾 setBeepEnabled(): ${enabled}`);
  await storage.local.set({ [STORAGE_KEYS.BEEP_ENABLED]: enabled });
}

/**
 * Get whether CloudResearch dashboard auto-refresh is enabled. Defaults to false.
 */
export async function getCloudResearchAutoRefreshEnabled(): Promise<boolean> {
  const result = await storage.local.get(
    STORAGE_KEYS.CLOUDRESEARCH_AUTO_REFRESH_ENABLED,
  );
  const val = result[STORAGE_KEYS.CLOUDRESEARCH_AUTO_REFRESH_ENABLED];
  const enabled = val === undefined ? false : (val as boolean);
  console.log(`${LOG} 📖 getCloudResearchAutoRefreshEnabled(): ${enabled}`);
  return enabled;
}

/**
 * Set whether CloudResearch dashboard auto-refresh is enabled.
 */
export async function setCloudResearchAutoRefreshEnabled(
  enabled: boolean,
): Promise<void> {
  console.log(`${LOG} 💾 setCloudResearchAutoRefreshEnabled(): ${enabled}`);
  await storage.local.set({
    [STORAGE_KEYS.CLOUDRESEARCH_AUTO_REFRESH_ENABLED]: enabled,
  });
}

/**
 * Clear linked state (e.g., when user is deleted from database).
 * Keeps the extension ID but removes all other linking data.
 */
export async function clearLinkedState() {
  console.log(`${LOG} 🗑️ clearLinkedState(): removing linking data`);
  await storage.local.remove([
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.IS_LINKED,
    STORAGE_KEYS.IS_ACTIVE,
  ]);
  console.log(`${LOG} 🗑️ clearLinkedState(): done`);
}
