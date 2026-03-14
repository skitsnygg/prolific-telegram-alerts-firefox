import { describe, expect, it } from "vitest";

import {
  getVisibleUnnotifiedStudyIds,
  markStudiesNotified,
  processPollTransition,
  shouldBatchReappearedStudies,
  shouldKeepCacheEntryOnLoad,
  type StudyCacheEntry,
} from "../src/content/state-machine";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REAPPEAR_MIN_GONE_MS = 15 * 60 * 1000;

function runPoll(
  cache: Map<string, StudyCacheEntry>,
  now: number,
  ids: string[] | null,
) {
  return processPollTransition({
    cache,
    now,
    scannedStudyIds: ids,
    cacheTtlMs: CACHE_TTL_MS,
    reappearMinGoneMs: REAPPEAR_MIN_GONE_MS,
  });
}

describe("state-machine", () => {
  it("does no-op on null scan result", () => {
    const cache = new Map<string, StudyCacheEntry>();
    runPoll(cache, 1_000, ["A"]);

    const before = JSON.stringify([...cache.entries()]);
    const result = runPoll(cache, 61_000, null);
    const after = JSON.stringify([...cache.entries()]);

    expect(result.noOp).toBe(true);
    expect(result.cacheChanged).toBe(false);
    expect(result.newStudyIds).toEqual([]);
    expect(result.reappearedStudyIds).toEqual([]);
    expect(after).toEqual(before);
  });

  it("suppresses reappearance when absent less than 3 minutes", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["B"]);
    markStudiesNotified(cache, ["B"], 1);

    runPoll(cache, 10_000, []);
    const result = runPoll(cache, 10_000 + 2 * 60 * 1000, ["B"]);

    expect(result.reappearedStudyIds).toEqual([]);
  });

  it("emits reappearance when absent at least 3 minutes and was notified", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["C"]);
    markStudiesNotified(cache, ["C"], 100);

    runPoll(cache, 10_000, []);
    const result = runPoll(cache, 10_000 + 15 * 60 * 1000, ["C"]);

    expect(result.reappearedStudyIds).toEqual(["C"]);
  });

  it("suppresses reappeared notification when study has one place left (after 20 minutes)", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["R1"]);
    markStudiesNotified(cache, ["R1"], 100);

    runPoll(cache, 10_000, []);
    const result = runPoll(cache, 10_000 + 20 * 60 * 1000, ["R1"]);

    expect(result.reappearedStudyIds).toEqual(["R1"]);

    const reappearedStudiesAfterSinglePlaceGuard = result.reappearedStudyIds
      .map((id) => ({ id, places: "1 place" }))
      .filter((study) => {
        const match = study.places.match(/(\d+)/);
        const places = match?.[1] ? parseInt(match[1], 10) : null;
        return places !== 1;
      });

    expect(reappearedStudiesAfterSinglePlaceGuard).toEqual([]);
  });

  it("detects grouped new studies and then a later single new study", () => {
    const cache = new Map<string, StudyCacheEntry>();

    const first = runPoll(cache, 0, [
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
      "N6",
      "N7",
      "N8",
      "N9",
      "N10",
    ]);
    expect(first.newStudyIds).toHaveLength(10);

    const second = runPoll(cache, 20_000, [
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
      "N6",
      "N7",
      "N8",
      "N9",
      "N10",
      "N11",
    ]);
    expect(second.newStudyIds).toEqual(["N11"]);
  });

  it("keeps continuously visible study as ACTIVE with single new detection", () => {
    const cache = new Map<string, StudyCacheEntry>();

    const first = runPoll(cache, 0, ["W1"]);
    expect(first.newStudyIds).toEqual(["W1"]);

    for (let i = 1; i <= 21; i++) {
      const result = runPoll(cache, i * 24 * 60 * 60 * 1000, ["W1"]);
      expect(result.newStudyIds).toEqual([]);
      expect(result.reappearedStudyIds).toEqual([]);
    }

    const final = cache.get("W1");
    expect(final?.state).toBe("ACTIVE");
    expect(final?.absentSince).toBeNull();
  });

  it("applies 30-day TTL by firstSeenAt", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["T1"]);
    expect(cache.has("T1")).toBe(true);

    const over30Days = CACHE_TTL_MS + 1;
    runPoll(cache, over30Days, []);

    expect(cache.has("T1")).toBe(true);
    expect(cache.get("T1")?.state).toBe("ABSENT");

    runPoll(cache, over30Days + CACHE_TTL_MS + 1, []);
    expect(cache.has("T1")).toBe(false);
  });

  it("treats long inactivity elapsed time as real elapsed time for reappearance", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["S1"]);
    markStudiesNotified(cache, ["S1"], 100);

    runPoll(cache, 5_000, []);
    const result = runPoll(cache, 5_000 + 2 * 60 * 60 * 1000, ["S1"]);

    expect(result.reappearedStudyIds).toEqual(["S1"]);
  });

  it("does not reclassify continuously visible study as new after 30 days", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["V1"]);
    markStudiesNotified(cache, ["V1"], 50);

    const result = runPoll(cache, CACHE_TTL_MS + 1, ["V1"]);
    expect(result.newStudyIds).toEqual([]);
    expect(cache.has("V1")).toBe(true);
    expect(cache.get("V1")?.state).toBe("ACTIVE");
  });

  it("returns visible unnotified studies for re-qualification checks", () => {
    const cache = new Map<string, StudyCacheEntry>();

    runPoll(cache, 0, ["F1", "F2"]);
    markStudiesNotified(cache, ["F2"], 100);

    runPoll(cache, 20_000, ["F1", "F2"]);
    const candidates = getVisibleUnnotifiedStudyIds(cache, ["F1", "F2"]);

    expect(candidates).toEqual(["F1"]);
  });

  it("startup load keeps ACTIVE entries even after 30 days", () => {
    const now = CACHE_TTL_MS + 10_000;
    const activeEntry: StudyCacheEntry = {
      id: "L1",
      state: "ACTIVE",
      firstSeenAt: 0,
      lastSeenAt: now - 1_000,
      absentSince: null,
      notifiedAt: 123,
    };

    expect(shouldKeepCacheEntryOnLoad(activeEntry, now, CACHE_TTL_MS)).toBe(
      true,
    );
  });

  it("startup load prunes ABSENT entries older than TTL", () => {
    const now = CACHE_TTL_MS + 10_000;
    const staleAbsent: StudyCacheEntry = {
      id: "L2",
      state: "ABSENT",
      firstSeenAt: 0,
      lastSeenAt: 0,
      absentSince: 0,
      notifiedAt: 0,
    };

    expect(shouldKeepCacheEntryOnLoad(staleAbsent, now, CACHE_TTL_MS)).toBe(
      false,
    );
  });

  it("startup load keeps ABSENT entries within TTL", () => {
    const now = CACHE_TTL_MS;
    const recentAbsent: StudyCacheEntry = {
      id: "L3",
      state: "ABSENT",
      firstSeenAt: 0,
      lastSeenAt: now - 5_000,
      absentSince: now - 5_000,
      notifiedAt: 0,
    };

    expect(shouldKeepCacheEntryOnLoad(recentAbsent, now, CACHE_TTL_MS)).toBe(
      true,
    );
  });

  it("batches reappeared studies when count is greater or equal threshold", () => {
    expect(shouldBatchReappearedStudies(1, 2)).toBe(false);
    expect(shouldBatchReappearedStudies(2, 2)).toBe(true);
    expect(shouldBatchReappearedStudies(3, 2)).toBe(true);
  });
});
