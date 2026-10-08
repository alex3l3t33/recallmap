import {
  DEFAULT_SETTINGS,
  recallProbability,
  stabilityAfterReview,
  type Complexity,
  type ReviewRating,
} from "./model";

export const DAY_IN_MS = 86_400_000;

export const COMPLEXITY_LEVELS: readonly Complexity[] = [
  "very-easy",
  "easy",
  "normal",
  "complex",
  "very-complex",
];

export const COMPLEXITY_LABELS: Record<Complexity, string> = {
  "very-easy": "Very easy",
  easy: "Easy",
  normal: "Normal",
  complex: "Complex",
  "very-complex": "Very complex",
};

export type ComplexityMultipliers = Record<Complexity, number>;

export const DEFAULT_COMPLEXITY_MULTIPLIERS: ComplexityMultipliers = {
  "very-easy": 0.6,
  easy: 0.8,
  normal: 1,
  complex: 1.4,
  "very-complex": 1.8,
};

export type DashboardFilter =
  | "needs-review"
  | "forgotten"
  | "weakening"
  | "growing"
  | "strong"
  | "mastered"
  | "learned";

export const FILTER_LABELS: Record<DashboardFilter, string> = {
  "needs-review": "Needs review",
  forgotten: "Forgotten",
  weakening: "Weakening",
  growing: "Growing",
  strong: "Strong",
  mastered: "Mastered",
  learned: "All notes",
};

export interface MemoryRecord {
  lastReviewed: number;
  stabilityDays: number;
  reviewCount: number;
  complexityOverride?: Complexity;

  firstLearnedAt?: number;
  nextReviewAt?: number;
  lapseCount?: number;

  history?: Array<{
    timestamp: number;
    rating: ReviewRating;
    recallBeforeReview: number;
    stabilityBefore: number;
    stabilityAfter: number;
  }>;
}

export interface ReviewResult {
  previousRecall: number;
  previousStabilityDays: number;
  newStabilityDays: number;
  memoryGain: number;
}

export function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateRecall(
  lastReviewed: number,
  stabilityDays: number,
  now = Date.now(),
): number {
  const elapsedDays = Math.max(0, now - lastReviewed) / DAY_IN_MS;
  return clamp(
    recallProbability(elapsedDays, stabilityDays) * 100,
    0,
    100,
  );
}

export function applyReview(
  record: MemoryRecord,
  rating: ReviewRating,
  now = Date.now(),
): { record: MemoryRecord; result: ReviewResult } {
  const previousRecall =
    calculateRecall(
      record.lastReviewed,
      record.stabilityDays,
      now,
    );

  const complexity =
    record.complexityOverride ?? "normal";

  const recallBeforeReview =
    previousRecall / 100;

  const newStabilityDays =
    stabilityAfterReview(
      record.stabilityDays,
      recallBeforeReview,
      rating,
      complexity,
      DEFAULT_SETTINGS,
    );

  const history = [
    ...(record.history ?? []),
    {
      timestamp: now,
      rating,
      recallBeforeReview,
      stabilityBefore: record.stabilityDays,
      stabilityAfter: newStabilityDays,
    },
  ];

  return {
    record: {
      ...record,

      firstLearnedAt:
        record.firstLearnedAt ??
        record.lastReviewed ??
        now,

      lastReviewed: now,

      stabilityDays:
        newStabilityDays,

      reviewCount:
        record.reviewCount + 1,

      lapseCount:
        (record.lapseCount ?? 0) +
        (rating === "forgot" ? 1 : 0),

      history,
    },

    result: {
      previousRecall,
      previousStabilityDays:
        record.stabilityDays,

      newStabilityDays,

      memoryGain:
        Math.max(0, 100 - previousRecall),
    },
  };
}

export function estimateReviewSeconds(
  wordCount: number,
  readingWordsPerMinute: number,
  activeRecallSeconds: number,
  ratingSeconds: number,
  complexity: Complexity,
  multipliers: ComplexityMultipliers,
): number {
  const safeWordsPerMinute = Math.max(readingWordsPerMinute, 1);

  const readingSeconds =
    (Math.max(wordCount, 0) / safeWordsPerMinute) * 60;

  const baseSeconds =
    readingSeconds +
    Math.max(activeRecallSeconds, 0) +
    Math.max(ratingSeconds, 0);

  const multiplier =
    Math.max(multipliers[complexity], 0.1);

  return Math.max(
    15,
    Math.round(baseSeconds * multiplier),
  );
}

export function matchesDashboardFilter(
  snapshot: { recall: number; reviewCount: number },
  filter: DashboardFilter,
  reviewThreshold: number,
): boolean {
  const { recall, reviewCount } = snapshot;

  switch (filter) {
    case "learned":
      return true;

    case "needs-review":
      return recall < reviewThreshold;

    case "forgotten":
      return recall < 12;

    case "weakening":
      return recall >= 12 && recall < reviewThreshold;

    case "growing":
      return (
        recall >= reviewThreshold &&
        (recall < 80 || reviewCount < 3)
      );

    case "strong":
      return (
        recall >= 80 &&
        (recall < 92 || reviewCount < 8)
      );

    case "mastered":
      return recall >= 92 && reviewCount >= 8;
  }
}

export function getRecallTone(
  recall: number,
  reviewCount: number,
  reviewThreshold: number,
): Exclude<DashboardFilter, "learned" | "needs-review"> {
  if (recall < 12) return "forgotten";
  if (recall < reviewThreshold) return "weakening";
  if (recall < 80 || reviewCount < 3) return "growing";
  if (recall < 92 || reviewCount < 8) return "strong";
  return "mastered";
}

export function countWords(content: string): number {
  const withoutFrontmatter =
    content.replace(/^---[\s\S]*?---\s*/u, "");

  const withoutCode =
    withoutFrontmatter.replace(/```[\s\S]*?```/gu, " ");

  const words = withoutCode
    .replace(/<[^>]+>/gu, " ")
    .replace(/[#[\]()*_>`~|{}]/gu, " ")
    .trim()
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);

  return words?.length ?? 0;
}

export function estimateWordCountFromBytes(
  byteLength: number,
  averageBytesPerWord = 6,
): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;

  return Math.max(
    1,
    Math.round(byteLength / Math.max(averageBytesPerWord, 1)),
  );
}

export function normalizeExcludedFolders(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/gu)
      : [];

  const result: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;

    const normalized = candidate
      .trim()
      .replace(/\\\\/g, "/")
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\/{2,}/gu, "/");

    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }

  return result;
}

export function isVaultPathExcluded(
  filePath: string,
  excludedFolders: readonly string[],
): boolean {
  const path = filePath
    .replace(/\\\\/g, "/")
    .replace(/^\/+|\/+$/gu, "");

  return excludedFolders.some((folder) => {
    const normalized = folder
      .replace(/\\\\/g, "/")
      .replace(/^\/+|\/+$/gu, "");

    return (
      normalized.length > 0 &&
      (path === normalized || path.startsWith(`${normalized}/`))
    );
  });
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));

  if (safe < 60) return `${safe} sec`;

  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;

  return remainder
    ? `${minutes} min ${remainder} sec`
    : `${minutes} min`;
}

export function formatCompactDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));

  if (safe < 60) return `${safe}s`;

  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;

  return remainder
    ? `${minutes}m ${remainder}s`
    : `${minutes}m`;
}
