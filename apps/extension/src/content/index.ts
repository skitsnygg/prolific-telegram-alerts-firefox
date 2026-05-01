/**
 * Content script for prolific.com study detection.
 *
 * Source of truth: Prolific DOM nodes.
 * Detection model: deterministic per-study state machine persisted in chrome.storage.local.
 */

import {
  getVisibleUnnotifiedStudyIds,
  markStudiesNotified,
  processPollTransition,
  shouldBatchReappearedStudies,
  shouldKeepCacheEntryOnLoad,
  type StudyCacheEntry,
} from "./state-machine";
import { runtime, sendRuntimeMessage, storage } from "../lib/browser.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface StudyInfo {
  id: string;
  title: string;
  reward: string;
  completionTime: string | null;
  places: string | null;
  url: string;
  postedAt: string;
  supportedDevices: SupportedDevice[];
  mobileSupported: boolean;
}

type SupportedDevice = "Desktop" | "Tablet" | "Mobile";

declare global {
  interface Window {
    __prolificAlerts?: {
      clearCache?: () => Promise<void>;
    };
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const LOG_PREFIX = "[Prolific Alerts]";

const PROLIFIC_BASE_URL = "https://app.prolific.com";

const CACHE_STORAGE_KEY = "studyCache";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REAPPEAR_MIN_GONE_MS = 20 * 60 * 1000; // 20 minutes
const CACHE_SAVE_DEBOUNCE_MS = 3_000;

const SCAN_INTERVAL_MS = 20_000;
const DEBOUNCE_MS = 500;
const STABILIZATION_DELAY_MS = 150;
const REPORT_DELAY_MS = 1_500;
const TOP_STUDIES_COUNT = 5;
const REAPPEARED_BATCH_THRESHOLD = 2;

const GBP_TO_USD = 1.35;

const REFRESH_MIN_MS = 5 * 60_000;
const REFRESH_MAX_MS = 8 * 60_000;

const STARTUP_DOM_WAIT_MAX_MS = 2_000;
const STARTUP_DOM_WAIT_STEP_MS = 150;

// ── Context / lifecycle ─────────────────────────────────────────────────────

let domObserver: MutationObserver | null = null;
const intervalIds: ReturnType<typeof setInterval>[] = [];
let scanInProgress = false;
let domStudiesReadyLogged = false;
const loggedSkipKeys = new Set<string>();

function isContextValid(): boolean {
  return !!runtime?.id;
}

function cleanup(): void {
  console.warn(
    `${LOG_PREFIX} 🛑 Extension context invalidated — shutting down`,
  );
  domObserver?.disconnect();
  domObserver = null;
  for (const id of intervalIds) clearInterval(id);
  intervalIds.length = 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSkipOnce(key: string, message: string): void {
  if (loggedSkipKeys.has(key)) return;
  loggedSkipKeys.add(key);
  console.log(`${LOG_PREFIX} ${message}`);
}

function describeStudy(study: Pick<StudyInfo, "id" | "title">): string {
  return `id=${study.id} title="${study.title}"`;
}

async function waitForInitialDomReady(): Promise<void> {
  if (document.readyState === "loading") {
    await new Promise<void>((resolve) => {
      const onReady = () => {
        document.removeEventListener("DOMContentLoaded", onReady);
        resolve();
      };
      document.addEventListener("DOMContentLoaded", onReady);
    });
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_DOM_WAIT_MAX_MS) {
    const appRoot = document.querySelector("#app[data-v-app]");
    if (appRoot) return;
    await delay(STARTUP_DOM_WAIT_STEP_MS);
  }
}

// ── Persistent study state cache ────────────────────────────────────────────

const studyCache = new Map<string, StudyCacheEntry>();
let cacheLoaded = false;
let cacheDirty = false;
let cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

function isValidStudyCacheEntry(value: unknown): value is StudyCacheEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StudyCacheEntry>;
  return (
    typeof candidate.id === "string" &&
    (candidate.state === "ACTIVE" || candidate.state === "ABSENT") &&
    typeof candidate.firstSeenAt === "number" &&
    typeof candidate.lastSeenAt === "number" &&
    (candidate.absentSince === null ||
      typeof candidate.absentSince === "number") &&
    typeof candidate.notifiedAt === "number"
  );
}

async function loadCache(): Promise<void> {
  try {
    const result = await storage.local.get(CACHE_STORAGE_KEY);
    const raw = result[CACHE_STORAGE_KEY];
    const now = Date.now();

    if (raw && typeof raw === "object") {
      for (const [id, entry] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (!isValidStudyCacheEntry(entry)) continue;
        if (entry.id !== id) continue;
        if (!shouldKeepCacheEntryOnLoad(entry, now, CACHE_TTL_MS)) continue;

        studyCache.set(id, entry);
      }
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} ⚠️ Failed to load study cache:`, error);
  } finally {
    cacheLoaded = true;
  }
}

function scheduleCacheSave(): void {
  cacheDirty = true;
  if (cacheSaveTimer) return;

  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    void saveCache();
  }, CACHE_SAVE_DEBOUNCE_MS);
}

async function saveCache(): Promise<void> {
  if (!cacheDirty) return;

  try {
    const payload: Record<string, StudyCacheEntry> = {};
    for (const [id, entry] of studyCache) {
      payload[id] = entry;
    }
    await storage.local.set({ [CACHE_STORAGE_KEY]: payload });
    cacheDirty = false;
  } catch (error) {
    console.warn(`${LOG_PREFIX} ⚠️ Failed to save study cache:`, error);
  }
}

async function clearAllStudyCache(): Promise<void> {
  try {
    studyCache.clear();
    cacheDirty = false;

    if (cacheSaveTimer) {
      clearTimeout(cacheSaveTimer);
      cacheSaveTimer = null;
    }

    await storage.local.remove(CACHE_STORAGE_KEY);
    console.log(`${LOG_PREFIX} 🧹 Debug: study cache cleared`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} ⚠️ Debug: failed to clear study cache`, error);
  }
}

function registerDebugHooks(): void {
  window.__prolificAlerts = {
    ...(window.__prolificAlerts ?? {}),
    clearCache: clearAllStudyCache,
  };

  window.addEventListener("prolific-alerts:clear-cache", () => {
    void clearAllStudyCache();
  });

  console.log(
    `${LOG_PREFIX} 🛠️ Debug hook registered: window.__prolificAlerts?.clearCache()`,
  );
}

function getStudyCacheStats(): { active: number; absent: number } {
  let active = 0;
  let absent = 0;

  for (const entry of studyCache.values()) {
    if (entry.state === "ACTIVE") active++;
    else absent++;
  }

  return { active, absent };
}

function logState(context: string): void {
  const stats = getStudyCacheStats();
  console.log(
    `${LOG_PREFIX} 📊 STATE (${context}): total=${studyCache.size} active=${stats.active} absent=${stats.absent}`,
  );
}

function getCacheSizeKb(): number {
  const payload: Record<string, StudyCacheEntry> = {};
  for (const [id, entry] of studyCache) {
    payload[id] = entry;
  }

  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json).length;
  return bytes / 1024;
}

intervalIds.push(setInterval(() => logState("periodic-1min"), 60_000));

// ── DOM study scanning ──────────────────────────────────────────────────────

const STUDY_LIST_SELECTOR = '[data-testid="studies-list"]';
const STUDY_ITEM_SELECTOR = 'li[data-testid^="study-"]';

function readText(element: Element | null): string | null {
  if (!element) return null;
  const text = element.textContent?.trim();
  return text ? text : null;
}

function parseStudyIdFromTestId(value: string | null): string | null {
  if (!value || !value.startsWith("study-")) return null;
  const id = value.slice("study-".length).trim();
  return id ? id : null;
}

function parseStudyIdFromHref(href: string | null): string | null {
  if (!href) return null;
  const match = href.match(/\/studies\/(\w+)/i);
  return match?.[1] ?? null;
}

function buildStudyUrl(id: string | null, href: string | null): string {
  if (id) {
    return `${PROLIFIC_BASE_URL}/studies/${encodeURIComponent(id)}`;
  }

  if (href && href !== "#") {
    return new URL(href, PROLIFIC_BASE_URL).toString();
  }

  return `${PROLIFIC_BASE_URL}/studies`;
}

function parseSupportedDevices(text: string | null): SupportedDevice[] {
  if (!text) return [];

  const devices: SupportedDevice[] = [];
  if (/\bdesktop\b/i.test(text)) devices.push("Desktop");
  if (/\btablet\b/i.test(text)) devices.push("Tablet");
  if (/\bmobile\b/i.test(text)) devices.push("Mobile");
  return devices;
}

function parseDomStudy(item: Element): StudyInfo | null {
  const rawTestId = item.getAttribute("data-testid");
  const titleAnchor = item.querySelector('[data-testid="title"] a');
  const href = titleAnchor?.getAttribute("href")?.trim() ?? "";

  const id =
    parseStudyIdFromTestId(rawTestId) ||
    parseStudyIdFromHref(href);
  if (!id) {
    logSkipOnce(
      `no-id:${rawTestId ?? ""}:${href}`,
      `skip study card: no ID`,
    );
    return null;
  }

  const titleText =
    readText(titleAnchor) ||
    readText(item.querySelector('[data-testid="title"]'));
  if (!titleText) {
    logSkipOnce(`no-title:${id}`, `study ${id}: no title, using fallback`);
  }
  const title = titleText || "New Study Available";

  const rewardAmount = readText(
    item.querySelector('[data-testid="study-tag-reward"]'),
  );
  const rewardPerHour = readText(
    item.querySelector('[data-testid="study-tag-reward-per-hour"]'),
  );
  const reward = [rewardAmount, rewardPerHour].filter(Boolean).join(" • ");

  const completionTime = readText(
    item.querySelector('[data-testid="study-tag-completion-time"]'),
  );
  const places = readText(
    item.querySelector('[data-testid="study-tag-places"]'),
  );
  const url = buildStudyUrl(id, href);

  const devicesText = readText(item.querySelector('[data-testid="devices"]'));
  const supportedDevices = parseSupportedDevices(devicesText);
  const mobileSupported = supportedDevices.includes("Mobile");

  return {
    id,
    title,
    reward: reward || "Check study for details",
    completionTime,
    places,
    url,
    postedAt: new Date().toISOString(),
    supportedDevices,
    mobileSupported,
  };
}

function readDomStudiesSnapshot(): StudyInfo[] | null {
  const list = document.querySelector(STUDY_LIST_SELECTOR);
  if (!list) return null;

  const items = Array.from(list.querySelectorAll(STUDY_ITEM_SELECTOR));
  console.log(
    `${LOG_PREFIX} study cards found: ${items.length} using ${STUDY_ITEM_SELECTOR}`,
  );
  const studies: StudyInfo[] = [];

  for (const item of items) {
    const parsed = parseDomStudy(item);
    if (parsed) studies.push(parsed);
  }

  return studies;
}

/**
 * Compare two study-ID lists as sets (order-independent).
 * Returns `true` when both contain exactly the same IDs.
 */
function studyIdListsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

/**
 * Returns:
 * - `StudyInfo[]` on successful poll
 * - `null` on any failure or transient unavailability
 *
 * Uses **double-read stabilization** on DOM snapshots.
 */
async function scanStudies(): Promise<StudyInfo[] | null> {
  try {
    const snapshot1 = readDomStudiesSnapshot();
    if (!snapshot1) {
      console.log(`${LOG_PREFIX} 🔍 SCAN: studies list not found (null)`);
      return null;
    }

    // ── Stabilization gap ──────────────────────────────────────────────
    await delay(STABILIZATION_DELAY_MS);

    const snapshot2 = readDomStudiesSnapshot();
    if (!snapshot2) {
      console.log(
        `${LOG_PREFIX} 🔍 SCAN: studies list missing after stabilization (null)`,
      );
      return null;
    }

    const ids1 = snapshot1.map((study) => study.id);
    const ids2 = snapshot2.map((study) => study.id);

    if (!studyIdListsMatch(ids1, ids2)) {
      console.log(
        `${LOG_PREFIX} 🔍 SCAN: DOM unstable (study list changed between reads: ${ids1.length} → ${ids2.length}) — skipping`,
      );
      return null;
    }

    if (!domStudiesReadyLogged) {
      domStudiesReadyLogged = true;
      console.log(`${LOG_PREFIX} ✅ SCAN: DOM studies list loaded and ready`);
    }

    console.log(
      `${LOG_PREFIX} ✅ SCAN: DOM read successful — ids=${ids2.length}, parsed=${snapshot2.length}`,
    );

    return snapshot2;
  } catch (error) {
    console.error(`${LOG_PREFIX} Error while scanning studies:`, error);
    return null;
  }
}

// ── Filters ─────────────────────────────────────────────────────────────────

function parsePlaces(places: string | null): number | null {
  if (!places) return null;
  const match = places.match(/(\d+)/);
  if (!match?.[1]) return null;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseRewardGbp(reward: string): number | null {
  const normalized = reward.replace(/,/g, ".");

  const gbpMatch = normalized.match(/£(\d+(?:\.\d+)?)/);
  if (gbpMatch?.[1]) {
    const value = parseFloat(gbpMatch[1]);
    return Number.isFinite(value) ? value : null;
  }

  const usdMatch = normalized.match(/\$(\d+(?:\.\d+)?)/);
  if (usdMatch?.[1]) {
    const usdValue = parseFloat(usdMatch[1]);
    if (Number.isFinite(usdValue)) {
      return Math.round((usdValue / GBP_TO_USD) * 100) / 100;
    }
  }

  return null;
}

async function getMinRewardSetting(): Promise<number> {
  try {
    const result = await storage.local.get("minRewardGbp");
    const val = result["minRewardGbp"];
    return typeof val === "number" ? val : 0;
  } catch {
    return 0;
  }
}

async function getMinPlacesSetting(): Promise<number> {
  try {
    const result = await storage.local.get("minPlaces");
    const val = result["minPlaces"];
    return typeof val === "number" ? val : 1;
  } catch {
    return 1;
  }
}

async function getNotificationsEnabledSetting(): Promise<boolean> {
  try {
    const result = await storage.local.get("notificationsEnabled");
    const val = result["notificationsEnabled"];
    return val === undefined ? true : (val as boolean);
  } catch {
    return true;
  }
}

async function applyFilters(
  studies: StudyInfo[],
): Promise<{ passed: StudyInfo[]; filtered: StudyInfo[] }> {
  const notificationsEnabled = await getNotificationsEnabledSetting();
  if (!notificationsEnabled) {
    logSkipOnce("notifications-disabled", "skip alerts: notifications disabled");
    return { passed: [], filtered: studies };
  }

  const minReward = await getMinRewardSetting();
  const minPlaces = await getMinPlacesSetting();

  const passed: StudyInfo[] = [];
  const filtered: StudyInfo[] = [];

  for (const study of studies) {
    let skipReason: string | null = null;

    if (minReward > 0) {
      const rewardGbp = parseRewardGbp(study.reward);
      if (rewardGbp !== null && rewardGbp < minReward) {
        skipReason = `reward ${rewardGbp} < min ${minReward}`;
      }
    }

    if (!skipReason && minPlaces > 1) {
      const places = parsePlaces(study.places);
      if (places !== null && places < minPlaces) {
        skipReason = `places ${places} < min ${minPlaces}`;
      }
    }

    if (skipReason) {
      logSkipOnce(
        `filtered:${study.id}:${skipReason}`,
        `skip filtered: ${describeStudy(study)} (${skipReason})`,
      );
      filtered.push(study);
    } else {
      passed.push(study);
    }
  }

  return { passed, filtered };
}

// ── Messaging ───────────────────────────────────────────────────────────────

function sendMessageToBackground(message: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
} | null> {
  return new Promise((resolve) => {
    if (!isContextValid()) {
      cleanup();
      resolve(null);
      return;
    }

    const type =
      typeof message.type === "string" ? message.type : "UNKNOWN_MESSAGE";
    const details =
      type === "STUDY_DETECTED" || type === "STUDY_REAPPEARED"
        ? describeStudy(message.study as Pick<StudyInfo, "id" | "title">)
        : type === "STUDIES_SUMMARY" || type === "STUDIES_REAPPEARED_SUMMARY"
          ? `count=${(message.summary as { totalNew: number }).totalNew}`
          : "";
    console.log(
      `${LOG_PREFIX} sendMessage -> background: type=${type}${details ? ` ${details}` : ""}`,
    );

    void sendRuntimeMessage<{
      success: boolean;
      message?: string;
    } | null>(message)
      .then((response) => {
        console.log(
          `${LOG_PREFIX} sendMessage succeeded: type=${type} success=${response?.success === true}`,
        );
        resolve(response ?? null);
      })
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Extension context invalidated")) cleanup();
        console.warn(`${LOG_PREFIX} sendMessage failed: type=${type}`, error);
        resolve(null);
      });
  });
}

async function sendStudyDetected(study: StudyInfo): Promise<void> {
  console.log(
    `${LOG_PREFIX} real study alert -> background: ${describeStudy(study)}`,
  );
  const response = await sendMessageToBackground({
    type: "STUDY_DETECTED",
    study: {
      title: study.title,
      reward: study.reward,
      completionTime: study.completionTime,
      places: study.places,
      url: study.url,
      postedAt: study.postedAt,
      supportedDevices: study.supportedDevices,
      mobileSupported: study.mobileSupported,
    },
  });

  if (!response?.success) {
    console.warn(
      `${LOG_PREFIX} ⚠️ STUDY_DETECTED send failed (treated as delivered): ${study.id}`,
    );
  }
}

async function sendStudyReappeared(study: StudyInfo): Promise<void> {
  const response = await sendMessageToBackground({
    type: "STUDY_REAPPEARED",
    study: {
      title: study.title,
      reward: study.reward,
      completionTime: study.completionTime,
      places: study.places,
      url: study.url,
      postedAt: study.postedAt,
      supportedDevices: study.supportedDevices,
      mobileSupported: study.mobileSupported,
    },
  });

  if (!response?.success) {
    console.warn(
      `${LOG_PREFIX} ⚠️ STUDY_REAPPEARED send failed (treated as delivered): ${study.id}`,
    );
  }
}

function findTopPaid(
  studies: StudyInfo[],
  n: number = TOP_STUDIES_COUNT,
): StudyInfo[] {
  return [...studies]
    .sort(
      (a, b) =>
        (parseRewardGbp(b.reward) ?? 0) - (parseRewardGbp(a.reward) ?? 0),
    )
    .slice(0, n);
}

async function sendStudiesSummary(
  totalNew: number,
  topStudies: StudyInfo[],
): Promise<void> {
  const response = await sendMessageToBackground({
    type: "STUDIES_SUMMARY",
    summary: {
      totalNew,
      topStudies: topStudies.map((study) => ({
        title: study.title,
        reward: study.reward,
        completionTime: study.completionTime,
        places: study.places,
        url: study.url,
        supportedDevices: study.supportedDevices,
        mobileSupported: study.mobileSupported,
      })),
    },
  });

  if (!response?.success) {
    console.warn(
      `${LOG_PREFIX} ⚠️ STUDIES_SUMMARY send failed (treated as delivered): count=${totalNew}`,
    );
  }
}

async function sendReappearedStudiesSummary(
  totalReappeared: number,
  topStudies: StudyInfo[],
): Promise<void> {
  const response = await sendMessageToBackground({
    type: "STUDIES_REAPPEARED_SUMMARY",
    summary: {
      totalNew: totalReappeared,
      topStudies: topStudies.map((study) => ({
        title: study.title,
        reward: study.reward,
        completionTime: study.completionTime,
        places: study.places,
        url: study.url,
        supportedDevices: study.supportedDevices,
        mobileSupported: study.mobileSupported,
      })),
    },
  });

  if (!response?.success) {
    console.warn(
      `${LOG_PREFIX} ⚠️ STUDIES_REAPPEARED_SUMMARY send failed (treated as delivered): count=${totalReappeared}`,
    );
  }
}

// ── Scan and state transitions ──────────────────────────────────────────────

async function isUserActive(): Promise<boolean> {
  try {
    const result = await storage.local.get(["isLinked", "isActive"]);
    return result["isLinked"] === true && result["isActive"] === true;
  } catch {
    return false;
  }
}

async function scanAndReport(): Promise<void> {
  if (scanInProgress) return;
  scanInProgress = true;

  try {
    if (!(await isUserActive())) {
      console.log(`${LOG_PREFIX} 🔍 scan skipped (user not active)`);
      return;
    }

    if (!cacheLoaded) await loadCache();

    const scannedStudies = await scanStudies();

    // Mandatory behavior: failed scan => no state changes.
    if (scannedStudies === null) {
      console.log(`${LOG_PREFIX} 🔍 scan failed/null => no-op`);
      return;
    }

    const now = Date.now();
    const transition = processPollTransition({
      cache: studyCache,
      scannedStudyIds: scannedStudies.map((study) => study.id),
      now,
      cacheTtlMs: CACHE_TTL_MS,
      reappearMinGoneMs: REAPPEAR_MIN_GONE_MS,
    });

    let cacheChanged = transition.cacheChanged;

    const visibleStudyIds = scannedStudies.map((study) => study.id);
    const studyById = new Map(scannedStudies.map((study) => [study.id, study]));
    const unnotifiedVisibleCandidateIds = getVisibleUnnotifiedStudyIds(
      studyCache,
      visibleStudyIds,
    );
    const notifyCandidates = unnotifiedVisibleCandidateIds
      .map((studyId) => studyById.get(studyId))
      .filter((study): study is StudyInfo => !!study);
    const reappearedCandidates = transition.reappearedStudyIds
      .map((studyId) => studyById.get(studyId))
      .filter((study): study is StudyInfo => !!study);

    const { passed: newStudies } = await applyFilters(notifyCandidates);
    const { passed: reappearedStudiesAfterFilters } =
      await applyFilters(reappearedCandidates);
    const reappearedStudies = reappearedStudiesAfterFilters.filter(
      (study) => parsePlaces(study.places) !== 1,
    );

    for (const studyId of transition.newStudyIds) {
      const study = studyById.get(studyId);
      if (study) {
        console.log(
          `${LOG_PREFIX} study considered new: ${describeStudy(study)}`,
        );
      }
    }

    const reappearedIdSet = new Set(transition.reappearedStudyIds);
    const unnotifiedIdSet = new Set(unnotifiedVisibleCandidateIds);
    for (const study of scannedStudies) {
      if (unnotifiedIdSet.has(study.id) || reappearedIdSet.has(study.id)) {
        continue;
      }

      const cacheEntry = studyCache.get(study.id);
      if (cacheEntry?.notifiedAt && cacheEntry.notifiedAt > 0) {
        logSkipOnce(
          `cached:${study.id}`,
          `skip cached/duplicate: ${describeStudy(study)}`,
        );
      }
    }

    if (newStudies.length > 1) {
      await sendStudiesSummary(newStudies.length, findTopPaid(newStudies));
      cacheChanged =
        markStudiesNotified(
          studyCache,
          newStudies.map((study) => study.id),
          now,
        ) || cacheChanged;
    } else if (newStudies.length === 1) {
      const study = newStudies[0]!;
      await sendStudyDetected(study);
      cacheChanged =
        markStudiesNotified(studyCache, [study.id], now) || cacheChanged;
    }

    if (
      shouldBatchReappearedStudies(
        reappearedStudies.length,
        REAPPEARED_BATCH_THRESHOLD,
      )
    ) {
      await sendReappearedStudiesSummary(
        reappearedStudies.length,
        findTopPaid(reappearedStudies),
      );
      cacheChanged =
        markStudiesNotified(
          studyCache,
          reappearedStudies.map((study) => study.id),
          now,
        ) || cacheChanged;
    } else {
      for (let i = 0; i < reappearedStudies.length; i++) {
        const study = reappearedStudies[i]!;
        await sendStudyReappeared(study);
        cacheChanged =
          markStudiesNotified(studyCache, [study.id], now) || cacheChanged;
        if (i < reappearedStudies.length - 1) {
          await delay(REPORT_DELAY_MS);
        }
      }
    }

    if (cacheChanged) {
      scheduleCacheSave();
    }

    if (newStudies.length > 0 || reappearedStudies.length > 0) {
      console.log(
        `${LOG_PREFIX} ✅ reported: new=${newStudies.length}, reappeared=${reappearedStudies.length}`,
      );
    }
  } finally {
    scanInProgress = false;
  }
}

// ── Observation / periodic scan ─────────────────────────────────────────────

function observeDOM(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  domObserver = new MutationObserver(() => {
    if (!isContextValid()) {
      cleanup();
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void scanAndReport();
    }, DEBOUNCE_MS);
  });

  domObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Auto refresh ────────────────────────────────────────────────────────────

function isExactStudiesPage(): boolean {
  const url = new URL(window.location.href);
  if (url.protocol === "file:" || !url.hostname.includes("prolific.com")) {
    return false;
  }

  return (
    (url.pathname === "/studies" || url.pathname === "/studies/") &&
    url.search === "" &&
    url.hash === ""
  );
}

function scheduleAutoRefresh(): void {
  if (!isExactStudiesPage()) return;

  const delayMs =
    REFRESH_MIN_MS + Math.random() * (REFRESH_MAX_MS - REFRESH_MIN_MS);

  setTimeout(() => {
    if (!isContextValid()) {
      cleanup();
      return;
    }

    if (!isExactStudiesPage()) return;
    window.location.reload();
  }, delayMs);
}

// ── Init ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`${LOG_PREFIX} content script loaded`);
  console.log(`${LOG_PREFIX} current URL: ${window.location.href}`);
  console.log(`${LOG_PREFIX} on /studies: ${isExactStudiesPage()}`);
  console.log(
    `${LOG_PREFIX} selectors: list=${STUDY_LIST_SELECTOR} item=${STUDY_ITEM_SELECTOR}`,
  );

  registerDebugHooks();

  await loadCache();
  console.log(
    `${LOG_PREFIX} cache loaded: entries=${studyCache.size} size=${getCacheSizeKb().toFixed(2)} KB`,
  );
  logState("startup");

  await waitForInitialDomReady();

  await scanAndReport();
  observeDOM();

  intervalIds.push(
    setInterval(() => {
      if (!isContextValid()) {
        cleanup();
        return;
      }
      void scanAndReport();
    }, SCAN_INTERVAL_MS),
  );
})();

scheduleAutoRefresh();

// Optional UX behavior: if filters are relaxed, drop never-notified cache entries
// so currently visible studies can be evaluated again immediately.
storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const filterKeys = ["minRewardGbp", "minPlaces", "notificationsEnabled"];
  if (!filterKeys.some((key) => key in changes)) return;

  let removed = 0;
  for (const [id, entry] of studyCache) {
    if (entry.notifiedAt === 0) {
      studyCache.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    scheduleCacheSave();
    console.log(
      `${LOG_PREFIX} 🔄 filter change: removed ${removed} non-notified cache entries`,
    );
  }
});
