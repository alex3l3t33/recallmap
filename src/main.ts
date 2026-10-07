import {
  App,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf
} from "obsidian";

import {
  Complexity,
  DEFAULT_SETTINGS,
  LearningStage,
  NoteMemoryState,
  RecallMapSettings,
  RecallStatus,
  ReviewRating,
  elapsedDaysSince,
  estimatedReviewSeconds,
  formatDuration,
  initialStability,
  learningStage,
  nextReviewTimestamp,
  recallProbability,
  stabilityAfterReview,
  statusForRecall
} from "./model";

const VIEW_TYPE_RECALLMAP = "recallmap-dashboard";

interface StoredNoteData {
  wordCount?: number;
  firstLearnedAt?: number;
  lastReviewedAt?: number;
  nextReviewAt?: number;
  stabilityDays?: number;
  complexity?: Complexity;
  reviewCount?: number;
  lapseCount?: number;
  history?: NoteMemoryState["history"];
}

interface RecallMapData {
  settings: RecallMapSettings;
  notes: Record<string, StoredNoteData>;
}

const STATUS_LABELS: Record<RecallStatus, string> = {
  fresh: "Fresh",
  strong: "Strong",
  weakening: "Weakening",
  "needs-review": "Needs review",
  forgotten: "Forgotten"
};

const STAGE_LABELS: Record<LearningStage, string> = {
  new: "New",
  learning: "Learning",
  established: "Established",
  mastered: "Mastered"
};

const REVIEW_LABELS: Record<ReviewRating, string> = {
  forgot: "Forgot",
  hard: "Hard",
  good: "Good",
  easy: "Easy"
};

export default class RecallMapPlugin extends Plugin {
  settings: RecallMapSettings = structuredClone(DEFAULT_SETTINGS);
  private noteData: Record<string, StoredNoteData> = {};

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(
      VIEW_TYPE_RECALLMAP,
      leaf => new RecallMapView(leaf, this)
    );

    this.addRibbonIcon(
      "brain-circuit",
      "Open RecallMap",
      () => void this.activateView()
    );

    this.addCommand({
      id: "open-recallmap",
      name: "Open dashboard",
      callback: () => void this.activateView()
    });

    this.addSettingTab(
      new RecallMapSettingTab(this.app, this)
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(
      VIEW_TYPE_RECALLMAP
    );
  }

  async activateView(): Promise<void> {
    const existing =
      this.app.workspace.getLeavesOfType(
        VIEW_TYPE_RECALLMAP
      )[0];

    const leaf =
      existing ?? this.app.workspace.getLeaf("tab");

    if (!existing) {
      await leaf.setViewState({
        type: VIEW_TYPE_RECALLMAP,
        active: true
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  async loadPluginData(): Promise<void> {
    const data =
      (await this.loadData()) as
        | Partial<RecallMapData>
        | null;

    this.settings = Object.assign(
      structuredClone(DEFAULT_SETTINGS),
      data?.settings ?? {}
    );

    this.settings.complexity = Object.assign(
      structuredClone(DEFAULT_SETTINGS.complexity),
      data?.settings?.complexity ?? {}
    );

    /*
     * Compatibility with RecallMap 0.1.0.
     *
     * Existing note state remains usable.
     * New fields are populated lazily.
     */
    this.noteData = data?.notes ?? {};
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      notes: this.noteData
    } satisfies RecallMapData);
  }

  private async countWords(
    file: TFile
  ): Promise<number> {
    const content =
      await this.app.vault.cachedRead(file);

    const withoutFrontmatter =
      content.replace(
        /^---\s*\n[\s\S]*?\n---\s*\n?/,
        ""
      );

    const withoutCode =
      withoutFrontmatter
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ");

    const withoutMarkdown =
      withoutCode
        .replace(/[#>*_~-]+/g, " ")
        .replace(/\s+/g, " ");

    const words =
      withoutMarkdown
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    return Math.max(1, words.length);
  }

  async getNoteStates(): Promise<NoteMemoryState[]> {
    const files =
      this.app.vault.getMarkdownFiles();

    return Promise.all(
      files.map(async file => {
        const saved =
          this.noteData[file.path] ?? {};

        const complexity =
          saved.complexity ??
          this.settings.defaultComplexity;

        const stability =
          saved.stabilityDays ??
          initialStability(
            complexity,
            this.settings
          );

        const wordCount =
          await this.countWords(file);

        /*
         * A file modification is NOT considered
         * a memory review.
         *
         * Old RecallMap data with a lastReviewedAt
         * timestamp is retained.
         */
        return {
          path: file.path,
          title: file.basename,
          wordCount,

          firstLearnedAt:
            saved.firstLearnedAt,

          lastReviewedAt:
            saved.lastReviewedAt,

          nextReviewAt:
            saved.nextReviewAt,

          stabilityDays: stability,
          complexity: saved.complexity,

          reviewCount:
            saved.reviewCount ?? 0,

          lapseCount:
            saved.lapseCount ?? 0,

          history:
            saved.history ?? []
        };
      })
    );
  }

  getRecall(
    note: NoteMemoryState
  ): number {
    /*
     * Notes that have never entered the learning
     * workflow have no measured forgetting history.
     */
    const anchor =
      note.lastReviewedAt ??
      note.firstLearnedAt;

    if (!anchor) {
      return 1;
    }

    const elapsed =
      elapsedDaysSince(anchor);

    return recallProbability(
      elapsed,
      note.stabilityDays
    );
  }

  async setComplexity(
    path: string,
    complexity: Complexity
  ): Promise<void> {
    this.noteData[path] = {
      ...(this.noteData[path] ?? {}),
      complexity
    };

    await this.savePluginData();
  }

  async startLearning(
    note: NoteMemoryState
  ): Promise<void> {
    const now = Date.now();

    const complexity =
      note.complexity ??
      this.settings.defaultComplexity;

    const stability =
      initialStability(
        complexity,
        this.settings
      );

    this.noteData[note.path] = {
      ...(this.noteData[note.path] ?? {}),

      wordCount: note.wordCount,

      firstLearnedAt: now,
      lastReviewedAt: now,

      stabilityDays: stability,

      nextReviewAt:
        nextReviewTimestamp(
          stability,
          this.settings.reviewThreshold,
          now
        ),

      reviewCount: 0,
      lapseCount: 0,
      history: []
    };

    await this.savePluginData();
  }

  async recordReview(
    note: NoteMemoryState,
    rating: ReviewRating
  ): Promise<void> {
    const now = Date.now();

    const complexity =
      note.complexity ??
      this.settings.defaultComplexity;

    const recallBeforeReview =
      this.getRecall(note);

    const stabilityBefore =
      note.stabilityDays;

    const stabilityAfter =
      stabilityAfterReview(
        stabilityBefore,
        recallBeforeReview,
        rating,
        complexity,
        this.settings
      );

    const history = [
      ...note.history,
      {
        timestamp: now,
        rating,
        recallBeforeReview,
        stabilityBefore,
        stabilityAfter
      }
    ];

    this.noteData[note.path] = {
      ...(this.noteData[note.path] ?? {}),

      wordCount: note.wordCount,

      firstLearnedAt:
        note.firstLearnedAt ?? now,

      lastReviewedAt: now,

      nextReviewAt:
        nextReviewTimestamp(
          stabilityAfter,
          this.settings.reviewThreshold,
          now
        ),

      stabilityDays:
        stabilityAfter,

      reviewCount:
        note.reviewCount + 1,

      lapseCount:
        note.lapseCount +
        (rating === "forgot" ? 1 : 0),

      history
    };

    await this.savePluginData();
  }
}

class RecallMapView extends ItemView {
  private activeStatus:
    | RecallStatus
    | "all" = "all";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: RecallMapPlugin
  ) {
    super(leaf);
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
    await this.render();
  }

  private async render(): Promise<void> {
    const root = this.contentEl;

    root.empty();
    root.addClass("recallmap-view");

    const notes =
      await this.plugin.getNoteStates();

    const enriched =
      notes.map(note => {
        const recall =
          this.plugin.getRecall(note);

        const status =
          statusForRecall(
            recall,
            this.plugin.settings.reviewThreshold
          );

        const stage =
          learningStage(
            note.reviewCount,
            note.lapseCount,
            note.stabilityDays
          );

        return {
          note,
          recall,
          status,
          stage
        };
      });

    const activeNotes =
      enriched.filter(
        item =>
          item.note.firstLearnedAt !== undefined
      );

    const average =
      activeNotes.length
        ? activeNotes.reduce(
            (sum, item) =>
              sum + item.recall,
            0
          ) / activeNotes.length
        : 0;

    const hero =
      root.createDiv({
        cls: "recallmap-hero"
      });

    const heroText =
      hero.createDiv();

    heroText.createEl("div", {
      text: "Overall recall health",
      cls: "recallmap-eyebrow"
    });

    heroText.createEl("div", {
      text: activeNotes.length
        ? `${Math.round(average * 100)}%`
        : "—",
      cls: "recallmap-health-value"
    });

    heroText.createEl("div", {
      text:
        `${activeNotes.length} learning notes · ` +
        `${notes.length - activeNotes.length} new notes`,
      cls: "recallmap-muted"
    });

    const ring =
      hero.createDiv({
        cls: "recallmap-ring"
      });

    ring.style.setProperty(
      "--recall",
      `${Math.round(average * 360)}deg`
    );

    ring.createSpan({
      text: activeNotes.length
        ? `${Math.round(average * 100)}%`
        : "—"
    });

    const grid =
      root.createDiv({
        cls: "recallmap-metric-grid"
      });

    const statuses: RecallStatus[] = [
      "forgotten",
      "needs-review",
      "weakening",
      "strong",
      "fresh"
    ];

    statuses.forEach(status => {
      const count =
        activeNotes.filter(
          item =>
            item.status === status
        ).length;

      const card =
        grid.createEl("button", {
          cls:
            `recallmap-metric ` +
            `recallmap-status-${status}`
        });

      card.createSpan({
        text: STATUS_LABELS[status],
        cls: "recallmap-metric-label"
      });

      card.createSpan({
        text: String(count),
        cls: "recallmap-metric-value"
      });

      card.createSpan({
        text: "View notes",
        cls: "recallmap-metric-action"
      });

      card.addEventListener(
        "click",
        () => {
          this.activeStatus = status;
          void this.render();
        }
      );
    });

    const toolbar =
      root.createDiv({
        cls: "recallmap-toolbar"
      });

    toolbar.createEl("h3", {
      text:
        this.activeStatus === "all"
          ? "All notes"
          : STATUS_LABELS[
              this.activeStatus
            ]
    });

    if (
      this.activeStatus !== "all"
    ) {
      const clear =
        toolbar.createEl("button", {
          text: "Show all",
          cls: "mod-cta"
        });

      clear.addEventListener(
        "click",
        () => {
          this.activeStatus = "all";
          void this.render();
        }
      );
    }

    const filtered =
      enriched
        .filter(item =>
          this.activeStatus === "all" ||
          item.status ===
            this.activeStatus
        )
        .sort(
          (a, b) =>
            a.recall - b.recall
        );

    const list =
      root.createDiv({
        cls: "recallmap-note-list"
      });

    filtered.forEach(item =>
      this.renderNote(
        list,
        item.note,
        item.recall,
        item.status,
        item.stage
      )
    );

    if (
      filtered.length === 0
    ) {
      list.createDiv({
        text:
          "No notes in this category.",
        cls: "recallmap-empty"
      });
    }
  }

  private renderNote(
    container: HTMLElement,
    note: NoteMemoryState,
    recall: number,
    status: RecallStatus,
    stage: LearningStage
  ): void {
    const row =
      container.createDiv({
        cls: "recallmap-note-row"
      });

    const info =
      row.createDiv({
        cls: "recallmap-note-main"
      });

    const title =
      info.createEl("button", {
        text: note.title,
        cls: "recallmap-note-title"
      });

    title.addEventListener(
      "click",
      () =>
        void this.openNote(
          note.path
        )
    );

    const reviewTime =
      formatDuration(
        estimatedReviewSeconds(
          note,
          this.plugin.settings
        )
      );

    const learned =
      note.firstLearnedAt !== undefined;

    info.createDiv({
      text: learned
        ? `${STATUS_LABELS[status]} · ${STAGE_LABELS[stage]} · ${reviewTime} review`
        : `New · ${reviewTime} review`,
      cls: "recallmap-muted"
    });

    if (learned) {
      const bar =
        info.createDiv({
          cls: "recallmap-progress"
        });

      const fill =
        bar.createDiv({
          cls:
            `recallmap-progress-fill ` +
            `recallmap-status-${status}`
        });

      fill.style.width =
        `${Math.max(
          2,
          Math.round(recall * 100)
        )}%`;
    }

    const controls =
      row.createDiv({
        cls: "recallmap-note-controls"
      });

    if (learned) {
      controls.createSpan({
        text:
          `${Math.round(
            recall * 100
          )}%`,
        cls: "recallmap-note-score"
      });
    }

    const select =
      controls.createEl("select");

    const current =
      note.complexity ??
      this.plugin.settings
        .defaultComplexity;

    (
      Object.keys(
        this.plugin.settings.complexity
      ) as Complexity[]
    ).forEach(key => {
      const definition =
        this.plugin.settings
          .complexity[key];

      const option =
        select.createEl(
          "option",
          {
            text: definition.label,
            value: key
          }
        );

      option.selected =
        key === current;
    });

    select.addEventListener(
      "change",
      () => {
        void this.plugin
          .setComplexity(
            note.path,
            select.value as Complexity
          )
          .then(() =>
            this.render()
          );
      }
    );

    if (!learned) {
      const start =
        controls.createEl(
          "button",
          {
            text: "Start learning",
            cls: "mod-cta"
          }
        );

      start.addEventListener(
        "click",
        () => {
          void this.plugin
            .startLearning(note)
            .then(() => {
              new Notice(
                `${note.title} added to RecallMap`
              );

              return this.render();
            });
        }
      );

      return;
    }

    const ratings: ReviewRating[] = [
      "forgot",
      "hard",
      "good",
      "easy"
    ];

    ratings.forEach(rating => {
      const button =
        controls.createEl(
          "button",
          {
            text:
              REVIEW_LABELS[rating],
            cls:
              rating === "good"
                ? "mod-cta"
                : undefined
          }
        );

      button.addEventListener(
        "click",
        () => {
          void this.plugin
            .recordReview(
              note,
              rating
            )
            .then(() => {
              new Notice(
                `${note.title}: ${REVIEW_LABELS[rating]}`
              );

              return this.render();
            });
        }
      );
    });
  }

  private async openNote(
    path: string
  ): Promise<void> {
    const file =
      this.app.vault
        .getAbstractFileByPath(path);

    if (file instanceof TFile) {
      await this.app.workspace
        .getLeaf("tab")
        .openFile(file);
    }
  }
}

class RecallMapSettingTab
  extends PluginSettingTab {

  constructor(
    app: App,
    private readonly plugin:
      RecallMapPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Memory model")
      .setHeading();

    new Setting(containerEl)
      .setName("Default complexity")
      .setDesc(
        "Used until a note receives a manual complexity."
      )
      .addDropdown(dropdown => {
        (
          Object.keys(
            this.plugin.settings
              .complexity
          ) as Complexity[]
        ).forEach(key =>
          dropdown.addOption(
            key,
            this.plugin.settings
              .complexity[key].label
          )
        );

        dropdown
          .setValue(
            this.plugin.settings
              .defaultComplexity
          )
          .onChange(
            async value => {
              this.plugin.settings
                .defaultComplexity =
                  value as Complexity;

              await this.plugin
                .savePluginData();

              this.display();
            }
          );
      });

    new Setting(containerEl)
      .setName("Review threshold")
      .setDesc(
        "Recall probability at which a note becomes due for review. Default: 45%."
      )
      .addText(text =>
        text
          .setValue(
            String(
              Math.round(
                this.plugin.settings
                  .reviewThreshold *
                  100
              )
            )
          )
          .onChange(
            async value => {
              const parsed =
                Number(value);

              if (
                Number.isFinite(
                  parsed
                ) &&
                parsed >= 10 &&
                parsed <= 90
              ) {
                this.plugin.settings
                  .reviewThreshold =
                    parsed / 100;

                await this.plugin
                  .savePluginData();
              }
            }
          )
      );

    new Setting(containerEl)
      .setName("Reading speed")
      .setDesc(
        "Words per minute used for review-time estimates."
      )
      .addText(text =>
        text
          .setValue(
            String(
              this.plugin.settings
                .readingWordsPerMinute
            )
          )
          .onChange(
            async value => {
              const parsed =
                Number(value);

              if (
                Number.isFinite(
                  parsed
                ) &&
                parsed >= 50
              ) {
                this.plugin.settings
                  .readingWordsPerMinute =
                    parsed;

                await this.plugin
                  .savePluginData();
              }
            }
          )
      );

    new Setting(containerEl)
      .setName(
        "Complexity multipliers"
      )
      .setHeading();

    (
      Object.keys(
        this.plugin.settings
          .complexity
      ) as Complexity[]
    ).forEach(key => {
      const definition =
        this.plugin.settings
          .complexity[key];

      new Setting(containerEl)
        .setName(definition.label)
        .setDesc(
          `Review time ${definition.multiplier.toFixed(1)}× · memory stability ${definition.stabilityMultiplier.toFixed(2)}×`
        );
    });
  }
}
