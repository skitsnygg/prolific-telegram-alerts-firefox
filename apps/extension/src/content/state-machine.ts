export type StudyState = "ACTIVE" | "ABSENT";

export interface StudyCacheEntry {
  id: string;
  state: StudyState;
  firstSeenAt: number;
  lastSeenAt: number;
  absentSince: number | null;
  notifiedAt: number;
}

interface SuccessfulPollInput {
  cache: Map<string, StudyCacheEntry>;
  visibleStudyIds: string[];
  now: number;
  cacheTtlMs: number;
  reappearMinGoneMs: number;
}

interface PollInput {
  cache: Map<string, StudyCacheEntry>;
  scannedStudyIds: string[] | null;
  now: number;
  cacheTtlMs: number;
  reappearMinGoneMs: number;
}

export interface PollTransitionResult {
  noOp: boolean;
  cacheChanged: boolean;
  newStudyIds: string[];
  reappearedStudyIds: string[];
}

export function shouldKeepCacheEntryOnLoad(
  entry: StudyCacheEntry,
  now: number,
  cacheTtlMs: number,
): boolean {
  const referenceTime = entry.absentSince ?? entry.lastSeenAt;
  return now - referenceTime <= cacheTtlMs;
}

export function shouldBatchReappearedStudies(
  reappearedCount: number,
  batchThreshold: number,
): boolean {
  return reappearedCount >= batchThreshold;
}

export function pruneExpiredEntries(
  cache: Map<string, StudyCacheEntry>,
  now: number,
  cacheTtlMs: number,
): boolean {
  let changed = false;

  for (const [id, entry] of cache) {
    const referenceTime = entry.absentSince ?? entry.lastSeenAt;
    if (now - referenceTime > cacheTtlMs) {
      cache.delete(id);
      changed = true;
    }
  }

  return changed;
}

export function processPollTransition(input: PollInput): PollTransitionResult {
  if (input.scannedStudyIds === null) {
    return {
      noOp: true,
      cacheChanged: false,
      newStudyIds: [],
      reappearedStudyIds: [],
    };
  }

  return applySuccessfulPollTransitions({
    cache: input.cache,
    visibleStudyIds: input.scannedStudyIds,
    now: input.now,
    cacheTtlMs: input.cacheTtlMs,
    reappearMinGoneMs: input.reappearMinGoneMs,
  });
}

function applySuccessfulPollTransitions(
  input: SuccessfulPollInput,
): PollTransitionResult {
  const { cache, visibleStudyIds, now, cacheTtlMs, reappearMinGoneMs } = input;

  let cacheChanged = pruneExpiredEntries(cache, now, cacheTtlMs);
  const newStudyIds: string[] = [];
  const reappearedStudyIds: string[] = [];
  const visibleSet = new Set<string>();

  for (const studyId of visibleStudyIds) {
    if (visibleSet.has(studyId)) continue;
    visibleSet.add(studyId);

    const existing = cache.get(studyId);

    if (!existing) {
      cache.set(studyId, {
        id: studyId,
        state: "ACTIVE",
        firstSeenAt: now,
        lastSeenAt: now,
        absentSince: null,
        notifiedAt: 0,
      });
      newStudyIds.push(studyId);
      cacheChanged = true;
      continue;
    }

    if (
      existing.state === "ABSENT" &&
      existing.absentSince !== null &&
      now - existing.absentSince >= reappearMinGoneMs &&
      existing.notifiedAt > 0
    ) {
      reappearedStudyIds.push(studyId);
    }

    if (
      existing.state !== "ACTIVE" ||
      existing.absentSince !== null ||
      existing.lastSeenAt !== now
    ) {
      const stateChanged =
        existing.state !== "ACTIVE" || existing.absentSince !== null;

      existing.state = "ACTIVE";
      existing.lastSeenAt = now;
      existing.absentSince = null;

      if (stateChanged) {
        cacheChanged = true;
      }
    }
  }

  for (const entry of cache.values()) {
    if (!visibleSet.has(entry.id) && entry.state === "ACTIVE") {
      entry.state = "ABSENT";
      entry.absentSince = now;
      cacheChanged = true;
    }
  }

  return {
    noOp: false,
    cacheChanged,
    newStudyIds,
    reappearedStudyIds,
  };
}

export function markStudiesNotified(
  cache: Map<string, StudyCacheEntry>,
  studyIds: string[],
  notifiedAt: number,
): boolean {
  let changed = false;

  for (const studyId of studyIds) {
    const entry = cache.get(studyId);
    if (!entry) continue;
    if (entry.notifiedAt !== notifiedAt) {
      entry.notifiedAt = notifiedAt;
      changed = true;
    }
  }

  return changed;
}

export function getVisibleUnnotifiedStudyIds(
  cache: Map<string, StudyCacheEntry>,
  visibleStudyIds: string[],
): string[] {
  const uniqueVisibleIds = new Set<string>();
  const result: string[] = [];

  for (const studyId of visibleStudyIds) {
    if (uniqueVisibleIds.has(studyId)) continue;
    uniqueVisibleIds.add(studyId);

    const entry = cache.get(studyId);
    if (!entry) continue;
    if (entry.notifiedAt === 0) {
      result.push(studyId);
    }
  }

  return result;
}
