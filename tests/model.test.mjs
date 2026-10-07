import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  recallProbability,
  initialStability,
  stabilityAfterReview,
  nextReviewDelayDays,
  nextReviewTimestamp,
  statusForRecall,
  learningStage,
  estimatedReviewSeconds
} from "./model.bundle.mjs";

const settings = structuredClone(DEFAULT_SETTINGS);

test("recall reaches e^-1 after one stability interval", () => {
  const recall = recallProbability(7, 7);

  assert.ok(
    Math.abs(recall - Math.exp(-1)) < 1e-12
  );
});

test("recall starts at 100 percent", () => {
  assert.equal(
    recallProbability(0, 7),
    1
  );
});

test("invalid stability returns zero recall", () => {
  assert.equal(
    recallProbability(10, 0),
    0
  );

  assert.equal(
    recallProbability(10, -5),
    0
  );
});

test("future elapsed time is treated as full recall", () => {
  assert.equal(
    recallProbability(-1, 7),
    1
  );
});

test("complexity changes initial stability", () => {
  const veryEasy =
    initialStability(
      "very-easy",
      settings
    );

  const normal =
    initialStability(
      "normal",
      settings
    );

  const veryComplex =
    initialStability(
      "very-complex",
      settings
    );

  assert.ok(veryEasy > normal);
  assert.ok(normal > veryComplex);
});

test("normal initial stability is seven days", () => {
  assert.equal(
    initialStability(
      "normal",
      settings
    ),
    7
  );
});

test("forgot decreases stability", () => {
  const after =
    stabilityAfterReview(
      10,
      0.4,
      "forgot",
      "normal",
      settings
    );

  assert.ok(after < 10);
});

test("hard good and easy produce increasing stability", () => {
  const hard =
    stabilityAfterReview(
      10,
      0.5,
      "hard",
      "normal",
      settings
    );

  const good =
    stabilityAfterReview(
      10,
      0.5,
      "good",
      "normal",
      settings
    );

  const easy =
    stabilityAfterReview(
      10,
      0.5,
      "easy",
      "normal",
      settings
    );

  assert.ok(hard < good);
  assert.ok(good < easy);
});

test("successful difficult retrieval produces larger gain", () => {
  const difficult =
    stabilityAfterReview(
      10,
      0.3,
      "good",
      "normal",
      settings
    );

  const immediate =
    stabilityAfterReview(
      10,
      0.95,
      "good",
      "normal",
      settings
    );

  assert.ok(difficult > immediate);
});

test("complex notes gain less stability than easy notes", () => {
  const easy =
    stabilityAfterReview(
      10,
      0.5,
      "good",
      "easy",
      settings
    );

  const complex =
    stabilityAfterReview(
      10,
      0.5,
      "good",
      "complex",
      settings
    );

  assert.ok(easy > complex);
});

test("next review delay reaches configured recall threshold", () => {
  const stability = 7;
  const threshold = 0.45;

  const delay =
    nextReviewDelayDays(
      stability,
      threshold
    );

  const recall =
    recallProbability(
      delay,
      stability
    );

  assert.ok(
    Math.abs(
      recall - threshold
    ) < 1e-12
  );
});

test("default seven day stability becomes due around 5.59 days", () => {
  const delay =
    nextReviewDelayDays(
      7,
      0.45
    );

  assert.ok(
    Math.abs(
      delay - 5.5895
    ) < 0.001
  );
});

test("next review timestamp is after review time", () => {
  const now =
    1_700_000_000_000;

  const next =
    nextReviewTimestamp(
      7,
      0.45,
      now
    );

  assert.ok(next > now);
});

test("threshold is safely bounded", () => {
  const tooLow =
    nextReviewDelayDays(
      7,
      -100
    );

  const minimum =
    nextReviewDelayDays(
      7,
      0.01
    );

  assert.equal(
    tooLow,
    minimum
  );

  const tooHigh =
    nextReviewDelayDays(
      7,
      100
    );

  const maximum =
    nextReviewDelayDays(
      7,
      0.99
    );

  assert.equal(
    tooHigh,
    maximum
  );
});

test("recall status transitions correctly", () => {
  assert.equal(
    statusForRecall(0.05, 0.45),
    "forgotten"
  );

  assert.equal(
    statusForRecall(0.30, 0.45),
    "needs-review"
  );

  assert.equal(
    statusForRecall(0.55, 0.45),
    "weakening"
  );

  assert.equal(
    statusForRecall(0.75, 0.45),
    "strong"
  );

  assert.equal(
    statusForRecall(0.95, 0.45),
    "fresh"
  );
});

test("learning stage begins as new", () => {
  assert.equal(
    learningStage(0, 0, 7),
    "new"
  );
});

test("early reviews remain learning", () => {
  assert.equal(
    learningStage(2, 0, 20),
    "learning"
  );
});

test("three reviews establish a note", () => {
  assert.equal(
    learningStage(3, 0, 20),
    "established"
  );
});

test("mastery requires reviews stability and low lapses", () => {
  assert.equal(
    learningStage(8, 2, 90),
    "mastered"
  );

  assert.equal(
    learningStage(8, 3, 90),
    "established"
  );

  assert.equal(
    learningStage(8, 2, 89),
    "established"
  );
});

test("normal complexity estimates 3m15s for 500 words", () => {
  const note = {
    path: "example.md",
    title: "Example",
    wordCount: 500,
    stabilityDays: 7,
    complexity: "normal",
    reviewCount: 0,
    lapseCount: 0,
    history: []
  };

  assert.equal(
    estimatedReviewSeconds(
      note,
      settings
    ),
    195
  );
});

test("complex complexity estimates 4m33s for 500 words", () => {
  const note = {
    path: "example.md",
    title: "Example",
    wordCount: 500,
    stabilityDays: 7,
    complexity: "complex",
    reviewCount: 0,
    lapseCount: 0,
    history: []
  };

  assert.equal(
    estimatedReviewSeconds(
      note,
      settings
    ),
    273
  );
});
