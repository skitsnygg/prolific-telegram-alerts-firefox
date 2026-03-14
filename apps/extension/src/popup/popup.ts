import {
  getExtensionId,
  saveLinkedState,
  getLinkedState,
  clearLinkedState,
  getMinReward,
  setMinReward,
  getNotificationsEnabled,
  setNotificationsEnabled,
  getMinPlaces,
  setMinPlaces,
  getBeepEnabled,
  setBeepEnabled,
} from "../lib/storage.js";
import { confirmToken, checkStatus, ConnectionError } from "../lib/api.js";
import { updateStatus } from "../lib/storage.js";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const LOG = "[Prolific Alerts][Popup]";

const loadingSection = $("loading");
const connectionErrorSection = $("connection-error");
const onboardingSection = $("onboarding");
const statusSection = $("status");
const tokenInput = $<HTMLInputElement>("token-input");
const confirmBtn = $<HTMLButtonElement>("confirm-btn");
const retryConnectionBtn = $<HTMLButtonElement>("retry-connection-btn");
const errorMessage = $("error-message");
const statusBadge = $("status-badge");
const activeInfo = $("active-info");
const prolificTabWarning = $("prolific-tab-warning");
const settingsSection = $("settings-section");
const minRewardSlider = $<HTMLInputElement>("min-reward-slider");
const minRewardValue = $("min-reward-value");
const notificationsToggle = $<HTMLInputElement>("notifications-toggle");
const minRewardRow = $("min-reward-row");
const minPlacesSlider = $<HTMLInputElement>("min-places-slider");
const minPlacesValue = $("min-places-value");
const minPlacesRow = $("min-places-row");
const beepToggle = $<HTMLInputElement>("beep-toggle");

/**
 * Initialize the popup.
 */
async function init() {
  console.log(`${LOG} 🚀 Popup initializing...`);
  const state = await getLinkedState();
  console.log(
    `${LOG} 🚀 Linked state: isLinked=${state.isLinked}, isActive=${state.isActive}`,
  );

  if (state.isLinked) {
    // User is linked — show status and refresh from API
    console.log(`${LOG} 🔗 User is linked — fetching status from API`);
    await showStatus();
    await loadSettings();
  } else {
    // User is not linked — show onboarding
    console.log(`${LOG} 👋 User not linked — showing onboarding`);
    showSection("onboarding");
  }
  console.log(`${LOG} 🚀 Popup init complete`);
}

/**
 * Show a specific section and hide others.
 */
function showSection(
  section: "loading" | "connection-error" | "onboarding" | "status",
) {
  console.log(`${LOG} 📱 Showing section: "${section}"`);
  loadingSection.classList.toggle("hidden", section !== "loading");
  connectionErrorSection.classList.toggle(
    "hidden",
    section !== "connection-error",
  );
  onboardingSection.classList.toggle("hidden", section !== "onboarding");
  statusSection.classList.toggle("hidden", section !== "status");
}

/**
 * Show error message in onboarding.
 */
function showError(message: string) {
  errorMessage.textContent = message;
  errorMessage.classList.remove("hidden");
}

function hideError() {
  errorMessage.classList.add("hidden");
}

/**
 * Fetch and display current status.
 */
async function showStatus() {
  showSection("loading");
  console.log(`${LOG} 🔄 showStatus() — fetching status from API...`);

  try {
    const extensionId = await getExtensionId();

    console.log(
      `${LOG} 🔄 Calling /api/status for extensionId=${extensionId.slice(0, 8)}...`,
    );
    const response = await checkStatus(extensionId);
    console.log(
      `${LOG} 🔄 Status API response: statusCode=${response.statusCode}, success=${response.success}`,
    );

    // If user not found (404), clear stored state and show onboarding
    if (response.statusCode === 404) {
      console.log(`${LOG} ⚠️ User not found (404), resetting to onboarding`);
      await clearLinkedState();
      showSection("onboarding");
      return;
    }

    if (response.success && response.data) {
      const { isActive } = response.data;
      console.log(`${LOG} 🔄 Status data: isActive=${isActive}`);

      await updateStatus({
        isActive,
      });

      // Sync the extension action badge with current status
      chrome.action.setBadgeText({ text: isActive ? "" : "!" });
      if (!isActive)
        chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });

      if (isActive) {
        statusBadge.textContent = "Active";
        statusBadge.className = "badge active";
        activeInfo.classList.remove("hidden");
        console.log(`${LOG} ✅ User is ACTIVE`);

        // Check if Prolific tab is open
        await checkProlificTab();
      } else {
        statusBadge.textContent = "Inactive";
        statusBadge.className = "badge expired";
        activeInfo.classList.add("hidden");
        prolificTabWarning.classList.add("hidden");
        console.log(`${LOG} ⚠️ User status is INACTIVE`);
      }

      showSection("status");
    } else {
      // Could not fetch status — fall back to stored state
      console.log(
        `${LOG} ⚠️ Status response not successful, falling back to stored state`,
      );
      const state = await getLinkedState();

      if (state.isActive) {
        statusBadge.textContent = "Active";
        statusBadge.className = "badge active";
      } else {
        statusBadge.textContent = "Inactive";
        statusBadge.className = "badge expired";
      }

      showSection("status");
    }
  } catch (error) {
    console.error(`${LOG} ❌ Failed to fetch status:`, error);

    // Check if it's a connection error
    if (error instanceof ConnectionError) {
      console.log(
        `${LOG} 🔌 Connection error — showing connection-error section`,
      );
      showSection("connection-error");
      return;
    }

    // Show stored state as fallback for other errors
    const state = await getLinkedState();
    if (state.isLinked) {
      showSection("status");
    } else {
      showSection("onboarding");
    }
  }
}

/**
 * Handle token confirmation.
 */
async function handleConfirmToken() {
  const token = tokenInput.value.trim();
  console.log(`${LOG} 🎫 handleConfirmToken() — token length: ${token.length}`);

  if (!token) {
    showError("Please enter your token.");
    return;
  }

  hideError();
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Activating...";

  try {
    const extensionId = await getExtensionId();

    console.log(
      `${LOG} 🎫 Confirming token with API... extensionId=${extensionId.slice(0, 8)}`,
    );
    const response = await confirmToken(token, extensionId);
    console.log(
      `${LOG} 🎫 Token confirm response: success=${response.success}`,
    );

    if (response.success && response.data) {
      console.log(`${LOG} ✅ Token confirmed!`);
      await saveLinkedState({
        token,
      });
      await showStatus();
      await loadSettings();
    } else {
      console.warn(`${LOG} ❌ Token confirmation failed: ${response.message}`);
      showError(response.message || "Failed to activate. Please try again.");
    }
  } catch (error) {
    if (error instanceof ConnectionError) {
      console.error(`${LOG} 🔌 Token confirm connection error`);
      // Show connection error section instead of inline error
      showSection("connection-error");
    } else {
      showError("Connection error. Please check your internet and try again.");
      console.error(`${LOG} ❌ Token confirmation failed:`, error);
    }
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Activate";
  }
}

/**
 * Handle emulate notification button.
 * Sends a fake study notification through the full API pipeline.
 */
async function handleEmulateNotification() {
  const emulateBtn = $<HTMLButtonElement>("emulate-btn");
  const emulateResult = $("emulate-result");

  emulateBtn.disabled = true;
  emulateBtn.textContent = "Sending...";
  emulateResult.classList.add("hidden");

  try {
    const { notifyStudy } = await import("../lib/api.js");
    const extensionId = await getExtensionId();

    const fakeStudy = {
      title: "[TEST] Sample Research Study",
      reward: "£5.00",
      url: `https://app.prolific.com/studies/test-${Date.now()}`,
      postedAt: new Date().toISOString(),
      mobileSupported: true,
    };

    const response = await notifyStudy(extensionId, fakeStudy);

    emulateResult.classList.remove("hidden", "success", "error");
    if (response.success) {
      emulateResult.classList.add("success");
      emulateResult.textContent = response.data?.deduplicated
        ? "✅ Sent (deduplicated — already sent)"
        : "✅ Notification sent to Telegram!";
    } else {
      emulateResult.classList.add("error");
      emulateResult.textContent = `❌ ${response.message}`;
    }
  } catch (error) {
    emulateResult.classList.remove("hidden", "success", "error");
    emulateResult.classList.add("error");
    emulateResult.textContent = "❌ Connection error. Is the API running?";
    console.error("Emulate notification failed:", error);
  } finally {
    emulateBtn.disabled = false;
    emulateBtn.textContent = "🧪 Emulate Notification";
  }
}

/**
 * Check if the user has a Prolific studies tab open.
 */
async function checkProlificTab() {
  console.log(`${LOG} 🔍 Checking for open Prolific tabs...`);
  try {
    const tabs = await chrome.tabs.query({
      url: ["https://app.prolific.com/*", "https://www.prolific.com/*"],
    });
    console.log(`${LOG} 🔍 Found ${tabs.length} Prolific tab(s)`);
    if (tabs.length === 0) {
      prolificTabWarning.classList.remove("hidden");
    } else {
      prolificTabWarning.classList.add("hidden");
    }
  } catch {
    // If tabs API not available, hide warning
    prolificTabWarning.classList.add("hidden");
  }
}

/**
 * Load stored settings and show the settings panel.
 */
async function loadSettings() {
  console.log(`${LOG} ⚙️ Loading settings...`);
  const [minReward, notifEnabled, minPlaces, beepEnabled] = await Promise.all([
    getMinReward(),
    getNotificationsEnabled(),
    getMinPlaces(),
    getBeepEnabled(),
  ]);
  console.log(
    `${LOG} ⚙️ Settings loaded: minReward=£${minReward.toFixed(2)}, notifications=${notifEnabled}, minPlaces=${minPlaces}, beep=${beepEnabled}`,
  );

  minRewardSlider.value = String(minReward);
  const usdEquiv = (minReward * 1.35).toFixed(2);
  minRewardValue.textContent = `£${minReward.toFixed(2)} ($${usdEquiv})`;

  notificationsToggle.checked = notifEnabled;
  minRewardRow.style.opacity = notifEnabled ? "1" : "0.4";
  minRewardRow.style.pointerEvents = notifEnabled ? "" : "none";
  minPlacesRow.style.opacity = notifEnabled ? "1" : "0.4";
  minPlacesRow.style.pointerEvents = notifEnabled ? "" : "none";

  minPlacesSlider.value = String(minPlaces);
  minPlacesValue.textContent = String(minPlaces);

  beepToggle.checked = beepEnabled;

  // Force toggle off and locked when access is inactive
  const state = await getLinkedState();
  if (!state.isActive) {
    notificationsToggle.checked = false;
    notificationsToggle.disabled = true;
    minRewardRow.style.opacity = "0.4";
    minRewardRow.style.pointerEvents = "none";
    minPlacesRow.style.opacity = "0.4";
    minPlacesRow.style.pointerEvents = "none";
  }

  settingsSection.classList.remove("hidden");

  // Show footer with extensionId
  const extensionId = await getExtensionId();
  const footer = document.getElementById("app-footer");
  const footerExtId = document.getElementById("footer-ext-id");
  if (footer && footerExtId) {
    footerExtId.textContent = extensionId;
    footer.classList.remove("hidden");
  }
}

// Event listeners

// Settings slider
let sliderTimeout: ReturnType<typeof setTimeout> | null = null;
minRewardSlider.addEventListener("input", () => {
  const value = parseFloat(minRewardSlider.value);
  const usdVal = (value * 1.35).toFixed(2);
  minRewardValue.textContent = `£${value.toFixed(2)} ($${usdVal})`;

  // Debounce the storage write
  if (sliderTimeout) clearTimeout(sliderTimeout);
  sliderTimeout = setTimeout(() => {
    setMinReward(value);
    console.log(`[Settings] Min reward set to £${value.toFixed(2)}`);
  }, 300);
});

// Notifications toggle
notificationsToggle.addEventListener("change", () => {
  const enabled = notificationsToggle.checked;
  setNotificationsEnabled(enabled);
  minRewardRow.style.opacity = enabled ? "1" : "0.4";
  minRewardRow.style.pointerEvents = enabled ? "" : "none";
  minPlacesRow.style.opacity = enabled ? "1" : "0.4";
  minPlacesRow.style.pointerEvents = enabled ? "" : "none";
  console.log(`[Settings] Notifications ${enabled ? "enabled" : "disabled"}`);
});

// Min places slider
let placesSliderTimeout: ReturnType<typeof setTimeout> | null = null;
minPlacesSlider.addEventListener("input", () => {
  const value = parseInt(minPlacesSlider.value, 10);
  minPlacesValue.textContent = String(value);

  if (placesSliderTimeout) clearTimeout(placesSliderTimeout);
  placesSliderTimeout = setTimeout(() => {
    setMinPlaces(value);
    console.log(`[Settings] Min places set to ${value}`);
  }, 300);
});

// Beep toggle
beepToggle.addEventListener("change", () => {
  const enabled = beepToggle.checked;
  setBeepEnabled(enabled);
  console.log(`[Settings] Beep ${enabled ? "enabled" : "disabled"}`);
});

// Beep try button
const beepTryBtn = $<HTMLButtonElement>("beep-try-btn");
beepTryBtn.addEventListener("click", () => {
  try {
    const ctx = new AudioContext();
    const beepCount = 9;
    const beepDuration = 0.12;
    const beepGap = 0.1;
    const sequenceGap = 0.3;
    const frequencies = [880, 1046, 1318];
    for (let i = 0; i < beepCount; i++) {
      const seqIndex = Math.floor(i / 3);
      const start =
        ctx.currentTime + i * (beepDuration + beepGap) + seqIndex * sequenceGap;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(frequencies[i % 3]!, start);
      gainNode.gain.setValueAtTime(0.25, start);
      gainNode.gain.setValueAtTime(0.25, start + beepDuration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, start + beepDuration);
      oscillator.start(start);
      oscillator.stop(start + beepDuration);
    }
  } catch (e) {
    console.warn("[Settings] Could not play beep:", e);
  }
});

confirmBtn.addEventListener("click", handleConfirmToken);
tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleConfirmToken();
});

retryConnectionBtn.addEventListener("click", () => {
  console.log(`${LOG} 🔄 Retry connection clicked`);
  init(); // Retry initialization
});

// QR code click handler
const qrCode = document.querySelector<HTMLImageElement>(".qr-code");
if (qrCode) {
  qrCode.addEventListener("click", () => {
    window.open(
      "https://t.me/prolific_notifications_bot?start=token",
      "_blank",
    );
  });
}

// Debug button listener (commented out for now)
// const emulateBtn = document.getElementById("emulate-btn");
// if (emulateBtn) {
//   emulateBtn.addEventListener("click", handleEmulateNotification);
// }

// Initialize
init();
