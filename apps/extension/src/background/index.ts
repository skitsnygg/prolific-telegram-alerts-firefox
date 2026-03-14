import { getExtensionId } from "../lib/storage.js";
import {
  checkStatus,
  notifyStudy,
  notifyStudyReappeared,
  notifyReappearedSummary,
  notifySummary,
} from "../lib/api.js";
import {
  updateStatus,
  getLinkedState,
  clearLinkedState,
  getBeepEnabled,
} from "../lib/storage.js";
import { STATUS_CHECK_INTERVAL_HOURS, API_BASE_URL } from "../config.js";

const LOG = "[Prolific Alerts][BG]";
const STATUS_ALARM_NAME = "status-check";

/**
 * Play the beep alert sound via an offscreen document.
 * Service workers cannot use AudioContext directly, so we create
 * an offscreen document that owns the audio context.
 */
async function playBeepViaOffscreen(): Promise<void> {
  try {
    // Ensure the offscreen document exists (no-op if already created)
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: ["AUDIO_PLAYBACK" as chrome.offscreen.Reason],
        justification: "Play beep alert sound for new study notification",
      });
      // Wait briefly for the offscreen document's script to load and
      // register its onMessage listener — createDocument resolves when
      // the document is created, not when its scripts have executed.
      await new Promise((r) => setTimeout(r, 150));
    }
    // Tell the offscreen document to play the beep
    chrome.runtime.sendMessage({ type: "PLAY_BEEP" });
  } catch (err) {
    console.warn(`${LOG} ⚠️ Could not play beep via offscreen:`, err);
  }
}

/** Prolific URL patterns matching the manifest content_scripts. */
const PROLIFIC_URLS = [
  "https://www.prolific.com/*",
  "https://app.prolific.com/*",
  "file:///*test-page*",
];

/**
 * Inject the content script into any already-open Prolific tabs.
 * Called on install/update so users don't need to manually refresh.
 */
async function injectIntoExistingTabs(): Promise<void> {
  console.log(
    `${LOG} 🔌 Injecting content script into existing Prolific tabs...`,
  );
  try {
    const tabs = await chrome.tabs.query({ url: PROLIFIC_URLS });
    console.log(
      `${LOG} 🔌 Found ${tabs.length} existing Prolific tab(s) to inject into`,
    );
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
        });
        console.log(
          `${LOG} ✅ Injected content script into tab ${tab.id}: ${tab.url}`,
        );
      } catch (err) {
        // Tab may be discarded, crashed, or URL restricted — skip it.
        console.warn(`${LOG} ❌ Could not inject into tab ${tab.id}:`, err);
      }
    }
  } catch (err) {
    console.warn(`${LOG} ❌ Failed to query tabs for injection:`, err);
  }
}

/**
 * Background service worker for the Prolific Alerts extension.
 *
 * Responsibilities:
 * - Generates/persists a unique extension install ID on first install.
 * - Periodically checks the user's status via the API.
 * - Listens for messages from content scripts about detected studies.
 */

// On install: generate extension ID and set up alarms
chrome.runtime.onInstalled.addListener(async () => {
  console.log(`${LOG} 🚀 onInstalled event fired`);
  const extensionId = await getExtensionId();
  console.log(`${LOG} 🆔 Extension installed, ID: ${extensionId}`);

  // Set uninstall URL so the API can auto-reset extension_install_id
  const uninstallUrl = `${API_BASE_URL}/api/unlink-extension?extensionId=${encodeURIComponent(extensionId)}`;
  chrome.runtime.setUninstallURL(uninstallUrl);
  console.log(`${LOG} 🗑️ Uninstall URL set`);

  // Set up periodic status check (every 3 hours)
  console.log(
    `${LOG} ⏰ Creating status-check alarm (every ${STATUS_CHECK_INTERVAL_HOURS}h)`,
  );
  chrome.alarms.create(STATUS_ALARM_NAME, {
    periodInMinutes: STATUS_CHECK_INTERVAL_HOURS * 60,
  });

  // Run status check immediately on install
  console.log(`${LOG} 🔑 Running initial status check...`);
  await performStatusCheck();

  // Inject content script into already-open Prolific tabs
  await injectIntoExistingTabs();
  console.log(`${LOG} 🚀 onInstalled setup complete`);
});

// On every service worker startup: ensure alarms exist and run a status check
chrome.runtime.onStartup.addListener(async () => {
  console.log(`${LOG} 🚀 onStartup event fired — service worker started`);

  // Re-create alarms (they persist across restarts, but ensure they exist)
  chrome.alarms.get(STATUS_ALARM_NAME, (alarm) => {
    if (!alarm) {
      console.log(
        `${LOG} ⏰ Status alarm missing, recreating (every ${STATUS_CHECK_INTERVAL_HOURS}h)`,
      );
      chrome.alarms.create(STATUS_ALARM_NAME, {
        periodInMinutes: STATUS_CHECK_INTERVAL_HOURS * 60,
      });
    } else {
      console.log(
        `${LOG} ⏰ Status alarm already exists, next fire: ${new Date(alarm.scheduledTime).toISOString()}`,
      );
    }
  });

  // Run status check immediately on startup
  console.log(`${LOG} 🔑 Running startup status check...`);
  await performStatusCheck();
  console.log(`${LOG} 🚀 onStartup setup complete`);
});

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(
    `${LOG} ⏰ Alarm fired: "${alarm.name}" at ${new Date().toISOString()}`,
  );
  if (alarm.name === STATUS_ALARM_NAME) {
    console.log(`${LOG} 🔑 Starting periodic status check...`);
    await performStatusCheck();
    console.log(`${LOG} 🔑 Periodic status check complete`);
  }
});

/**
 * Check the user's status from the API and update local storage.
 */
async function performStatusCheck() {
  console.log(`${LOG} 🔑 performStatusCheck() — start`);
  try {
    const extensionVersion = chrome.runtime.getManifest().version;
    const state = await getLinkedState();
    console.log(
      `${LOG} 🔑 Current state: isLinked=${state.isLinked}, isActive=${state.isActive}, extensionId=${state.extensionId?.slice(0, 8)}...`,
    );

    if (!state.isLinked || !state.extensionId) {
      console.log(`${LOG} 🔑 User not linked — skipping status check`);
      return;
    }

    console.log(
      `${LOG} 🔑 Calling /api/status for extensionId=${state.extensionId.slice(0, 8)}...`,
    );
    const response = await checkStatus(state.extensionId, extensionVersion);
    console.log(
      `${LOG} 🔑 Status API response: statusCode=${response.statusCode}, success=${response.success}`,
    );

    // If user not found (deleted from database), clear stored state
    if (response.statusCode === 404) {
      console.log(`${LOG} ⚠️ User not found in database (404), clearing state`);
      await clearLinkedState();
      chrome.notifications.create("user-deleted", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Prolific Alerts — Reactivation Required",
        message:
          "Your account was removed. Please open the extension to link again.",
      });
      return;
    }

    if (response.success && response.data) {
      const { isActive } = response.data;
      console.log(`${LOG} 🔑 Status: isActive=${isActive}`);

      await updateStatus({
        isActive,
      });
      console.log(`${LOG} 🔑 Local storage updated with latest status`);

      // Update badge based on active state
      if (isActive) {
        chrome.action.setBadgeText({ text: "" });
      } else {
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
      }

      // If account became inactive, show a notification
      if (!isActive && state.isActive) {
        console.log(
          `${LOG} ⚠️ Account transitioned to INACTIVE — showing reactivation notification`,
        );
        chrome.notifications.create("account-inactive", {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Prolific Alerts — Reactivation Required",
          message: "Your account is currently inactive.",
        });
      }
    } else {
      console.warn(
        `${LOG} ⚠️ Status check returned non-success: ${response.message}`,
      );
    }
  } catch (error) {
    console.error(`${LOG} ❌ Status check failed:`, error);
  }
  console.log(`${LOG} 🔑 performStatusCheck() — end`);
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log(
    `${LOG} 📨 Message received: type=${message.type}`,
    message.type === "STUDY_DETECTED" || message.type === "STUDY_REAPPEARED"
      ? `study="${message.study?.title}"`
      : message.type === "STUDIES_SUMMARY" ||
          message.type === "STUDIES_REAPPEARED_SUMMARY"
        ? `count=${message.summary?.totalNew}`
        : "",
  );

  if (message.type === "STUDY_DETECTED") {
    handleStudyDetected(message.study)
      .then((result) => {
        console.log(
          `${LOG} 📤 Study handled, responding:`,
          JSON.stringify(result),
        );
        sendResponse(result);
      })
      .catch((error) => {
        console.error(`${LOG} ❌ Study handling error:`, error);
        sendResponse({ success: false, error: String(error) });
      });
    return true;
  }

  if (message.type === "STUDY_REAPPEARED") {
    handleStudyReappeared(message.study)
      .then((result) => {
        console.log(
          `${LOG} 📤 Reappeared study handled, responding:`,
          JSON.stringify(result),
        );
        sendResponse(result);
      })
      .catch((error) => {
        console.error(`${LOG} ❌ Reappeared study handling error:`, error);
        sendResponse({ success: false, error: String(error) });
      });
    return true;
  }

  if (message.type === "STUDIES_SUMMARY") {
    handleStudiesSummary(message.summary)
      .then((result) => {
        console.log(
          `${LOG} 📤 Summary handled, responding:`,
          JSON.stringify(result),
        );
        sendResponse(result);
      })
      .catch((error) => {
        console.error(`${LOG} ❌ Summary handling error:`, error);
        sendResponse({ success: false, error: String(error) });
      });
    return true;
  }

  if (message.type === "STUDIES_REAPPEARED_SUMMARY") {
    handleStudiesReappearedSummary(message.summary)
      .then((result) => {
        console.log(
          `${LOG} 📤 Reappeared summary handled, responding:`,
          JSON.stringify(result),
        );
        sendResponse(result);
      })
      .catch((error) => {
        console.error(`${LOG} ❌ Reappeared summary handling error:`, error);
        sendResponse({ success: false, error: String(error) });
      });
    return true;
  }
});

// ── Message handlers ────────────────────────────────────────────────────────

interface StudyPayload {
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  postedAt: string;
  mobileSupported: boolean;
}

interface SummaryStudyPayload {
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  mobileSupported: boolean;
}

interface SummaryPayload {
  totalNew: number;
  topStudies: SummaryStudyPayload[];
}

/**
 * Handle a new study detected by the content script.
 */
async function handleStudyDetected(study: StudyPayload) {
  console.log(
    `${LOG} 📋 handleStudyDetected(): "${study.title}" — ${study.reward}`,
  );
  const extensionId = await getExtensionId();

  console.log(`${LOG} 📋 Calling /api/notify-study for "${study.title}"...`);
  const response = await notifyStudy(extensionId, study);
  console.log(
    `${LOG} 📋 notify-study response: success=${response.success}, deduplicated=${response.data?.deduplicated}`,
  );

  if (response.success && !response.data?.deduplicated) {
    console.log(`${LOG} 🔔 Showing Chrome notification for "${study.title}"`);
    chrome.notifications.create(`study-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "New Prolific Study!",
      message: `${study.title} — ${study.reward}`,
    });

    const beepOn = await getBeepEnabled();
    if (beepOn) {
      await playBeepViaOffscreen();
    }
  } else if (response.data?.deduplicated) {
    console.log(
      `${LOG} ♻️ Study "${study.title}" was deduplicated server-side`,
    );
  }

  return response;
}

/**
 * Handle a re-appeared study.
 */
async function handleStudyReappeared(study: StudyPayload) {
  console.log(
    `${LOG} 🔄 handleStudyReappeared(): "${study.title}" — ${study.reward}`,
  );
  const extensionId = await getExtensionId();

  const response = await notifyStudyReappeared(extensionId, study);
  console.log(
    `${LOG} 🔄 notify-study (reappeared) response: success=${response.success}`,
  );

  if (response.success) {
    console.log(
      `${LOG} 🔔 Showing Chrome notification for re-appeared "${study.title}"`,
    );
    chrome.notifications.create(`study-reappeared-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "🔄 Study Re-appeared!",
      message: `${study.title} — ${study.reward}`,
    });

    const beepOn = await getBeepEnabled();
    if (beepOn) {
      await playBeepViaOffscreen();
    }
  }

  return response;
}

/**
 * Handle a batch summary of new studies.
 */
async function handleStudiesSummary(summary: SummaryPayload) {
  console.log(
    `${LOG} 📊 handleStudiesSummary(): ${summary.totalNew} studies, top ${summary.topStudies.length} included`,
  );
  const extensionId = await getExtensionId();

  const response = await notifySummary(extensionId, summary);
  console.log(`${LOG} 📊 notify-summary response: success=${response.success}`);

  if (response.success) {
    const bestTitle = summary.topStudies[0]?.title ?? "N/A";
    const bestReward = summary.topStudies[0]?.reward ?? "";
    chrome.notifications.create(`studies-summary-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "📊 New Studies Available!",
      message: `${summary.totalNew} new studies. Best: ${bestTitle} — ${bestReward}`,
    });

    const beepOn = await getBeepEnabled();
    if (beepOn) {
      await playBeepViaOffscreen();
    }
  }

  return response;
}

/**
 * Handle a batch summary of re-appeared studies.
 */
async function handleStudiesReappearedSummary(summary: SummaryPayload) {
  console.log(
    `${LOG} 📊 handleStudiesReappearedSummary(): ${summary.totalNew} studies, top ${summary.topStudies.length} included`,
  );
  const extensionId = await getExtensionId();

  const response = await notifyReappearedSummary(extensionId, summary);
  console.log(
    `${LOG} 📊 notify-summary (reappeared) response: success=${response.success}`,
  );

  if (response.success) {
    const bestTitle = summary.topStudies[0]?.title ?? "N/A";
    const bestReward = summary.topStudies[0]?.reward ?? "";
    chrome.notifications.create(`studies-reappeared-summary-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "🔄 Re-appeared Studies!",
      message: `${summary.totalNew} re-appeared studies. Best: ${bestTitle} — ${bestReward}`,
    });

    const beepOn = await getBeepEnabled();
    if (beepOn) {
      await playBeepViaOffscreen();
    }
  }

  return response;
}
