/**
 * Content script for provider study/project detection.
 *
 * Source of truth: visible DOM nodes on supported dashboards.
 * Detection model: deterministic per-item state machine persisted in storage.local.
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
import type { Provider, SupportedDevice } from "../lib/alert-types.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface StudyInfo {
  provider: Provider;
  id: string;
  title: string;
  reward: string;
  rewardPerHour?: string | null;
  completionTime: string | null;
  places: string | null;
  url: string;
  postedAt: string;
  supportedDevices: SupportedDevice[];
  mobileSupported: boolean;
}

declare global {
  interface Window {
    __studyAlerts?: {
      loaded?: boolean;
      provider?: Provider | null;
      loadedAt?: string;
      clearCache?: () => Promise<void>;
    };
    __prolificAlerts?: {
      clearCache?: () => Promise<void>;
    };
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const LOG_PREFIX = "[Study Alerts]";

const PROLIFIC_BASE_URL = "https://app.prolific.com";
const CLOUDRESEARCH_BASE_URL = "https://connect.cloudresearch.com";

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

const PROLIFIC_REFRESH_MIN_MS = 30_000;
const PROLIFIC_REFRESH_MAX_MS = 40_000;
const CLOUDRESEARCH_REFRESH_MIN_MS = 10_000;
const CLOUDRESEARCH_REFRESH_MAX_MS = 15_000;

const STARTUP_DOM_WAIT_MAX_MS = 2_000;
const STARTUP_DOM_WAIT_STEP_MS = 150;
const PROLIFIC_AUTO_ACCEPT_HASH_TOKEN = "__study_alerts_auto_accept__";
const PROLIFIC_AUTO_ACCEPT_BUTTON_SELECTOR =
  'button.reserve-study-button[data-testid="reserve"]';
const PROLIFIC_AUTO_ACCEPT_MAX_WAIT_MS = 15_000;

// ── Context / lifecycle ─────────────────────────────────────────────────────

let domObserver: MutationObserver | null = null;
const intervalIds: ReturnType<typeof setInterval>[] = [];
const timeoutIds: ReturnType<typeof setTimeout>[] = [];
let scanInProgress = false;
let domStudiesReadyLogged = false;
const loggedSkipKeys = new Set<string>();
let prolificAutoAcceptStarted = false;

function detectProviderFromLocation(): Provider | null {
  const { protocol, hostname } = window.location;
  if (protocol === "file:") return "prolific";
  if (hostname === "connect.cloudresearch.com") return "cloudresearch";
  if (hostname === "app.prolific.com" || hostname === "www.prolific.com") {
    return "prolific";
  }
  return null;
}

function isProlificStudiesRoute(): boolean {
  const url = new URL(window.location.href);
  if (url.protocol === "file:") return true;
  if (!url.hostname.includes("prolific.com")) return false;
  return url.pathname === "/studies" || url.pathname === "/studies/";
}

function isProlificAutoAcceptRoute(): boolean {
  const url = new URL(window.location.href);
  if (url.protocol === "file:" || url.hostname !== "app.prolific.com") {
    return false;
  }

  return (
    url.pathname === "/studies" ||
    url.pathname === "/studies/" ||
    url.pathname.startsWith("/studies/")
  );
}

function isCloudResearchDashboardRoute(): boolean {
  const { hostname, pathname } = window.location;
  if (hostname !== "connect.cloudresearch.com") return false;
  return (
    pathname === "/participant/dashboard" ||
    pathname === "/participant/dashboard/"
  );
}

function isDashboardEligible(provider: Provider | null): boolean {
  if (provider === "prolific") return isProlificStudiesRoute();
  if (provider === "cloudresearch") return isCloudResearchDashboardRoute();
  return false;
}

function makeProviderCacheKey(provider: Provider, id: string): string {
  return id.startsWith(`${provider}:`) ? id : `${provider}:${id}`;
}

function normalizeStoredCacheKey(id: string): string {
  return id.includes(":") ? id : makeProviderCacheKey("prolific", id);
}

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
  for (const id of timeoutIds) clearTimeout(id);
  timeoutIds.length = 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasProlificAutoAcceptMarker(): boolean {
  return window.location.hash.includes(PROLIFIC_AUTO_ACCEPT_HASH_TOKEN);
}

function clearProlificAutoAcceptMarker(): void {
  if (!hasProlificAutoAcceptMarker()) return;

  const url = new URL(window.location.href);
  const fragments = url.hash
    .replace(/^#/, "")
    .split("&")
    .filter((fragment) => fragment && fragment !== PROLIFIC_AUTO_ACCEPT_HASH_TOKEN);

  const nextHash = fragments.join("&");
  const nextUrl = `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`;
  window.history.replaceState(window.history.state, "", nextUrl);
  scheduleAutoRefresh();
}

function logSkipOnce(key: string, message: string): void {
  if (loggedSkipKeys.has(key)) return;
  loggedSkipKeys.add(key);
  console.log(`${LOG_PREFIX} ${message}`);
}

function describeStudy(study: Pick<StudyInfo, "id" | "title">): string {
  return `id=${study.id} title="${study.title}"`;
}

function findProlificReserveStudyButton(): HTMLButtonElement | null {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      PROLIFIC_AUTO_ACCEPT_BUTTON_SELECTOR,
    ),
  );

  for (const button of buttons) {
    const label = readText(button);
    if (
      !button.disabled &&
      isElementVisible(button) &&
      /take part in this study/i.test(label ?? "")
    ) {
      return button;
    }
  }

  return null;
}

async function waitForProlificReserveStudyButton(
  timeoutMs: number,
): Promise<HTMLButtonElement | null> {
  const existing = findProlificReserveStudyButton();
  if (existing) {
    return existing;
  }

  return await new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const button = findProlificReserveStudyButton();
      if (!button) return;
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve(button);
    });

    const timeoutId = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "style", "aria-disabled"],
    });
  });
}

async function maybeRunProlificAutoAccept(): Promise<void> {
  if (prolificAutoAcceptStarted) return;
  if (!hasProlificAutoAcceptMarker()) return;
  if (!isProlificAutoAcceptRoute()) return;

  prolificAutoAcceptStarted = true;
  console.log(`${LOG_PREFIX} auto-accept requested for current Prolific page`);

  const button = await waitForProlificReserveStudyButton(
    PROLIFIC_AUTO_ACCEPT_MAX_WAIT_MS,
  );
  clearProlificAutoAcceptMarker();

  if (!button) {
    console.warn(
      `${LOG_PREFIX} auto-accept skipped: reserve button not found within timeout`,
    );
    return;
  }

  console.log(`${LOG_PREFIX} auto-accept clicking Prolific reserve button`);
  button.click();
}

function scheduleProlificAutoAccept(): void {
  if (!hasProlificAutoAcceptMarker()) return;

  if (isProlificAutoAcceptRoute()) {
    void maybeRunProlificAutoAccept();
    return;
  }

  const startedAt = Date.now();
  const intervalId = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(intervalId);
      cleanup();
      return;
    }

    if (prolificAutoAcceptStarted || !hasProlificAutoAcceptMarker()) {
      clearInterval(intervalId);
      return;
    }

    if (!isProlificAutoAcceptRoute()) {
      if (Date.now() - startedAt >= PROLIFIC_AUTO_ACCEPT_MAX_WAIT_MS) {
        clearInterval(intervalId);
        clearProlificAutoAcceptMarker();
        console.warn(
          `${LOG_PREFIX} auto-accept skipped: Prolific studies route did not load in time`,
        );
      }
      return;
    }

    clearInterval(intervalId);
    void maybeRunProlificAutoAccept();
  }, 250);

  intervalIds.push(intervalId);
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
    const appRoot = document.querySelector(
      detectProviderFromLocation() === "cloudresearch"
        ? "main, #app, [data-v-app]"
        : "#app[data-v-app], main",
    );
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
        const normalizedId = normalizeStoredCacheKey(id);
        studyCache.set(normalizedId, {
          ...entry,
          id: normalizedId,
        });
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

function publishPageStudyAlertsMarker(marker: {
  loaded: boolean;
  provider: Provider | null;
  loadedAt: string;
}): void {
  try {
    const firefoxWindow = window as typeof window & {
      wrappedJSObject?: Window & {
        __studyAlerts?: {
          loaded?: boolean;
          provider?: Provider | null;
          loadedAt?: string;
        };
      };
    };
    const cloneIntoFn = (
      globalThis as typeof globalThis & {
        cloneInto?: <T>(value: T, target: object) => T;
      }
    ).cloneInto;

    if (firefoxWindow.wrappedJSObject) {
      const targetWindow = firefoxWindow.wrappedJSObject;
      targetWindow.__studyAlerts = cloneIntoFn
        ? cloneIntoFn(marker, targetWindow)
        : marker;
      return;
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} page marker publish failed via wrappedJSObject`, error);
  }

  try {
    const script = document.createElement("script");
    script.textContent = `window.__studyAlerts = Object.assign({}, window.__studyAlerts || {}, ${JSON.stringify(marker)});`;
    (document.documentElement || document.head || document.body).appendChild(
      script,
    );
    script.remove();
  } catch (error) {
    console.warn(`${LOG_PREFIX} page marker publish failed via injected script`, error);
  }
}

function registerDebugHooks(provider: Provider | null): void {
  const loadedAt = new Date().toISOString();
  const marker = {
    loaded: true,
    provider,
    loadedAt,
  };

  window.__studyAlerts = {
    ...(window.__studyAlerts ?? {}),
    ...marker,
    clearCache: clearAllStudyCache,
  };

  window.__prolificAlerts = {
    ...(window.__prolificAlerts ?? {}),
    clearCache: clearAllStudyCache,
  };

  publishPageStudyAlertsMarker(marker);

  window.addEventListener("study-alerts:clear-cache", () => {
    void clearAllStudyCache();
  });

  window.addEventListener("prolific-alerts:clear-cache", () => {
    void clearAllStudyCache();
  });

  console.log(
    `${LOG_PREFIX} 🛠️ Debug hook registered: window.__studyAlerts?.clearCache()`,
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

const PROLIFIC_STUDY_LIST_SELECTOR = '[data-testid="studies-list"]';
const PROLIFIC_STUDY_ITEM_SELECTOR = 'li[data-testid^="study-"]';
const CLOUDRESEARCH_PRIMARY_CARD_SELECTOR = ".project-card";
const CLOUDRESEARCH_PROJECT_LINK_SELECTOR = 'a[href*="/participant/project/"]';
const CLOUDRESEARCH_CARD_FALLBACK_SELECTOR =
  '.project-card, article, li, tr, [role="article"], [class*="card"], [data-testid*="project"]';
const CLOUDRESEARCH_ACTION_LABEL_RE =
  /\b(?:view|start|take|continue)\b/i;
const CLOUDRESEARCH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const CLOUDRESEARCH_REWARD_LINE_RE =
  /^\$?\d+(?:\.\d{1,2})?\s+payment$/i;
const CLOUDRESEARCH_PER_HOUR_LINE_RE =
  /^\$?\d+(?:\.\d{1,2})?\s+per hour$/i;
const CLOUDRESEARCH_REWARD_RE =
  /(?:\$?\d+(?:\.\d{1,2})?\s+payment|\$?\d+\.\d{1,2})/i;
const CLOUDRESEARCH_TIME_RE =
  /^(?:estimated(?:\s+time)?|time allotted|max(?:imum)? time|~?\s*\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:min|mins|minutes|hour|hours))$/i;
const CLOUDRESEARCH_TIME_INLINE_RE =
  /\b\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:min|mins|minutes|hour|hours)\b/i;
const CLOUDRESEARCH_SPOTS_RE = /^\d+\s+(?:spot|spots|place|places)$/i;
const CLOUDRESEARCH_EXCLUDED_CARD_RE =
  /\b(completed|approved|awaiting review|returned|rejected|timed out|history)\b/i;

function readText(element: Element | null): string | null {
  if (!element) return null;
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  return text ? text : null;
}

function readVisibleTextLines(element: Element): string[] {
  const rawText =
    element instanceof HTMLElement
      ? element.innerText
      : (element.textContent ?? "");

  return rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isElementVisible(element: Element | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
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

function parseProlificDomStudy(item: Element): StudyInfo | null {
  const rawTestId = item.getAttribute("data-testid");
  const titleAnchor = item.querySelector('[data-testid="title"] a');
  const href = titleAnchor?.getAttribute("href")?.trim() ?? "";

  const rawId =
    parseStudyIdFromTestId(rawTestId) ||
    parseStudyIdFromHref(href);
  if (!rawId) {
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
    logSkipOnce(
      `no-title:${rawId}`,
      `study ${rawId}: no title, using fallback`,
    );
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
  const url = buildStudyUrl(rawId, href);

  const devicesText = readText(item.querySelector('[data-testid="devices"]'));
  const supportedDevices = parseSupportedDevices(devicesText);
  const mobileSupported = supportedDevices.includes("Mobile");

  return {
    provider: "prolific",
    id: makeProviderCacheKey("prolific", rawId),
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

function readProlificStudiesSnapshot(): StudyInfo[] | null {
  const list = document.querySelector(PROLIFIC_STUDY_LIST_SELECTOR);
  if (!list) return null;

  const items = Array.from(list.querySelectorAll(PROLIFIC_STUDY_ITEM_SELECTOR));
  console.log(
    `${LOG_PREFIX} project cards found: ${items.length} provider=prolific`,
  );
  const studies: StudyInfo[] = [];

  for (const item of items) {
    const parsed = parseProlificDomStudy(item);
    if (parsed) studies.push(parsed);
  }

  return studies;
}

function parseCloudResearchProjectIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/participant\/project\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

function parseCloudResearchStableClassKey(card: Element): string | null {
  for (const className of Array.from(card.classList)) {
    if (className.startsWith("project-card-") && className !== "project-card") {
      return className;
    }
  }

  const classAttr = card.getAttribute("class") ?? "";
  const match = classAttr.match(/\b(project-card-[0-9a-f-]{8,})\b/i);
  return match?.[1] ?? null;
}

function normalizeFallbackPart(value: string | null | undefined): string {
  return (value ?? "unknown")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildCloudResearchFallbackId(study: {
  title: string;
  reward: string;
  completionTime: string | null;
  places: string | null;
}): string {
  return [
    normalizeFallbackPart(study.title),
    normalizeFallbackPart(study.reward),
    normalizeFallbackPart(study.completionTime),
    normalizeFallbackPart(study.places),
  ].join(":");
}

function collectMatchingTexts(root: Element, pattern: RegExp): string[] {
  const candidates = new Set<string>();
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];

  for (const element of elements) {
    if (!isElementVisible(element)) continue;
    const text = readText(element);
    if (!text) continue;
    if (!pattern.test(text)) continue;
    if (text.length > 140) continue;
    candidates.add(text);
  }

  return [...candidates].sort((a, b) => a.length - b.length);
}

function looksLikeCloudResearchCard(element: Element): boolean {
  if (!isElementVisible(element)) return false;
  const text = readText(element);
  if (!text || text.length < 12) return false;
  if (CLOUDRESEARCH_EXCLUDED_CARD_RE.test(text)) return false;

  if (element.matches(CLOUDRESEARCH_PRIMARY_CARD_SELECTOR)) return true;

  const hasProjectLink = Boolean(
    element.querySelector(CLOUDRESEARCH_PROJECT_LINK_SELECTOR),
  );
  const hasAction = CLOUDRESEARCH_ACTION_LABEL_RE.test(text);
  const hasMetadata =
    CLOUDRESEARCH_REWARD_RE.test(text) ||
    CLOUDRESEARCH_TIME_INLINE_RE.test(text) ||
    /\b\d+\s+(?:spot|spots|place|places)\b/i.test(text);

  return (hasProjectLink || hasAction) && hasMetadata;
}

function findCloudResearchCard(seed: Element): Element | null {
  let current: Element | null = seed;
  while (current && current !== document.body) {
    if (looksLikeCloudResearchCard(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectCloudResearchCandidateCards(): Element[] {
  const cards = new Set<Element>();

  const primaryCards = Array.from(
    document.querySelectorAll(CLOUDRESEARCH_PRIMARY_CARD_SELECTOR),
  );
  for (const card of primaryCards) {
    if (looksLikeCloudResearchCard(card)) {
      cards.add(card);
    }
  }

  const projectLinks = Array.from(
    document.querySelectorAll(CLOUDRESEARCH_PROJECT_LINK_SELECTOR),
  );
  for (const link of projectLinks) {
    if (!isElementVisible(link)) continue;
    const card = findCloudResearchCard(link);
    if (card) cards.add(card);
  }

  const actionElements = Array.from(
    document.querySelectorAll("button, a, [role='button']"),
  );
  for (const element of actionElements) {
    if (!isElementVisible(element)) continue;
    const text = readText(element);
    if (!text || !CLOUDRESEARCH_ACTION_LABEL_RE.test(text)) continue;
    const card = findCloudResearchCard(element);
    if (card) cards.add(card);
  }

  if (cards.size === 0) {
    const fallbacks = Array.from(
      document.querySelectorAll(CLOUDRESEARCH_CARD_FALLBACK_SELECTOR),
    );
    for (const candidate of fallbacks) {
      if (looksLikeCloudResearchCard(candidate)) {
        cards.add(candidate);
      }
    }
  }

  return [...cards];
}

function findFirstLine(
  lines: string[],
  predicate: (line: string) => boolean,
): string | null {
  for (const line of lines) {
    if (predicate(line)) return line;
  }

  return null;
}

function extractCloudResearchTitle(card: Element, lines: string[]): string {
  const firstTitleLine = findFirstLine(
    lines,
    (line) =>
      !CLOUDRESEARCH_DATE_RE.test(line) &&
      !CLOUDRESEARCH_REWARD_LINE_RE.test(line) &&
      !CLOUDRESEARCH_PER_HOUR_LINE_RE.test(line) &&
      !CLOUDRESEARCH_TIME_RE.test(line) &&
      !CLOUDRESEARCH_SPOTS_RE.test(line) &&
      !/^(view|not interested|available|in progress)$/i.test(line),
  );

  if (firstTitleLine) return firstTitleLine;

  const linkText = readText(card.querySelector(CLOUDRESEARCH_PROJECT_LINK_SELECTOR));
  if (linkText && !CLOUDRESEARCH_ACTION_LABEL_RE.test(linkText)) {
    return linkText;
  }

  return "New CloudResearch Connect Project";
}

function extractCloudResearchReward(lines: string[], card: Element): string | null {
  const paymentLine = findFirstLine(lines, (line) =>
    CLOUDRESEARCH_REWARD_LINE_RE.test(line),
  );
  if (paymentLine) return paymentLine;

  const candidates = collectMatchingTexts(card, CLOUDRESEARCH_REWARD_RE);
  const bestCandidate = candidates.find((text) =>
    CLOUDRESEARCH_REWARD_LINE_RE.test(text) || /\$ ?\d|\d+\.\d{1,2}/i.test(text),
  );
  if (bestCandidate) return bestCandidate;

  const cardText = readText(card);
  const match = cardText?.match(/\$?\d+(?:\.\d{1,2})?\s+payment/i);
  return match?.[0] ?? null;
}

function extractCloudResearchRewardPerHour(lines: string[]): string | null {
  return findFirstLine(lines, (line) => CLOUDRESEARCH_PER_HOUR_LINE_RE.test(line));
}

function extractCloudResearchTime(lines: string[], card: Element): string | null {
  const timeLine = findFirstLine(lines, (line) => CLOUDRESEARCH_TIME_RE.test(line));
  if (timeLine) return timeLine;

  const candidates = collectMatchingTexts(card, CLOUDRESEARCH_TIME_INLINE_RE);
  if (candidates[0]) return candidates[0];

  const cardText = readText(card);
  const match = cardText?.match(
    /\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:min|mins|minutes|hour|hours)/i,
  );
  return match?.[0] ?? null;
}

function extractCloudResearchPlaces(lines: string[], card: Element): string | null {
  const spotsLine = findFirstLine(lines, (line) => CLOUDRESEARCH_SPOTS_RE.test(line));
  if (spotsLine) return spotsLine;

  const candidates = collectMatchingTexts(card, /\b\d+\s+(?:spot|spots|place|places)\b/i);
  if (candidates[0]) return candidates[0];

  const cardText = readText(card);
  const match = cardText?.match(/\b\d+\s+(?:spot|spots|place|places)\b/i);
  return match?.[0] ?? null;
}

function extractCloudResearchUrl(card: Element): string {
  const link = card.querySelector<HTMLAnchorElement>(
    CLOUDRESEARCH_PROJECT_LINK_SELECTOR,
  );
  if (link?.href) return link.href;
  return window.location.href;
}

function hasCloudResearchDashboardScaffold(): boolean {
  const bodyText = readText(document.body) ?? "";
  const hasTabs =
    /\bavailable\b/i.test(bodyText) && /\bin progress\b/i.test(bodyText);
  const hasSearch = Boolean(
    document.querySelector(
      'input[placeholder*="Search" i], input[aria-label*="Search" i]',
    ),
  );
  return hasTabs || hasSearch;
}

function hasCloudResearchEmptyState(): boolean {
  const bodyText = readText(document.body) ?? "";
  return /no available projects|no projects available|no projects found/i.test(
    bodyText,
  );
}

function parseCloudResearchStudy(card: Element): StudyInfo {
  const lines = readVisibleTextLines(card);
  const title = extractCloudResearchTitle(card, lines);
  const reward =
    extractCloudResearchReward(lines, card) ?? "Check project for details";
  const rewardPerHour = extractCloudResearchRewardPerHour(lines);
  const completionTime = extractCloudResearchTime(lines, card);
  const places = extractCloudResearchPlaces(lines, card);
  const url = extractCloudResearchUrl(card);
  const rawId =
    parseCloudResearchStableClassKey(card) ||
    parseCloudResearchProjectIdFromUrl(url) ||
    buildCloudResearchFallbackId({
      title,
      reward,
      completionTime,
      places,
    });

  return {
    provider: "cloudresearch",
    id: makeProviderCacheKey("cloudresearch", rawId),
    title,
    reward,
    rewardPerHour,
    completionTime,
    places,
    url,
    postedAt: new Date().toISOString(),
    supportedDevices: [],
    mobileSupported: false,
  };
}

function readCloudResearchStudiesSnapshot(): StudyInfo[] | null {
  const cards = collectCloudResearchCandidateCards();

  if (cards.length === 0) {
    if (!hasCloudResearchDashboardScaffold() && !hasCloudResearchEmptyState()) {
      return null;
    }
  }

  console.log(
    `${LOG_PREFIX} project cards found: ${cards.length} provider=cloudresearch`,
  );

  return cards.map((card) => parseCloudResearchStudy(card));
}

function readProviderStudiesSnapshot(): StudyInfo[] | null {
  const provider = detectProviderFromLocation();
  if (provider === "cloudresearch") {
    return readCloudResearchStudiesSnapshot();
  }
  if (provider === "prolific") {
    return readProlificStudiesSnapshot();
  }
  return null;
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
    const snapshot1 = readProviderStudiesSnapshot();
    if (!snapshot1) {
      console.log(`${LOG_PREFIX} 🔍 SCAN: provider snapshot unavailable (null)`);
      return null;
    }

    // ── Stabilization gap ──────────────────────────────────────────────
    await delay(STABILIZATION_DELAY_MS);

    const snapshot2 = readProviderStudiesSnapshot();
    if (!snapshot2) {
      console.log(
        `${LOG_PREFIX} 🔍 SCAN: provider snapshot missing after stabilization (null)`,
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
      console.log(`${LOG_PREFIX} ✅ SCAN: DOM dashboard data loaded and ready`);
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

  const paymentMatch = normalized.match(/(\d+(?:\.\d+)?)\s+payment/i);
  if (paymentMatch?.[1]) {
    const usdValue = parseFloat(paymentMatch[1]);
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
      provider: study.provider,
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
      provider: study.provider,
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
  const provider = topStudies[0]?.provider ?? "prolific";
  const response = await sendMessageToBackground({
    type: "STUDIES_SUMMARY",
    summary: {
      provider,
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
  const provider = topStudies[0]?.provider ?? "prolific";
  const response = await sendMessageToBackground({
    type: "STUDIES_REAPPEARED_SUMMARY",
    summary: {
      provider,
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
          `${LOG_PREFIX} new project detected: provider=${study.provider} ${describeStudy(study)}`,
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
  if (url.protocol === "file:" || url.hostname !== "app.prolific.com") {
    return false;
  }

  return (
    (url.pathname === "/studies" || url.pathname === "/studies/") &&
    url.search === "" &&
    url.hash === ""
  );
}

async function getCloudResearchAutoRefreshSetting(): Promise<boolean> {
  try {
    const result = await storage.local.get("cloudResearchAutoRefreshEnabled");
    const value = result["cloudResearchAutoRefreshEnabled"];
    return value === true;
  } catch {
    return false;
  }
}

function isTypingInEditableField(): boolean {
  const active = document.activeElement;
  if (!active) return false;

  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
  ) {
    return true;
  }

  return (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active.closest("[contenteditable='true'], [contenteditable='']") !== null)
  );
}

function scheduleProlificAutoRefresh(): void {
  if (!isExactStudiesPage()) return;

  const delayMs =
    PROLIFIC_REFRESH_MIN_MS +
    Math.random() * (PROLIFIC_REFRESH_MAX_MS - PROLIFIC_REFRESH_MIN_MS);
  console.log(
    `${LOG_PREFIX} next refresh time: ${new Date(Date.now() + delayMs).toISOString()} provider=prolific`,
  );

  const timeoutId = setTimeout(() => {
    if (!isContextValid()) {
      cleanup();
      return;
    }

    if (!isExactStudiesPage()) return;

    if (isTypingInEditableField()) {
      console.log(
        `${LOG_PREFIX} refresh skipped: user typing on provider=prolific studies page`,
      );
      scheduleProlificAutoRefresh();
      return;
    }

    window.location.reload();
  }, delayMs);

  timeoutIds.push(timeoutId);
}

async function scheduleCloudResearchAutoRefresh(): Promise<void> {
  if (!isCloudResearchDashboardRoute()) return;
  if (!(await getCloudResearchAutoRefreshSetting())) return;

  const delayMs =
    CLOUDRESEARCH_REFRESH_MIN_MS +
    Math.random() *
      (CLOUDRESEARCH_REFRESH_MAX_MS - CLOUDRESEARCH_REFRESH_MIN_MS);
  console.log(
    `${LOG_PREFIX} next refresh time: ${new Date(Date.now() + delayMs).toISOString()} provider=cloudresearch`,
  );

  const timeoutId = setTimeout(() => {
    if (!isContextValid()) {
      cleanup();
      return;
    }

    if (!isCloudResearchDashboardRoute()) return;

    if (isTypingInEditableField()) {
      console.log(
        `${LOG_PREFIX} refresh skipped: user typing on provider=cloudresearch dashboard`,
      );
      void scheduleCloudResearchAutoRefresh();
      return;
    }

    window.location.reload();
  }, delayMs);

  timeoutIds.push(timeoutId);
}

function scheduleAutoRefresh(): void {
  const provider = detectProviderFromLocation();
  if (provider === "cloudresearch") {
    void scheduleCloudResearchAutoRefresh();
    return;
  }

  if (provider === "prolific") {
    scheduleProlificAutoRefresh();
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

(async () => {
  const provider = detectProviderFromLocation();
  const eligible = isDashboardEligible(provider);

  console.log(`${LOG_PREFIX} content script loaded`);
  console.log(`${LOG_PREFIX} provider detected: ${provider ?? "unknown"}`);
  console.log(`${LOG_PREFIX} current URL: ${window.location.href}`);
  console.log(`${LOG_PREFIX} dashboard eligible: ${eligible ? "yes" : "no"}`);

  registerDebugHooks(provider);
  scheduleProlificAutoAccept();

  if (!provider || !eligible) {
    return;
  }

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
