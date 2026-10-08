import {
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";

import {
  COMPLEXITY_LABELS,
  COMPLEXITY_LEVELS,
  DEFAULT_COMPLEXITY_MULTIPLIERS,
  FILTER_LABELS,
  applyReview,
  calculateRecall,
  clamp,
  countWords,
  estimateWordCountFromBytes,
  estimateReviewSeconds,
  formatCompactDuration,
  formatDuration,
  getRecallTone,
  isVaultPathExcluded,
  matchesDashboardFilter,
  normalizeExcludedFolders,
  type ComplexityMultipliers,
  type DashboardFilter,
  type MemoryRecord,
  type NoteComplexity,
  type ReviewRating,
  type ReviewResult,
} from "./ui-model";

import {
  nextReviewTimestamp,
} from "./model";

const VIEW_TYPE_RECALLMAP = "recallmap-dashboard";

interface RecallMapSettings {
  excludedFolders: string[];
  defaultComplexity: NoteComplexity;
  complexityMultipliers: ComplexityMultipliers;
  readingWordsPerMinute: number;
  activeRecallSeconds: number;
  ratingSeconds: number;
  initialStabilityDays: number;
  reviewThreshold: number;
}

interface RecallMapStore {
  settings: RecallMapSettings;
  records: Record<string, MemoryRecord>;
}

interface NoteMetric {
  file: TFile;
  wordCount: number;
  wordCountIsEstimate: boolean;
  recall: number;
  record: MemoryRecord;
  complexity: NoteComplexity;
  estimatedSeconds: number;
}

interface StatusCardDefinition {
  filter: DashboardFilter;
  icon: string;
  hint: string;
  tone: string;
}

const DEFAULT_SETTINGS: RecallMapSettings = {
  excludedFolders: [],
  defaultComplexity: "normal",
  complexityMultipliers: { ...DEFAULT_COMPLEXITY_MULTIPLIERS },
  readingWordsPerMinute: 200,
  activeRecallSeconds: 30,
  ratingSeconds: 15,
  initialStabilityDays: 7,
  reviewThreshold: 60,
};

const PRECISE_SCAN_LIMIT = 600;

const STATUS_CARDS: readonly StatusCardDefinition[] = [
  {
    filter: "needs-review",
    icon: "alarm-clock",
    hint: "Ready for active recall",
    tone: "review",
  },
  {
    filter: "forgotten",
    icon: "circle-alert",
    hint: "Below 25% recall",
    tone: "forgotten",
  },
  {
    filter: "weakening",
    icon: "trending-down",
    hint: "Memory is fading",
    tone: "weakening",
  },
  {
    filter: "growing",
    icon: "sprout",
    hint: "Building stability",
    tone: "growing",
  },
  {
    filter: "strong",
    icon: "shield-check",
    hint: "Healthy recall",
    tone: "strong",
  },
  {
    filter: "mastered",
    icon: "star",
    hint: "Durable knowledge",
    tone: "mastered",
  },
  {
    filter: "learned",
    icon: "library",
    hint: "Every tracked note",
    tone: "learned",
  },
];

const REVIEW_RATINGS: readonly {
  rating: ReviewRating;
  label: string;
  hint: string;
  icon: string;
}[] = [
  {
    rating: "forgotten",
    label: "Forgotten",
    hint: "Could not recall",
    icon: "x",
  },
  {
    rating: "difficult",
    label: "Difficult",
    hint: "Recalled with effort",
    icon: "brain",
  },
  {
    rating: "good",
    label: "Good",
    hint: "Recalled correctly",
    icon: "check",
  },
  {
    rating: "easy",
    label: "Easy",
    hint: "Immediate recall",
    icon: "zap",
  },
];

export default class RecallMapPlugin extends Plugin {
  settings: RecallMapSettings = { ...DEFAULT_SETTINGS };
  records: Record<string, MemoryRecord> = {};

  async onload(): Promise<void> {
    await this.loadStore();

    this.registerView(
      VIEW_TYPE_RECALLMAP,
      (leaf) => new RecallMapView(leaf, this),
    );

    this.addRibbonIcon("brain-circuit", "Open RecallMap", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Open memory dashboard",
      callback: () => {
        void this.activateView();
      },
    });

    this.addSettingTab(new RecallMapSettingTab(this));
  }

  async activateView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALLMAP)[0];
    const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);

    if (!existingLeaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_RECALLMAP,
        active: true,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  getRecord(file: TFile): MemoryRecord {
    const stored = this.records[file.path];

    if (stored) {
      return normalizeRecord(stored, this.settings);
    }

    return {
      lastReviewed: 0,
      stabilityDays: this.settings.initialStabilityDays,
      reviewCount: 0,
      lapseCount: 0,
      history: [],
    };
  }

  async setComplexity(
    file: TFile,
    complexityOverride: NoteComplexity | undefined,
  ): Promise<void> {
    const record = this.getRecord(file);
    if (complexityOverride) {
      record.complexityOverride = complexityOverride;
    } else {
      delete record.complexityOverride;
    }

    this.records[file.path] = record;
    await this.saveStore();
  }

  async recordReview(
    file: TFile,
    rating: ReviewRating,
  ): Promise<{ record: MemoryRecord; result: ReviewResult }> {
    const now = Date.now();
    const existing = this.getRecord(file);

    const baseRecord: MemoryRecord =
      existing.firstLearnedAt || existing.lastReviewed > 0
        ? existing
        : {
            ...existing,
            firstLearnedAt: now,
            lastReviewed: now,
          };

    const reviewed = applyReview(baseRecord, rating, now);

    reviewed.record.firstLearnedAt =
      reviewed.record.firstLearnedAt ?? now;

    reviewed.record.nextReviewAt =
      nextReviewTimestamp(
        reviewed.record.stabilityDays,
        Math.min(
          0.99,
          Math.max(
            0.01,
            this.settings.reviewThreshold / 100,
          ),
        ),
        now,
      );

    this.records[file.path] = reviewed.record;
    await this.saveStore();
    return reviewed;
  }

  async saveStore(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      records: this.records,
    } satisfies RecallMapStore);
  }

  private async loadStore(): Promise<void> {
    const stored = (await this.loadData()) as Partial<RecallMapStore> | null;
    this.settings = normalizeSettings(stored?.settings);
    this.records =
      stored?.records && typeof stored.records === "object" ? stored.records : {};
  }
}

class RecallMapView extends ItemView {
  private readonly plugin: RecallMapPlugin;
  private notes: NoteMetric[] = [];
  private currentFilter: DashboardFilter = "needs-review";
  private currentQueue: NoteMetric[] = [];
  private currentQueueIndex = 0;
  private refreshSequence = 0;

  constructor(leaf: WorkspaceLeaf, plugin: RecallMapPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RECALLMAP;
  }

  getDisplayText(): string {
    return "RecallMap";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add("recallmap-content");
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.classList.remove("recallmap-content");
  }

  private async refresh(showLoading = true): Promise<void> {
    const sequence = ++this.refreshSequence;
    if (showLoading) this.renderLoading();

    try {
      const notes = await this.loadNoteMetrics();
      if (sequence !== this.refreshSequence) return;

      this.notes = notes;
      if (
        this.currentFilter === "needs-review" &&
        !notes.some((note) => this.matchesFilter(note, "needs-review"))
      ) {
        this.currentFilter = "learned";
      }
      this.renderDashboard();
    } catch (error) {
      if (sequence !== this.refreshSequence) return;
      console.error("RecallMap could not map the vault.", error);
      this.renderLoadError();
    }
  }

  private async loadNoteMetrics(): Promise<NoteMetric[]> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          !isVaultPathExcluded(file.path, this.plugin.settings.excludedFolders),
      );
    const useFastEstimates = files.length > PRECISE_SCAN_LIMIT;
    if (useFastEstimates) {
      return files
        .map((file) =>
          this.createNoteMetric(
            file,
            estimateWordCountFromBytes(file.stat.size),
            true,
          ),
        )
        .sort((left, right) => left.recall - right.recall);
    }

    const metrics = await Promise.all(
      files.map(async (file): Promise<NoteMetric> => {
        try {
          const content = await this.app.vault.cachedRead(file);
          return this.createNoteMetric(file, countWords(content), false);
        } catch (error) {
          console.warn(`RecallMap used a size estimate for ${file.path}.`, error);
          return this.createNoteMetric(
            file,
            estimateWordCountFromBytes(file.stat.size),
            true,
          );
        }
      }),
    );

    return metrics.sort((left, right) => left.recall - right.recall);
  }

  private createNoteMetric(
    file: TFile,
    wordCount: number,
    wordCountIsEstimate: boolean,
  ): NoteMetric {
    const record = this.plugin.getRecord(file);
    const complexity =
      record.complexityOverride ?? this.plugin.settings.defaultComplexity;

    return {
      file,
      wordCount,
      wordCountIsEstimate,
      record,
      complexity,
      recall:
        record.firstLearnedAt || record.lastReviewed > 0
          ? calculateRecall(record.lastReviewed, record.stabilityDays)
          : 100,
      estimatedSeconds: estimateReviewSeconds(
        wordCount,
        this.plugin.settings.readingWordsPerMinute,
        this.plugin.settings.activeRecallSeconds,
        this.plugin.settings.ratingSeconds,
        complexity,
        this.plugin.settings.complexityMultipliers,
      ),
    };
  }

  private recalculateNoteTime(note: NoteMetric): void {
    note.estimatedSeconds = estimateReviewSeconds(
      note.wordCount,
      this.plugin.settings.readingWordsPerMinute,
      this.plugin.settings.activeRecallSeconds,
      this.plugin.settings.ratingSeconds,
      note.complexity,
      this.plugin.settings.complexityMultipliers,
    );
  }

  private renderLoading(): void {
    const root = this.createRoot();
    this.renderHeader(root, "Memory dashboard");

    const loading = root.createDiv({ cls: "recallmap-loading" });
    const mark = loading.createDiv({ cls: "recallmap-loading__mark" });
    appendIcon(mark, "brain-circuit");
    loading.createEl("h2", { text: "Mapping your memory…" });
    loading.createEl("p", {
      text: "Estimating recall and review time across your vault.",
    });

    const skeleton = loading.createDiv({ cls: "recallmap-loading__skeleton" });
    for (let index = 0; index < 3; index += 1) {
      skeleton.createSpan();
    }
  }

  private renderLoadError(): void {
    const root = this.createRoot();
    this.renderHeader(root, "Memory dashboard");
    const error = root.createDiv({ cls: "recallmap-empty-state" });
    const illustration = error.createDiv({ cls: "recallmap-empty-state__illustration" });
    appendIcon(illustration, "triangle-alert");
    error.createEl("h3", { text: "The memory map could not be completed" });
    error.createEl("p", {
      text: "Check that your vault files are available, adjust excluded folders if needed, then try again.",
    });
    const retry = error.createEl("button", {
      cls: "recallmap-button recallmap-button--primary",
      attr: { type: "button" },
    });
    appendIcon(retry, "refresh-cw");
    retry.createSpan({ text: "Try again" });
    retry.addEventListener("click", () => {
      void this.refresh();
    });
  }

  private renderDashboard(): void {
    const root = this.createRoot();
    this.renderHeader(root, "Memory dashboard");

    const health = this.getMemoryHealth();
    const needsReview = this.notes.filter((note) =>
      this.matchesFilter(note, "needs-review"),
    );
    const totalReviewSeconds = sum(needsReview.map((note) => note.estimatedSeconds));
    const projectedGain = this.notes.length
      ? sum(needsReview.map((note) => 100 - note.recall)) / this.notes.length
      : 0;

    const hero = root.createDiv({ cls: "recallmap-hero-grid" });
    this.renderHealthCard(hero, health);
    this.renderMissionCard(
      hero,
      needsReview,
      totalReviewSeconds,
      health,
      projectedGain,
    );

    const statusSection = root.createEl("section", {
      cls: "recallmap-section recallmap-status-section",
      attr: { "aria-labelledby": "recallmap-status-title" },
    });
    const statusHeading = statusSection.createDiv({ cls: "recallmap-section-heading" });
    const statusHeadingCopy = statusHeading.createDiv();
    statusHeadingCopy.createEl("p", {
      cls: "recallmap-eyebrow",
      text: "Vault signals",
    });
    statusHeadingCopy.createEl("h2", {
      text: "Memory states",
      attr: { id: "recallmap-status-title" },
    });
    statusHeading.createEl("p", {
      cls: "recallmap-section-heading__hint",
      text: "Select any tile to inspect its notes",
    });

    const statusGrid = statusSection.createDiv({ cls: "recallmap-status-grid" });
    for (const definition of STATUS_CARDS) {
      this.renderStatusTile(statusGrid, definition);
    }

    this.renderQueue(root);
  }

  private renderHeader(
    root: HTMLElement,
    context: string,
    onBack?: () => void,
  ): void {
    const header = root.createEl("header", { cls: "recallmap-app-header" });
    const brand = header.createDiv({ cls: "recallmap-brand" });

    if (onBack) {
      const back = brand.createEl("button", {
        cls: "recallmap-icon-button",
        attr: { type: "button", "aria-label": "Back to dashboard" },
      });
      appendIcon(back, "arrow-left");
      back.addEventListener("click", onBack);
    } else {
      const mark = brand.createDiv({ cls: "recallmap-brand__mark" });
      appendIcon(mark, "brain-circuit");
    }

    const copy = brand.createDiv({ cls: "recallmap-brand__copy" });
    copy.createEl("p", { text: context });
    copy.createEl("h1", { text: "RecallMap" });

    if (!onBack) {
      const refresh = header.createEl("button", {
        cls: "recallmap-icon-button",
        attr: { type: "button", "aria-label": "Refresh memory map" },
      });
      appendIcon(refresh, "refresh-cw");
      refresh.addEventListener("click", () => {
        void this.refresh();
      });
    }
  }

  private renderHealthCard(parent: HTMLElement, health: number): void {
    const card = parent.createEl("section", {
      cls: "recallmap-card recallmap-health-card",
      attr: {
        "aria-label": `Overall memory health: ${Math.round(health)} percent`,
      },
    });
    card.dataset.health = getHealthTone(health);

    const glow = card.createDiv({ cls: "recallmap-health-card__glow" });
    glow.setAttribute("aria-hidden", "true");

    const body = card.createDiv({ cls: "recallmap-health-card__body" });
    const copy = body.createDiv({ cls: "recallmap-health-card__copy" });
    copy.createEl("p", { cls: "recallmap-eyebrow", text: "Overall memory health" });
    const scoreRow = copy.createDiv({ cls: "recallmap-health-card__score-row" });
    scoreRow.createEl("strong", { text: `${Math.round(health)}%` });
    scoreRow.createSpan({
      cls: "recallmap-pill recallmap-pill--health",
      text: getHealthLabel(health),
    });
    copy.createEl("p", {
      cls: "recallmap-health-card__description",
      text: getHealthDescription(health, this.notes.length),
    });

    const ring = body.createDiv({ cls: "recallmap-health-ring" });
    ring.style.setProperty("--rm-progress", `${clamp(health, 0, 100) * 3.6}deg`);
    const ringInner = ring.createDiv({ cls: "recallmap-health-ring__inner" });
    appendIcon(ringInner, "activity");
    ringInner.createSpan({ text: "live" });

    const breakdown = card.createDiv({ cls: "recallmap-health-breakdown" });
    breakdown.setAttribute("aria-label", "Memory state distribution");
    const toneCounts = ["forgotten", "weakening", "growing", "strong", "mastered"].map(
      (tone) => ({
        tone,
        count: this.notes.filter(
          (note) =>
            getRecallTone(
              note.recall,
              note.record.reviewCount,
              this.plugin.settings.reviewThreshold,
            ) === tone,
        ).length,
      }),
    );

    for (const entry of toneCounts) {
      const segment = breakdown.createSpan();
      segment.dataset.tone = entry.tone;
      segment.style.flexGrow = String(entry.count || 0.15);
      segment.setAttribute("title", `${capitalize(entry.tone)}: ${entry.count}`);
    }
  }

  private renderMissionCard(
    parent: HTMLElement,
    queue: NoteMetric[],
    totalReviewSeconds: number,
    health: number,
    projectedGain: number,
  ): void {
    const card = parent.createEl("section", {
      cls: "recallmap-card recallmap-mission-card",
      attr: { "aria-labelledby": "recallmap-mission-title" },
    });
    const top = card.createDiv({ cls: "recallmap-mission-card__top" });
    const title = top.createDiv();
    title.createEl("p", { cls: "recallmap-eyebrow", text: "Today’s recall mission" });
    title.createEl("h2", {
      text: queue.length ? "Protect what is fading" : "Your queue is clear",
      attr: { id: "recallmap-mission-title" },
    });
    const badge = top.createSpan({
      cls: "recallmap-live-badge",
      text: queue.length ? `${queue.length} ready` : "On track",
    });
    badge.prepend(createIconElement(queue.length ? "sparkles" : "check"));

    const metrics = card.createDiv({ cls: "recallmap-mission-metrics" });
    renderMissionMetric(metrics, "clock-3", "Estimated session", formatDuration(totalReviewSeconds));
    renderMissionMetric(
      metrics,
      "trending-up",
      "Projected health",
      `${Math.round(clamp(health + projectedGain, 0, 100))}%`,
    );

    card.createEl("p", {
      cls: "recallmap-mission-card__description",
      text: queue.length
        ? `An explicit review can recover about ${Math.round(projectedGain)}% of vault-wide memory health.`
        : "No note is currently below your review threshold. Keep capturing and connecting ideas.",
    });

    const action = card.createEl("button", {
      cls: "recallmap-button recallmap-button--primary recallmap-button--wide",
      attr: { type: "button" },
    });
    appendIcon(action, queue.length ? "play" : "library");
    action.createSpan({ text: queue.length ? "Start recall session" : "Browse all notes" });
    action.addEventListener("click", () => {
      if (queue.length) {
        this.beginReview(queue[0], queue);
      } else {
        this.currentFilter = "learned";
        this.renderDashboard();
        this.scrollQueueIntoView();
      }
    });
  }

  private renderStatusTile(
    parent: HTMLElement,
    definition: StatusCardDefinition,
  ): void {
    const matchingNotes = this.notes.filter((note) =>
      this.matchesFilter(note, definition.filter),
    );
    const tile = parent.createEl("button", {
      cls: "recallmap-status-tile",
      attr: {
        type: "button",
        "aria-pressed": String(this.currentFilter === definition.filter),
        "aria-label": `${FILTER_LABELS[definition.filter]}: ${matchingNotes.length} notes`,
      },
    });
    tile.dataset.tone = definition.tone;
    if (this.currentFilter === definition.filter) tile.classList.add("is-selected");

    const top = tile.createDiv({ cls: "recallmap-status-tile__top" });
    const icon = top.createSpan({ cls: "recallmap-status-tile__icon" });
    appendIcon(icon, definition.icon);
    top.createSpan({ cls: "recallmap-status-tile__arrow" }).append(createIconElement("arrow-up-right"));

    tile.createEl("strong", {
      cls: "recallmap-status-tile__value",
      text: String(matchingNotes.length),
    });
    tile.createSpan({
      cls: "recallmap-status-tile__label",
      text: FILTER_LABELS[definition.filter],
    });
    tile.createSpan({
      cls: "recallmap-status-tile__hint",
      text: definition.hint,
    });

    tile.addEventListener("click", () => {
      this.currentFilter = definition.filter;
      this.renderDashboard();
      this.scrollQueueIntoView();
    });
  }

  private renderQueue(root: HTMLElement): void {
    const filtered = this.notes.filter((note) =>
      this.matchesFilter(note, this.currentFilter),
    );
    const totalSeconds = sum(filtered.map((note) => note.estimatedSeconds));
    const section = root.createEl("section", {
      cls: "recallmap-section recallmap-queue-section",
      attr: { "aria-labelledby": "recallmap-queue-title" },
    });

    const heading = section.createDiv({ cls: "recallmap-queue-heading" });
    const headingCopy = heading.createDiv({ cls: "recallmap-queue-heading__copy" });
    headingCopy.createEl("p", { cls: "recallmap-eyebrow", text: "Selected view" });
    const titleRow = headingCopy.createDiv({ cls: "recallmap-queue-heading__title-row" });
    titleRow.createEl("h2", {
      text: FILTER_LABELS[this.currentFilter],
      attr: { id: "recallmap-queue-title" },
    });
    titleRow.createSpan({
      cls: "recallmap-count-badge",
      text: String(filtered.length),
    });
    headingCopy.createEl("p", {
      text: getFilterDescription(this.currentFilter),
    });

    const headingActions = heading.createDiv({ cls: "recallmap-queue-heading__actions" });
    const time = headingActions.createDiv({ cls: "recallmap-queue-time" });
    appendIcon(time, "clock-3");
    const timeCopy = time.createDiv();
    timeCopy.createSpan({ text: "Estimated" });
    timeCopy.createEl("strong", { text: formatDuration(totalSeconds) });

    if (filtered.length) {
      const reviewAll = headingActions.createEl("button", {
        cls: "recallmap-button recallmap-button--secondary",
        attr: { type: "button" },
      });
      appendIcon(reviewAll, "play");
      reviewAll.createSpan({ text: "Review all" });
      reviewAll.addEventListener("click", () => this.beginReview(filtered[0], filtered));
    }

    if (!filtered.length) {
      this.renderEmptyState(section);
      return;
    }

    const list = section.createDiv({ cls: "recallmap-note-list" });
    list.setAttribute("role", "list");
    for (const note of filtered) this.renderNoteRow(list, note);
  }

  private renderNoteRow(parent: HTMLElement, note: NoteMetric): void {
    const tone = getRecallTone(
      note.recall,
      note.record.reviewCount,
      this.plugin.settings.reviewThreshold,
    );
    const row = parent.createEl("article", {
      cls: "recallmap-note-row",
      attr: { role: "listitem" },
    });
    row.dataset.tone = tone;

    const main = row.createDiv({ cls: "recallmap-note-row__main" });
    const recall = main.createDiv({ cls: "recallmap-note-recall" });
    recall.style.setProperty("--rm-note-progress", `${clamp(note.recall, 0, 100) * 3.6}deg`);
    recall.createEl("strong", { text: `${Math.round(note.recall)}%` });
    recall.createSpan({ text: "recall" });

    const copy = main.createDiv({ cls: "recallmap-note-row__copy" });
    const title = copy.createEl("button", {
      cls: "recallmap-note-row__title",
      text: note.file.basename,
      attr: { type: "button", title: `Open ${note.file.path}` },
    });
    title.addEventListener("click", () => {
      void this.app.workspace.getLeaf(false).openFile(note.file);
    });

    const meta = copy.createDiv({ cls: "recallmap-note-row__meta" });
    renderMetaItem(meta, "folder", note.file.parent?.path || "Vault root");
    renderMetaItem(
      meta,
      "file-text",
      `${note.wordCountIsEstimate ? "~" : ""}${note.wordCount.toLocaleString()} words`,
    );
    renderMetaItem(meta, "history", `${formatDays(note.record.stabilityDays)} stability`);

    if (note.record.lastReviewed > 0 && note.record.firstLearnedAt) {
      const reviewed = meta.createSpan({
        cls: "recallmap-reviewed-chip",
        attr: {
          title: `Last reviewed ${formatReviewedTimestamp(note.record.lastReviewed)}`,
        },
      });
      appendIcon(reviewed, "check-circle-2");
      reviewed.createSpan({
        text: `Reviewed ${formatReviewedTimestamp(note.record.lastReviewed)}`,
      });
    }

    const progress = copy.createDiv({ cls: "recallmap-note-progress" });
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `Estimated recall ${Math.round(note.recall)} percent`);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(Math.round(note.recall)));
    const progressFill = progress.createSpan();
    progressFill.style.width = `${clamp(note.recall, 0, 100)}%`;

    const controls = row.createDiv({ cls: "recallmap-note-row__controls" });
    const time = controls.createDiv({ cls: "recallmap-note-time" });
    time.createSpan({ text: "Review time" });
    time.createEl("strong", { text: formatCompactDuration(note.estimatedSeconds) });

    const complexityWrap = controls.createEl("label", {
      cls: "recallmap-complexity-control",
    });
    complexityWrap.createSpan({ text: "Complexity" });
    const select = complexityWrap.createEl("select", {
      attr: { "aria-label": `Complexity for ${note.file.basename}` },
    });
    select.createEl("option", {
      text: `Default · ${COMPLEXITY_LABELS[this.plugin.settings.defaultComplexity]}`,
      attr: { value: "default" },
    });
    for (const complexity of COMPLEXITY_LEVELS) {
      select.createEl("option", {
        text: COMPLEXITY_LABELS[complexity],
        attr: { value: complexity },
      });
    }
    select.value = note.record.complexityOverride ?? "default";
    select.addEventListener("change", () => {
      const nextValue = select.value;
      const override = nextValue === "default" ? undefined : (nextValue as NoteComplexity);
      void this.updateNoteComplexity(note, override);
    });

    const review = controls.createEl("button", {
      cls: "recallmap-button recallmap-button--review",
      attr: { type: "button" },
    });
    appendIcon(review, "brain");
    review.createSpan({ text: "Review" });
    review.addEventListener("click", () => this.beginReview(note, [note]));
  }

  private renderEmptyState(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: "recallmap-empty-state" });
    const illustration = empty.createDiv({ cls: "recallmap-empty-state__illustration" });
    appendIcon(illustration, this.notes.length ? "check-circle-2" : "notebook-pen");
    empty.createEl("h3", {
      text: this.notes.length ? "Nothing in this state" : "Your map is ready for notes",
    });
    empty.createEl("p", {
      text: this.notes.length
        ? "Choose another memory tile, or enjoy the space you have already strengthened."
        : "Create Markdown notes in your vault and RecallMap will estimate their memory health automatically.",
    });

    if (this.notes.length) {
      const browse = empty.createEl("button", {
        cls: "recallmap-button recallmap-button--secondary",
        attr: { type: "button" },
      });
      appendIcon(browse, "library");
      browse.createSpan({ text: "Browse all notes" });
      browse.addEventListener("click", () => {
        this.currentFilter = "learned";
        this.renderDashboard();
        this.scrollQueueIntoView();
      });
    }
  }

  private async updateNoteComplexity(
    note: NoteMetric,
    override: NoteComplexity | undefined,
  ): Promise<void> {
    const previousScrollTop = this.contentEl.scrollTop;
    await this.plugin.setComplexity(note.file, override);
    note.record = this.plugin.getRecord(note.file);
    note.complexity = override ?? this.plugin.settings.defaultComplexity;
    this.recalculateNoteTime(note);
    this.renderDashboard();
    this.contentEl.scrollTop = previousScrollTop;
  }

  private beginReview(note: NoteMetric, queue: NoteMetric[]): void {
    this.currentQueue = queue;
    this.currentQueueIndex = Math.max(0, queue.findIndex((item) => item.file.path === note.file.path));
    this.renderRecallStage(note);
  }

  private renderRecallStage(note: NoteMetric): void {
    const root = this.createRoot("recallmap-view--review");
    this.renderHeader(root, "Active recall", () => {
      void this.refresh(false);
    });

    this.renderSessionProgress(root);
    const shell = root.createDiv({ cls: "recallmap-review-shell" });
    const stage = shell.createDiv({ cls: "recallmap-review-stage" });

    const heading = stage.createDiv({ cls: "recallmap-review-heading" });
    heading.createEl("p", { cls: "recallmap-eyebrow", text: "Recall before you reveal" });
    heading.createEl("h2", { text: note.file.basename });
    heading.createEl("p", {
      text: "Pause, reconstruct the key idea in your own words, then reveal the note to check yourself.",
    });

    const prompt = stage.createDiv({ cls: "recallmap-recall-prompt" });
    const promptIcon = prompt.createDiv({ cls: "recallmap-recall-prompt__icon" });
    appendIcon(promptIcon, "brain-circuit");
    prompt.createEl("p", { text: "What can you recall?" });
    prompt.createEl("strong", { text: note.file.basename });
    prompt.createSpan({
      text: "Think about the definition, connections, examples, and anything that surprised you.",
    });

    const metrics = stage.createDiv({ cls: "recallmap-review-snapshot" });
    renderSnapshotMetric(metrics, "activity", "Before review", `${Math.round(note.recall)}% recall`);
    renderSnapshotMetric(
      metrics,
      "shield",
      "Current stability",
      formatDays(note.record.stabilityDays),
    );
    renderSnapshotMetric(
      metrics,
      "clock-3",
      "Estimated time",
      formatDuration(note.estimatedSeconds),
    );

    const reveal = stage.createEl("button", {
      cls: "recallmap-button recallmap-button--primary recallmap-button--reveal",
      attr: { type: "button" },
    });
    appendIcon(reveal, "eye");
    reveal.createSpan({ text: "Reveal note" });
    reveal.addEventListener("click", () => {
      void this.renderAnswerStage(stage, note);
    });

    stage.createEl("p", {
      cls: "recallmap-review-footnote",
      text: "Opening a note does not count as a review. Only a rating updates memory stability.",
    });
  }

  private async renderAnswerStage(stage: HTMLElement, note: NoteMetric): Promise<void> {
    stage.empty();
    const heading = stage.createDiv({ cls: "recallmap-review-heading" });
    heading.createEl("p", { cls: "recallmap-eyebrow", text: "Answer revealed" });
    heading.createEl("h2", { text: note.file.basename });
    heading.createEl("p", {
      text: "Compare the note with what you reconstructed, then rate the quality of your recall.",
    });

    const answer = stage.createDiv({ cls: "recallmap-answer-card" });
    const answerBar = answer.createDiv({ cls: "recallmap-answer-card__bar" });
    const answerLabel = answerBar.createDiv();
    appendIcon(answerLabel, "file-text");
    answerLabel.createSpan({ text: "Source note" });
    const open = answerBar.createEl("button", {
      cls: "recallmap-text-button",
      attr: { type: "button" },
    });
    open.createSpan({ text: "Open note" });
    appendIcon(open, "arrow-up-right");
    open.addEventListener("click", () => {
      void this.app.workspace.getLeaf(false).openFile(note.file);
    });

    const content = answer.createDiv({ cls: "recallmap-answer-card__content markdown-rendered" });
    try {
      const markdown = await this.app.vault.cachedRead(note.file);
      note.wordCount = countWords(markdown);
      note.wordCountIsEstimate = false;
      this.recalculateNoteTime(note);
      await MarkdownRenderer.render(this.app, markdown, content, note.file.path, this);
    } catch (error) {
      console.error(`RecallMap could not reveal ${note.file.path}.`, error);
      content.createEl("p", {
        text: "This note could not be loaded. Open the source note and make sure it is available locally before rating your recall.",
      });
      new Notice(`RecallMap could not load “${note.file.basename}”.`);
    }

    const ratingPanel = stage.createDiv({ cls: "recallmap-rating-panel" });
    ratingPanel.createEl("h3", { text: "How easy was the recall?" });
    ratingPanel.createEl("p", {
      text: "Choose the result that best reflects your memory before revealing the note.",
    });
    const ratings = ratingPanel.createDiv({ cls: "recallmap-rating-grid" });
    for (const definition of REVIEW_RATINGS) {
      const button = ratings.createEl("button", {
        cls: "recallmap-rating-button",
        attr: { type: "button" },
      });
      button.dataset.rating = definition.rating;
      const icon = button.createSpan({ cls: "recallmap-rating-button__icon" });
      appendIcon(icon, definition.icon);
      const copy = button.createSpan({ cls: "recallmap-rating-button__copy" });
      copy.createEl("strong", { text: definition.label });
      copy.createSpan({ text: definition.hint });
      button.addEventListener("click", () => {
        void this.finishReview(note, definition.rating);
      });
    }
  }

  private async finishReview(note: NoteMetric, rating: ReviewRating): Promise<void> {
    const reviewed = await this.plugin.recordReview(note.file, rating);
    note.record = reviewed.record;
    note.recall = 100;
    this.renderReviewResult(note, reviewed.result, rating);
  }

  private renderReviewResult(
    note: NoteMetric,
    result: ReviewResult,
    rating: ReviewRating,
  ): void {
    const root = this.createRoot("recallmap-view--review");
    this.renderHeader(root, "Review complete", () => {
      void this.refresh(false);
    });
    this.renderSessionProgress(root);

    const resultCard = root.createEl("section", {
      cls: "recallmap-result-card",
      attr: { "aria-live": "polite" },
    });
    resultCard.dataset.rating = rating;
    const celebration = resultCard.createDiv({ cls: "recallmap-result-card__celebration" });
    appendIcon(celebration, rating === "forgotten" ? "refresh-cw" : "sparkles");
    resultCard.createEl("p", {
      cls: "recallmap-eyebrow",
      text: rating === "forgotten" ? "Memory reset" : "Memory strengthened",
    });
    resultCard.createEl("h2", { text: note.file.basename });
    resultCard.createEl("p", {
      cls: "recallmap-result-card__summary",
      text:
        rating === "forgotten"
          ? "That honest rating is useful—the note is now scheduled from a shorter stability interval."
          : `You rated this ${capitalize(rating)}. Recall is restored and the next decay window is longer.`,
    });

    const metrics = resultCard.createDiv({ cls: "recallmap-result-metrics" });
    renderResultMetric(
      metrics,
      "trending-up",
      "Memory gained",
      `+${Math.round(result.memoryGain)}%`,
      `${Math.round(result.previousRecall)}% → 100% recall`,
    );
    renderResultMetric(
      metrics,
      "shield-check",
      "Stability",
      formatDays(result.newStabilityDays),
      `${formatDays(result.previousStabilityDays)} before review`,
    );
    renderResultMetric(
      metrics,
      "calendar-clock",
      "Next review window",
      `~${formatDays(result.newStabilityDays)}`,
      "At the current decay rate",
    );

    const actions = resultCard.createDiv({ cls: "recallmap-result-actions" });
    const dashboard = actions.createEl("button", {
      cls: "recallmap-button recallmap-button--secondary",
      attr: { type: "button" },
    });
    appendIcon(dashboard, "layout-dashboard");
    dashboard.createSpan({ text: "Back to dashboard" });
    dashboard.addEventListener("click", () => {
      void this.refresh(false);
    });

    const hasNext = this.currentQueueIndex + 1 < this.currentQueue.length;
    const next = actions.createEl("button", {
      cls: "recallmap-button recallmap-button--primary",
      attr: { type: "button" },
    });
    appendIcon(next, hasNext ? "arrow-right" : "check");
    next.createSpan({ text: hasNext ? "Next note" : "Finish session" });
    next.addEventListener("click", () => {
      if (hasNext) {
        this.currentQueueIndex += 1;
        this.renderRecallStage(this.currentQueue[this.currentQueueIndex]);
      } else {
        void this.refresh(false);
      }
    });
  }

  private renderSessionProgress(parent: HTMLElement): void {
    const total = Math.max(1, this.currentQueue.length);
    const current = Math.min(this.currentQueueIndex + 1, total);
    const session = parent.createDiv({ cls: "recallmap-session-progress" });
    const labels = session.createDiv({ cls: "recallmap-session-progress__labels" });
    labels.createSpan({ text: "Recall session" });
    labels.createEl("strong", { text: `${current} of ${total}` });
    const track = session.createDiv({ cls: "recallmap-session-progress__track" });
    const fill = track.createSpan();
    fill.style.width = `${(current / total) * 100}%`;
  }

  private matchesFilter(note: NoteMetric, filter: DashboardFilter): boolean {
    return matchesDashboardFilter(
      { recall: note.recall, reviewCount: note.record.reviewCount },
      filter,
      this.plugin.settings.reviewThreshold,
    );
  }

  private getMemoryHealth(): number {
    if (!this.notes.length) return 0;
    return sum(this.notes.map((note) => note.recall)) / this.notes.length;
  }

  private scrollQueueIntoView(): void {
    window.setTimeout(() => {
      this.contentEl.querySelector(".recallmap-queue-section")?.scrollIntoView({
        block: "start",
      });
    }, 0);
  }

  private createRoot(additionalClass?: string): HTMLDivElement {
    this.contentEl.empty();
    const classes = ["recallmap-view", additionalClass].filter(Boolean).join(" ");
    return this.contentEl.createDiv({ cls: classes });
  }
}

class RecallMapSettingTab extends PluginSettingTab {
  private readonly plugin: RecallMapPlugin;
  private previewUpdater: (() => void) | null = null;

  constructor(plugin: RecallMapPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const numericSetting = (
      name: string,
      desc: string,
      key: string,
      min: number,
      max: number,
      step: number,
    ): SettingDefinition => ({
      name,
      desc,
      control: {
        type: "number",
        key,
        min,
        max,
        step,
        validate: (value: number) =>
          Number.isFinite(value) && value >= min && value <= max
            ? undefined
            : `Enter a value between ${min} and ${max}.`,
      },
    });

    return [
      {
        name: "Interactive review-time preview",
        desc: "Estimate review duration for a sample 500-word note.",
        searchable: false,
        render: (setting) => {
          const container = setting.settingEl;
          container.classList.add("recallmap-settings-preview");

          const preview = container.createDiv({
            cls: "recallmap-preview-grid",
          });

          const sample = preview.createDiv({
            cls: "recallmap-sample-note",
          });

          const sampleTop = sample.createDiv({
            cls: "recallmap-sample-note__top",
          });

          const sampleIcon = sampleTop.createSpan({
            cls: "recallmap-sample-note__icon",
          });
          appendIcon(sampleIcon, "network");

          const sampleTitle = sampleTop.createDiv();
          sampleTitle.createSpan({ text: "Sample note" });
          sampleTitle.createEl("strong", {
            text: "Kafka Connect Architecture",
          });

          const sampleMeta = sample.createDiv({
            cls: "recallmap-sample-note__meta",
          });

          renderMetaItem(sampleMeta, "file-text", "500 words");

          const result = preview.createDiv({
            cls: "recallmap-preview-result",
          });

          const label = result.createEl("label", {
            cls: "recallmap-preview-result__control",
          });
          label.createSpan({ text: "Preview complexity" });

          const select = label.createEl("select");

          for (const level of COMPLEXITY_LEVELS) {
            select.createEl("option", {
              text: COMPLEXITY_LABELS[level],
              attr: { value: level },
            });
          }

          select.value = this.plugin.settings.defaultComplexity;

          const estimateLabel = result.createSpan({
            text: "Estimated review",
          });
          estimateLabel.classList.add(
            "recallmap-preview-result__label",
          );

          const estimateValue = result.createEl("strong", {
            cls: "recallmap-preview-result__value",
          });

          const formula = result.createDiv({
            cls: "recallmap-preview-formula",
          });

          const baseValue = formula.createSpan();
          formula.createSpan({ text: "×" });
          const multiplierValue = formula.createSpan();

          const updatePreview = (): void => {
            const settings = this.plugin.settings;
            const complexity = select.value as NoteComplexity;

            const baseSeconds = estimateReviewSeconds(
              500,
              settings.readingWordsPerMinute,
              settings.activeRecallSeconds,
              settings.ratingSeconds,
              "normal",
              { ...settings.complexityMultipliers, normal: 1 },
            );

            const estimate = estimateReviewSeconds(
              500,
              settings.readingWordsPerMinute,
              settings.activeRecallSeconds,
              settings.ratingSeconds,
              complexity,
              settings.complexityMultipliers,
            );

            estimateValue.setText(formatDuration(estimate));
            baseValue.setText(
              `${formatDuration(baseSeconds)} base`,
            );
            multiplierValue.setText(
              `${settings.complexityMultipliers[complexity].toFixed(1)}× complexity`,
            );
          };

          select.addEventListener("change", updatePreview);
          updatePreview();

          this.previewUpdater = updatePreview;

          return () => {
            select.removeEventListener("change", updatePreview);
            if (this.previewUpdater === updatePreview) {
              this.previewUpdater = null;
            }
          };
        },
      },
      {
        type: "group",
        heading: "Vault scope",
        items: [
          {
            name: "Excluded folders",
            desc: "Enter vault-relative folder paths, one per line.",
            control: {
              type: "textarea",
              key: "excludedFolders",
              rows: 5,
              placeholder: "Templates\\nArchive\\n00 Inbox/Imports",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Timing model",
        items: [
          numericSetting(
            "Reading speed",
            "Average words read per minute.",
            "readingWordsPerMinute",
            50, 1000, 10,
          ),
          numericSetting(
            "Active recall time",
            "Thinking time before revealing a note.",
            "activeRecallSeconds",
            0, 600, 5,
          ),
          numericSetting(
            "Rating time",
            "Time allowed to rate a review.",
            "ratingSeconds",
            0, 300, 5,
          ),
        ],
      },
      {
        type: "group",
        heading: "Memory model",
        items: [
          numericSetting(
            "Review threshold",
            "Recall percentage below which a note needs review.",
            "reviewThreshold",
            20, 90, 5,
          ),
          numericSetting(
            "Initial stability",
            "Initial memory stability in days.",
            "initialStabilityDays",
            1, 365, 1,
          ),
          {
            name: "Default note complexity",
            desc: "Default complexity assigned to notes.",
            control: {
              type: "dropdown",
              key: "defaultComplexity",
              options: Object.fromEntries(
                COMPLEXITY_LEVELS.map((level) => [
                  level,
                  COMPLEXITY_LABELS[level],
                ]),
              ),
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Complexity multipliers",
        items: [
          ...COMPLEXITY_LEVELS.map((level) =>
            numericSetting(
              COMPLEXITY_LABELS[level],
              getComplexityDescription(level),
              `complexityMultipliers.${level}`,
              0.1, 5, 0.1,
            ),
          ),
          {
            name: "Restore recommended multipliers",
            desc: "Reset complexity multipliers to RecallMap defaults.",
            action: () => {
              this.plugin.settings.complexityMultipliers = {
                ...DEFAULT_COMPLEXITY_MULTIPLIERS,
              };
              void this.plugin.saveStore()
                .then(() => {
                  new Notice("RecallMap complexity multipliers restored.");
                  this.display();
                })
                .catch((error: unknown) => {
                  console.error("RecallMap: Failed to restore multipliers", error);
                  new Notice("Could not save RecallMap settings.");
                });
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "excludedFolders") {
      return this.plugin.settings.excludedFolders.join("\\n");
    }

    if (key.startsWith("complexityMultipliers.")) {
      const level = key.split(".")[1] as NoteComplexity;
      return COMPLEXITY_LEVELS.includes(level)
        ? this.plugin.settings.complexityMultipliers[level]
        : undefined;
    }

    if (key in this.plugin.settings) {
      return this.plugin.settings[key as keyof RecallMapSettings];
    }

    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;

    if (key === "excludedFolders") {
      if (typeof value !== "string") return;
      settings.excludedFolders = normalizeExcludedFolders(value);
    } else if (key.startsWith("complexityMultipliers.")) {
      const level = key.split(".")[1] as NoteComplexity;
      if (!COMPLEXITY_LEVELS.includes(level)) return;
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      if (value < 0.1 || value > 5) return;
      settings.complexityMultipliers[level] = value;
    } else if (key === "defaultComplexity") {
      if (!COMPLEXITY_LEVELS.includes(value as NoteComplexity)) return;
      settings.defaultComplexity = value as NoteComplexity;
    } else {
      const ranges: Record<string, [number, number]> = {
        readingWordsPerMinute: [50, 1000],
        activeRecallSeconds: [0, 600],
        ratingSeconds: [0, 300],
        reviewThreshold: [20, 90],
        initialStabilityDays: [1, 365],
      };

      const range = ranges[key];
      if (!range || typeof value !== "number") return;
      if (!Number.isFinite(value)) return;
      if (value < range[0] || value > range[1]) return;

      switch (key) {
        case "readingWordsPerMinute":
          settings.readingWordsPerMinute = value;
          break;
        case "activeRecallSeconds":
          settings.activeRecallSeconds = value;
          break;
        case "ratingSeconds":
          settings.ratingSeconds = value;
          break;
        case "reviewThreshold":
          settings.reviewThreshold = value;
          break;
        case "initialStabilityDays":
          settings.initialStabilityDays = value;
          break;
      }
    }

    await this.plugin.saveStore();
    this.previewUpdater?.();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.classList.add("recallmap-settings");

    const hero = containerEl.createDiv({ cls: "recallmap-settings-hero" });
    const mark = hero.createDiv({ cls: "recallmap-settings-hero__mark" });
    appendIcon(mark, "sliders-horizontal");
    const heroCopy = hero.createDiv();
    heroCopy.createEl("p", { cls: "recallmap-eyebrow", text: "RecallMap preferences" });
    new Setting(heroCopy)
      .setName("Tune the experience, not the science")
      .setHeading();
    heroCopy.createEl("p", {
      text: "Adjust reading and complexity estimates while keeping recall probability and memory stability independent.",
    });

    let previewComplexity = this.plugin.settings.defaultComplexity;
    const preview = containerEl.createEl("section", {
      cls: "recallmap-settings-card recallmap-settings-preview",
      attr: { "aria-labelledby": "recallmap-preview-title" },
    });
    const previewHeading = preview.createDiv({ cls: "recallmap-settings-card__heading" });
    const previewHeadingCopy = previewHeading.createDiv();
    previewHeadingCopy.createEl("p", { cls: "recallmap-eyebrow", text: "Live example" });
    new Setting(previewHeadingCopy)
      .setName("See complexity in context")
      .setHeading()
      .settingEl.setAttribute("id", "recallmap-preview-title");
    previewHeading.createSpan({
      cls: "recallmap-pill recallmap-pill--accent",
      text: "Updates instantly",
    });

    const previewGrid = preview.createDiv({ cls: "recallmap-preview-grid" });
    const sample = previewGrid.createDiv({ cls: "recallmap-sample-note" });
    const sampleTop = sample.createDiv({ cls: "recallmap-sample-note__top" });
    const sampleIcon = sampleTop.createSpan({ cls: "recallmap-sample-note__icon" });
    appendIcon(sampleIcon, "network");
    const sampleTitle = sampleTop.createDiv();
    sampleTitle.createSpan({ text: "Sample note" });
    sampleTitle.createEl("strong", { text: "Kafka Connect Architecture" });
    const sampleMeta = sample.createDiv({ cls: "recallmap-sample-note__meta" });
    renderMetaItem(sampleMeta, "file-text", "500 words");
    const activeRecallPreview = renderMetaItem(
      sampleMeta,
      "brain",
      `${this.plugin.settings.activeRecallSeconds}s active recall`,
    );
    const ratingPreview = renderMetaItem(
      sampleMeta,
      "mouse-pointer-click",
      `${this.plugin.settings.ratingSeconds}s rating`,
    );

    const previewResult = previewGrid.createDiv({ cls: "recallmap-preview-result" });
    const previewControl = previewResult.createEl("label", {
      cls: "recallmap-preview-result__control",
    });
    previewControl.createSpan({ text: "Preview complexity" });
    const previewSelect = previewControl.createEl("select");
    for (const complexity of COMPLEXITY_LEVELS) {
      previewSelect.createEl("option", {
        text: COMPLEXITY_LABELS[complexity],
        attr: { value: complexity },
      });
    }
    previewSelect.value = previewComplexity;

    const estimateLabel = previewResult.createSpan({ text: "Estimated review" });
    estimateLabel.classList.add("recallmap-preview-result__label");
    const estimateValue = previewResult.createEl("strong", {
      cls: "recallmap-preview-result__value",
    });
    const formula = previewResult.createDiv({ cls: "recallmap-preview-formula" });
    const baseValue = formula.createSpan();
    formula.createSpan({ text: "×" });
    const multiplierValue = formula.createSpan();

    const updatePreview = (): void => {
      const baseSeconds = estimateReviewSeconds(
        500,
        this.plugin.settings.readingWordsPerMinute,
        this.plugin.settings.activeRecallSeconds,
        this.plugin.settings.ratingSeconds,
        "normal",
        { ...this.plugin.settings.complexityMultipliers, normal: 1 },
      );
      const estimate = estimateReviewSeconds(
        500,
        this.plugin.settings.readingWordsPerMinute,
        this.plugin.settings.activeRecallSeconds,
        this.plugin.settings.ratingSeconds,
        previewComplexity,
        this.plugin.settings.complexityMultipliers,
      );
      estimateValue.setText(formatDuration(estimate));
      baseValue.setText(`${formatDuration(baseSeconds)} base`);
      multiplierValue.setText(
        `${this.plugin.settings.complexityMultipliers[previewComplexity].toFixed(1)}× complexity`,
      );
      activeRecallPreview.setText(
        `${this.plugin.settings.activeRecallSeconds}s active recall`,
      );
      ratingPreview.setText(`${this.plugin.settings.ratingSeconds}s rating`);
    };

    previewSelect.addEventListener("change", () => {
      previewComplexity = previewSelect.value as NoteComplexity;
      updatePreview();
    });
    updatePreview();

    const scope = this.createSettingsSection(
      containerEl,
      "Vault scope",
      "Keep archives, templates, imports, or any private workspace out of RecallMap.",
      "folder-x",
    );
    let scopeSummary: HTMLDivElement | null = null;
    const updateScopeSummary = (folders: readonly string[]): void => {
      if (!scopeSummary) return;
      scopeSummary.empty();
      const icon = scopeSummary.createDiv({ cls: "recallmap-scope-summary__icon" });
      appendIcon(icon, folders.length ? "folder-minus" : "folder-check");
      const copy = scopeSummary.createDiv();
      copy.createEl("strong", {
        text: folders.length
          ? `${folders.length} folder${folders.length === 1 ? "" : "s"} excluded`
          : "All vault folders are included",
      });
      copy.createEl("p", {
        text: folders.length
          ? "Each path also excludes every folder and note beneath it."
          : "Add vault-relative paths whenever part of the vault should stay outside the memory map.",
      });
    };

    const excludedFolders = new Setting(scope)
      .setName("Excluded folders")
      .setDesc(
        "Enter one vault-relative folder path per line. Examples: Templates, Archive/Cold, 00 Inbox/Imports. Changes apply on the next dashboard refresh.",
      )
      .addTextArea((textArea) => {
        textArea.setPlaceholder("Templates\nArchive\n00 Inbox/Imports");
        textArea.setValue(this.plugin.settings.excludedFolders.join("\n"));
        textArea.inputEl.rows = 5;
        textArea.inputEl.spellcheck = false;
        textArea.inputEl.setAttribute("aria-label", "Folders excluded from RecallMap");
        textArea.onChange((value) => {
          const folders = normalizeExcludedFolders(value);
          this.plugin.settings.excludedFolders = folders;
          updateScopeSummary(folders);
          void this.plugin.saveStore();
        });
      });
    excludedFolders.settingEl.classList.add(
      "recallmap-setting-row",
      "recallmap-setting-row--textarea",
    );

    scopeSummary = scope.createDiv({ cls: "recallmap-scope-summary" });
    updateScopeSummary(this.plugin.settings.excludedFolders);

    const timing = this.createSettingsSection(
      containerEl,
      "Timing model",
      "These inputs estimate how long a review will take. They do not change the forgetting curve.",
      "clock-3",
    );

    this.addNumberSetting(
      timing,
      "Reading speed",
      "Average words read per minute while checking a revealed note.",
      this.plugin.settings.readingWordsPerMinute,
      50,
      1000,
      10,
      async (value) => {
        this.plugin.settings.readingWordsPerMinute = value;
        await this.plugin.saveStore();
        updatePreview();
      },
      "words/min",
    );

    this.addNumberSetting(
      timing,
      "Active recall time",
      "Thinking time reserved before the note is revealed.",
      this.plugin.settings.activeRecallSeconds,
      0,
      600,
      5,
      async (value) => {
        this.plugin.settings.activeRecallSeconds = value;
        await this.plugin.saveStore();
        updatePreview();
      },
      "seconds",
    );

    this.addNumberSetting(
      timing,
      "Rating time",
      "Time allowed to compare your recall and choose a result.",
      this.plugin.settings.ratingSeconds,
      0,
      300,
      5,
      async (value) => {
        this.plugin.settings.ratingSeconds = value;
        await this.plugin.saveStore();
        updatePreview();
      },
      "seconds",
    );

    const memory = this.createSettingsSection(
      containerEl,
      "Memory model",
      "Set when a note enters the review queue and how new notes begin.",
      "activity",
    );

    this.addNumberSetting(
      memory,
      "Review threshold",
      "Notes below this estimated recall percentage appear in Needs review.",
      this.plugin.settings.reviewThreshold,
      20,
      90,
      5,
      async (value) => {
        this.plugin.settings.reviewThreshold = value;
        await this.plugin.saveStore();
      },
      "% recall",
    );

    this.addNumberSetting(
      memory,
      "Initial stability",
      "Starting stability window for notes that have not been explicitly reviewed.",
      this.plugin.settings.initialStabilityDays,
      1,
      365,
      1,
      async (value) => {
        this.plugin.settings.initialStabilityDays = value;
        await this.plugin.saveStore();
      },
      "days",
    );

    const defaultComplexity = new Setting(memory)
      .setName("Default note complexity")
      .setDesc("Applied automatically until a note receives a manual override.")
      .addDropdown((dropdown) => {
        for (const complexity of COMPLEXITY_LEVELS) {
          dropdown.addOption(complexity, COMPLEXITY_LABELS[complexity]);
        }
        dropdown.setValue(this.plugin.settings.defaultComplexity);
        dropdown.onChange((value) => {
          const complexity = value as NoteComplexity;
          this.plugin.settings.defaultComplexity = complexity;
          previewComplexity = complexity;
          previewSelect.value = complexity;
          void this.plugin.saveStore().then(updatePreview);
        });
      });
    defaultComplexity.settingEl.classList.add("recallmap-setting-row");

    const complexity = this.createSettingsSection(
      containerEl,
      "Complexity multipliers",
      "Fine-tune review-time estimates. Every note can override the default from the dashboard.",
      "sliders-horizontal",
    );

    for (const level of COMPLEXITY_LEVELS) {
      this.addNumberSetting(
        complexity,
        COMPLEXITY_LABELS[level],
        getComplexityDescription(level),
        this.plugin.settings.complexityMultipliers[level],
        0.1,
        5,
        0.1,
        async (value) => {
          this.plugin.settings.complexityMultipliers[level] = value;
          await this.plugin.saveStore();
          updatePreview();
        },
        "× base",
      );
    }

    const reset = new Setting(complexity)
      .setName("Restore recommended multipliers")
      .setDesc("Reset only the five complexity multipliers to RecallMap defaults.")
      .addButton((button) => {
        button.setButtonText("Restore defaults");
        button.setIcon("rotate-ccw");
        button.onClick(() => {
          this.plugin.settings.complexityMultipliers = {
            ...DEFAULT_COMPLEXITY_MULTIPLIERS,
          };
          void this.plugin.saveStore().then(() => {
            new Notice("RecallMap complexity multipliers restored.");
            this.display();
          });
        });
      });
    reset.settingEl.classList.add("recallmap-setting-row", "recallmap-setting-row--reset");

    const boundary = containerEl.createDiv({ cls: "recallmap-model-boundary" });
    const boundaryIcon = boundary.createDiv({ cls: "recallmap-model-boundary__icon" });
    appendIcon(boundaryIcon, "shield-check");
    const boundaryCopy = boundary.createDiv();
    boundaryCopy.createEl("strong", { text: "Complexity changes time—nothing else" });
    boundaryCopy.createEl("p", {
      text: "Manual complexity never affects recall probability, memory stability, Ebbinghaus decay, or review scheduling.",
    });
  }

  private createSettingsSection(
    parent: HTMLElement,
    title: string,
    description: string,
    iconName: string,
  ): HTMLElement {
    const section = parent.createEl("section", { cls: "recallmap-settings-card" });
    const heading = section.createDiv({ cls: "recallmap-settings-card__heading" });
    const icon = heading.createDiv({ cls: "recallmap-settings-card__icon" });
    appendIcon(icon, iconName);
    const copy = heading.createDiv();
    new Setting(copy)
      .setName(title)
      .setHeading();
    copy.createEl("p", { text: description });
    return section;
  }

  private addNumberSetting(
    parent: HTMLElement,
    name: string,
    description: string,
    value: number,
    minimum: number,
    maximum: number,
    step: number,
    onValidChange: (value: number) => Promise<void>,
    suffix: string,
  ): void {
    const setting = new Setting(parent)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.setValue(String(value));
        text.inputEl.type = "number";
        text.inputEl.min = String(minimum);
        text.inputEl.max = String(maximum);
        text.inputEl.step = String(step);
        text.inputEl.setAttribute("aria-label", `${name} in ${suffix}`);
        text.onChange((rawValue) => {
          const parsed = Number(rawValue);
          const valid = Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
          text.inputEl.classList.toggle("is-invalid", !valid);
          if (valid) void onValidChange(parsed);
        });
      });

    setting.settingEl.classList.add("recallmap-setting-row");
    const control = setting.controlEl.createSpan({
      cls: "recallmap-setting-suffix",
      text: suffix,
    });
    control.setAttribute("aria-hidden", "true");
  }
}

function formatReviewedTimestamp(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsed < minute) return "just now";

  if (elapsed < hour) {
    const minutes = Math.floor(elapsed / minute);
    return `${minutes} min ago`;
  }

  const reviewed = new Date(timestamp);
  const current = new Date(now);

  const reviewedDay = new Date(
    reviewed.getFullYear(),
    reviewed.getMonth(),
    reviewed.getDate(),
  ).getTime();

  const currentDay = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  ).getTime();

  const dayDifference = Math.round((currentDay - reviewedDay) / day);

  const time = reviewed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (dayDifference === 0) return `today at ${time}`;
  if (dayDifference === 1) return `yesterday at ${time}`;

  return reviewed.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function normalizeRecord(
  record: MemoryRecord,
  settings: RecallMapSettings,
): MemoryRecord {
  const rawLastReviewed = Number(record.lastReviewed);
  const lastReviewed =
    Number.isFinite(rawLastReviewed) && rawLastReviewed > 0
      ? rawLastReviewed
      : 0;

  const complexityOverride = COMPLEXITY_LEVELS.includes(
    record.complexityOverride as NoteComplexity,
  )
    ? record.complexityOverride
    : undefined;

  const firstLearnedAt =
    typeof record.firstLearnedAt === "number" &&
    Number.isFinite(record.firstLearnedAt) &&
    record.firstLearnedAt > 0
      ? record.firstLearnedAt
      : lastReviewed > 0
        ? lastReviewed
        : undefined;

  const nextReviewAt =
    typeof record.nextReviewAt === "number" &&
    Number.isFinite(record.nextReviewAt) &&
    record.nextReviewAt > 0
      ? record.nextReviewAt
      : undefined;

  const history = Array.isArray(record.history)
    ? record.history
    : [];

  return {
    lastReviewed,
    stabilityDays: positiveNumber(
      record.stabilityDays,
      settings.initialStabilityDays,
    ),
    reviewCount: Math.max(
      0,
      Math.floor(positiveNumber(record.reviewCount, 0)),
    ),
    lapseCount: Math.max(
      0,
      Math.floor(positiveNumber(record.lapseCount ?? 0, 0)),
    ),
    history,
    ...(firstLearnedAt ? { firstLearnedAt } : {}),
    ...(nextReviewAt ? { nextReviewAt } : {}),
    ...(complexityOverride ? { complexityOverride } : {}),
  };
}

function normalizeSettings(
  stored: Partial<RecallMapSettings> | undefined,
): RecallMapSettings {
  const defaultComplexity = COMPLEXITY_LEVELS.includes(
    stored?.defaultComplexity as NoteComplexity,
  )
    ? (stored?.defaultComplexity as NoteComplexity)
    : DEFAULT_SETTINGS.defaultComplexity;
  const multipliers = { ...DEFAULT_COMPLEXITY_MULTIPLIERS };

  for (const level of COMPLEXITY_LEVELS) {
    multipliers[level] = boundedNumber(
      stored?.complexityMultipliers?.[level],
      DEFAULT_COMPLEXITY_MULTIPLIERS[level],
      0.1,
      5,
    );
  }

  return {
    excludedFolders: normalizeExcludedFolders(stored?.excludedFolders),
    defaultComplexity,
    complexityMultipliers: multipliers,
    readingWordsPerMinute: boundedNumber(
      stored?.readingWordsPerMinute,
      DEFAULT_SETTINGS.readingWordsPerMinute,
      50,
      1000,
    ),
    activeRecallSeconds: boundedNumber(
      stored?.activeRecallSeconds,
      DEFAULT_SETTINGS.activeRecallSeconds,
      0,
      600,
    ),
    ratingSeconds: boundedNumber(
      stored?.ratingSeconds,
      DEFAULT_SETTINGS.ratingSeconds,
      0,
      300,
    ),
    initialStabilityDays: boundedNumber(
      stored?.initialStabilityDays,
      DEFAULT_SETTINGS.initialStabilityDays,
      1,
      365,
    ),
    reviewThreshold: boundedNumber(
      stored?.reviewThreshold,
      DEFAULT_SETTINGS.reviewThreshold,
      20,
      90,
    ),
  };
}

function positiveNumber(value: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function createIconElement(iconName: string): HTMLSpanElement {
  const icon = createSpan({ cls: "recallmap-inline-icon" });
  setIcon(icon, iconName);
  return icon;
}

function appendIcon(parent: HTMLElement, iconName: string): void {
  setIcon(parent, iconName);
}

function renderMissionMetric(
  parent: HTMLElement,
  iconName: string,
  label: string,
  value: string,
): void {
  const metric = parent.createDiv({ cls: "recallmap-mission-metric" });
  const icon = metric.createSpan({ cls: "recallmap-mission-metric__icon" });
  appendIcon(icon, iconName);
  const copy = metric.createDiv();
  copy.createSpan({ text: label });
  copy.createEl("strong", { text: value });
}

function renderMetaItem(
  parent: HTMLElement,
  iconName: string,
  text: string,
): HTMLSpanElement {
  const item = parent.createSpan({ cls: "recallmap-meta-item" });
  appendIcon(item.createSpan({ cls: "recallmap-meta-item__icon" }), iconName);
  return item.createSpan({ text });
}

function renderSnapshotMetric(
  parent: HTMLElement,
  iconName: string,
  label: string,
  value: string,
): void {
  const metric = parent.createDiv({ cls: "recallmap-snapshot-metric" });
  const icon = metric.createSpan({ cls: "recallmap-snapshot-metric__icon" });
  appendIcon(icon, iconName);
  const copy = metric.createDiv();
  copy.createSpan({ text: label });
  copy.createEl("strong", { text: value });
}

function renderResultMetric(
  parent: HTMLElement,
  iconName: string,
  label: string,
  value: string,
  detail: string,
): void {
  const metric = parent.createDiv({ cls: "recallmap-result-metric" });
  const icon = metric.createSpan({ cls: "recallmap-result-metric__icon" });
  appendIcon(icon, iconName);
  metric.createSpan({ text: label });
  metric.createEl("strong", { text: value });
  metric.createEl("small", { text: detail });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDays(days: number): string {
  const rounded = Math.round(days * 10) / 10;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

function getHealthTone(health: number): string {
  if (health < 40) return "critical";
  if (health < 65) return "warning";
  if (health < 85) return "healthy";
  return "excellent";
}

function getHealthLabel(health: number): string {
  if (health < 40) return "At risk";
  if (health < 65) return "Rebuilding";
  if (health < 85) return "Stable";
  return "Thriving";
}

function getHealthDescription(health: number, noteCount: number): string {
  if (!noteCount) return "Add notes to your vault to begin building a memory forecast.";
  if (health < 40) return "Several ideas are fading. A short recall session can recover them.";
  if (health < 65) return "Your knowledge base is active, with a few important gaps to reinforce.";
  if (health < 85) return "Your vault is holding steady. Review the weakest notes to stay ahead.";
  return "Your ideas are well reinforced. Keep the rhythm with focused, explicit reviews.";
}

function getFilterDescription(filter: DashboardFilter): string {
  const descriptions: Record<DashboardFilter, string> = {
    "needs-review": "Notes below your configured recall threshold, ordered by urgency.",
    forgotten: "Critical notes with less than 25% estimated recall.",
    weakening: "Knowledge that is fading but still recoverable with a timely review.",
    growing: "Recent or lightly reviewed notes that are still building stability.",
    strong: "Healthy notes with reliable recall and room to become mastered.",
    mastered: "Highly stable notes reinforced by at least four explicit reviews.",
    learned: "Every Markdown note tracked by RecallMap in this vault.",
  };
  return descriptions[filter];
}

function getComplexityDescription(complexity: NoteComplexity): string {
  const descriptions: Record<NoteComplexity, string> = {
    "very-easy": "Short definitions and simple facts.",
    easy: "Vocabulary, brief notes and familiar concepts.",
    normal: "The recommended default for most notes.",
    complex: "Technical explanations, code and connected concepts.",
    "very-complex": "Dense mathematics, architecture or advanced theory.",
  };
  return descriptions[complexity];
}
