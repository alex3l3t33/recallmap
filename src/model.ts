export type Complexity =
  | "very-easy"
  | "easy"
  | "normal"
  | "complex"
  | "very-complex";

export type ReviewRating =
  | "forgot"
  | "hard"
  | "good"
  | "easy";

export type RecallStatus =
  | "fresh"
  | "strong"
  | "weakening"
  | "needs-review"
  | "forgotten";

export type LearningStage =
  | "new"
  | "learning"
  | "established"
  | "mastered";

export interface ComplexityDefinition {
  label: string;
  multiplier: number;
  stabilityMultiplier: number;
}

export interface RecallMapSettings {
  defaultComplexity: Complexity;
  complexity: Record<
    Complexity,
    ComplexityDefinition
  >;

  readingWordsPerMinute: number;
  activeRecallSeconds: number;
  ratingSeconds: number;

  initialStabilityDays: number;
  reviewThreshold: number;
}

export interface ReviewEvent {
  timestamp: number;
  rating: ReviewRating;
  recallBeforeReview: number;
  stabilityBefore: number;
  stabilityAfter: number;
}

export interface NoteMemoryState {
  path: string;
  title: string;
  wordCount: number;

  firstLearnedAt?: number;
  lastReviewedAt?: number;
  nextReviewAt?: number;

  stabilityDays: number;
  complexity?: Complexity;

  reviewCount: number;
  lapseCount: number;

  history: ReviewEvent[];
}

export const DEFAULT_SETTINGS: RecallMapSettings = {
  defaultComplexity: "normal",

  complexity: {
    "very-easy": {
      label: "Very easy",
      multiplier: 0.6,
      stabilityMultiplier: 1.3
    },

    easy: {
      label: "Easy",
      multiplier: 0.8,
      stabilityMultiplier: 1.15
    },

    normal: {
      label: "Normal",
      multiplier: 1,
      stabilityMultiplier: 1
    },

    complex: {
      label: "Complex",
      multiplier: 1.4,
      stabilityMultiplier: 0.85
    },

    "very-complex": {
      label: "Very complex",
      multiplier: 1.8,
      stabilityMultiplier: 0.7
    }
  },

  readingWordsPerMinute: 200,
  activeRecallSeconds: 30,
  ratingSeconds: 15,

  initialStabilityDays: 7,
  reviewThreshold: 0.45
};

export function recallProbability(
  elapsedDays: number,
  stabilityDays: number
): number {
  if (elapsedDays < 0) {
    return 1;
  }

  if (
    !Number.isFinite(stabilityDays) ||
    stabilityDays <= 0
  ) {
    return 0;
  }

  return Math.exp(
    -elapsedDays / stabilityDays
  );
}

export function elapsedDaysSince(
  timestamp: number | undefined,
  now = Date.now()
): number {
  if (timestamp === undefined) {
    return 0;
  }

  return Math.max(
    0,
    (now - timestamp) / 86_400_000
  );
}

export function initialStability(
  complexity: Complexity,
  settings: RecallMapSettings
): number {
  const multiplier =
    settings.complexity[
      complexity
    ].stabilityMultiplier;

  return Math.max(
    0.25,
    settings.initialStabilityDays *
      multiplier
  );
}

export function stabilityAfterReview(
  currentStability: number,
  recallBeforeReview: number,
  rating: ReviewRating,
  complexity: Complexity,
  settings: RecallMapSettings
): number {
  const complexityFactor =
    settings.complexity[
      complexity
    ].stabilityMultiplier;

  const recall = Math.max(
    0,
    Math.min(
      1,
      recallBeforeReview
    )
  );

  if (rating === "forgot") {
    return Math.max(
      0.5,
      currentStability *
        0.45 *
        complexityFactor
    );
  }

  const retrievalDifficulty =
    1 + (1 - recall);

  let ratingFactor: number;

  switch (rating) {
    case "hard":
      ratingFactor = 1.15;
      break;

    case "good":
      ratingFactor = 1.8;
      break;

    case "easy":
      ratingFactor = 2.4;
      break;

    default:
      ratingFactor = 1;
  }

  return Math.max(
    0.5,
    currentStability *
      ratingFactor *
      retrievalDifficulty *
      complexityFactor
  );
}

export function nextReviewDelayDays(
  stabilityDays: number,
  threshold: number
): number {
  const safeThreshold =
    Math.max(
      0.01,
      Math.min(
        0.99,
        threshold
      )
    );

  return Math.max(
    0.25,
    -stabilityDays *
      Math.log(safeThreshold)
  );
}

export function nextReviewTimestamp(
  stabilityDays: number,
  threshold: number,
  now = Date.now()
): number {
  const delayDays =
    nextReviewDelayDays(
      stabilityDays,
      threshold
    );

  return (
    now +
    delayDays * 86_400_000
  );
}

export function statusForRecall(
  recall: number,
  threshold: number
): RecallStatus {
  if (recall < 0.12) {
    return "forgotten";
  }

  if (recall < threshold) {
    return "needs-review";
  }

  if (recall < 0.65) {
    return "weakening";
  }

  if (recall < 0.9) {
    return "strong";
  }

  return "fresh";
}

export function learningStage(
  reviewCount: number,
  lapseCount: number,
  stabilityDays: number
): LearningStage {
  if (reviewCount === 0) {
    return "new";
  }

  if (reviewCount < 3) {
    return "learning";
  }

  if (
    reviewCount >= 8 &&
    lapseCount <= 2 &&
    stabilityDays >= 90
  ) {
    return "mastered";
  }

  return "established";
}

export function estimatedReviewSeconds(
  note: NoteMemoryState,
  settings: RecallMapSettings
): number {
  const complexity =
    note.complexity ??
    settings.defaultComplexity;

  const multiplier =
    settings.complexity[
      complexity
    ].multiplier;

  const readingSeconds =
    (
      note.wordCount /
      settings.readingWordsPerMinute
    ) * 60;

  return Math.round(
    (
      readingSeconds +
      settings.activeRecallSeconds +
      settings.ratingSeconds
    ) *
      multiplier
  );
}

export function formatDuration(
  totalSeconds: number
): string {
  const minutes =
    Math.floor(
      totalSeconds / 60
    );

  const seconds =
    Math.round(
      totalSeconds % 60
    );

  if (minutes === 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}
