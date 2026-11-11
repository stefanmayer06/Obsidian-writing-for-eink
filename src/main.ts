import { debounce, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { isOcrConfigured, loadSettings, type InkSettings } from "./settings";
import { isInkPath, PairManager } from "./obsidian/pairs";
import { OcrService } from "./obsidian/ocrService";
import { SyncEngine } from "./obsidian/syncEngine";
import { BookmarkManager } from "./obsidian/bookmarks";
import { PageSwitcher } from "./obsidian/pageSwitcher";
import { FastInkBridge } from "./obsidian/fastInkBridge";
import { InkSettingTab } from "./obsidian/settingsTab";
import { SetupWizard } from "./obsidian/setupWizard";
import { applyEinkClasses, einkActive, removeEinkClasses } from "./obsidian/einkMode";
import { isOnline } from "./obsidian/azureClient";
import { findInkView, IMAGE_EXTENSIONS, INK_VIEW_TYPE, InkView } from "./obsidian/inkView";
import { redirectInkFiles } from "./obsidian/viewPatch";
import { registerFigureBlocks } from "./obsidian/figureBlock";
import { VaultImages } from "./obsidian/vaultImages";
import { annotateImage, annotatePdf, appendPdfPages, exportAnnotatedPdf, exportNotebookPdf, exportPageImage } from "./obsidian/pdfAnnotate";
import { selectionToText } from "./obsidian/lassoText";
import { migrateExcalidrawPages } from "./obsidian/migrate";
import { transcriptEditorExtension } from "./obsidian/editorExtension";
import { PaperService } from "./obsidian/papers";
import { LibraryService } from "./obsidian/library";
import { inkTextMeasure } from "./ink/render";
import { MermaidModal, type MermaidDraft } from "./obsidian/mermaidModal";
import { mermaidBlockAt, mermaidName } from "./core/ink/mermaid";
import { PaperSearchModal } from "./obsidian/paperSearch";
import { DailyInk } from "./obsidian/dailyNotes";
import { ConfirmModal } from "./obsidian/modals";
import { classifyScene } from "./core/classify";
import { planOcrUnits } from "./core/rasterPlan";
import { layoutTranscript } from "./core/layout";
import { INK_FRONTMATTER_KEY, parseInkFile, serializeInkFile } from "./core/ink/codec";
import type { InkFile, PageBackground } from "./core/ink/model";
import type { ToolId } from "./ink/types";

export default class InkNotebookPlugin extends Plugin {
  settings!: InkSettings;
  pairs!: PairManager;
  ocr!: OcrService;
  sync!: SyncEngine;
  bookmarks!: BookmarkManager;
  switcher!: PageSwitcher;
  /** Instant ink on Boox tablets (with the Ink Notebook Bridge app). */
  fastInk!: FastInkBridge;
  /** Pictures and PDF pages for the ink pages. */
  images!: VaultImages;
  /** Papers from arXiv. */
  papers!: PaperService;
  library!: LibraryService;
  /** Daily notes that come with an ink page. */
  daily!: DailyInk;
  /** The page each notebook was last open at. */
  readonly lastPage = new Map<string, number>();

  private openDrawings = new Set<string>();
  private queueRunning = false;
  private inkTimers = new Map<string, number>();
  private busy = new Set<string>();
  private inkListeners = new Set<(path: string) => void>();
  private redirect!: ReturnType<typeof redirectInkFiles>;

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.images = new VaultImages(this.app);
    this.papers = new PaperService(this);
    this.library = new LibraryService(this);
    this.daily = new DailyInk(this);
    this.pairs = new PairManager(this.app, () => this.settings.inkSubfolder);
    this.ocr = new OcrService(
      this.app.vault.adapter,
      `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/ocr-cache.json`,
      () => this.settings,
      () => this.saveSettings(),
    );
    this.sync = new SyncEngine(
      this.app,
      this.pairs,
      this.ocr,
      () => this.settings,
      { add: (p) => this.queueAdd(p), remove: (p) => this.queueRemove(p) },
      (f) => findInkView(this, f),
    );
    this.bookmarks = new BookmarkManager(this);
    this.switcher = new PageSwitcher(this);
    this.fastInk = new FastInkBridge(this, () => this.app.workspace.getActiveViewOfType(InkView));
    this.fastInk.start();
    const refreshStatus = debounce(
      () => {
        this.bookmarks.refreshAll();
        for (const v of this.inkViews()) v.refreshStatus();
      },
      80,
      true,
    );
    this.sync.onStatusChange = () => refreshStatus();

    this.registerView(INK_VIEW_TYPE, (leaf) => new InkView(leaf, this));
    this.redirect = redirectInkFiles(this, INK_VIEW_TYPE, (path) => this.isInkPath(path));
    registerFigureBlocks(this);

    applyEinkClasses(this.settings);
    this.addSettingTab(new InkSettingTab(this.app, this));
    this.registerEditorExtension(transcriptEditorExtension());

    this.addRibbonIcon("pencil-line", "New ink page", () => void this.switcher.createPage().catch((e) => this.switcher.reportError("Could not create the page", e)));
    this.addRibbonIcon("graduation-cap", "Import a paper from arXiv", () => this.openPaperSearch());
    this.registerCommands();
    this.registerFileMenus();

    // ---- workspace & vault events ----
    const onLayout = debounce(
      () => {
        this.bookmarks.refreshAll();
        this.detectClosedDrawings();
      },
      60,
      true,
    );
    this.registerEvent(this.app.workspace.on("layout-change", onLayout));
    this.registerEvent(this.app.workspace.on("active-leaf-change", onLayout));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.fastInk.update()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.fastInk.update()));
    this.registerEvent(this.app.workspace.on("file-open", onLayout));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.refreshStaleTextPage(file)));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.daily.onOpen(file)));
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyInkSettings()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.pairs.isTextPage(file) || this.pairs.isDrawing(file)) refreshStatus();
      }),
    );
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onRename(file, oldPath)));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.queueRemove(file.path);
        this.sync.forget(file.path);
        this.images.invalidate(file.path);
        refreshStatus();
      }),
    );
    this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));
    this.registerDomEvent(window, "online", () => {
      window.setTimeout(() => void this.processQueue(), 2000);
    });
    this.registerInterval(window.setInterval(() => void this.processQueue(), 5 * 60 * 1000));

    this.app.workspace.onLayoutReady(() => void this.onLayoutReady());
  }

  onunload(): void {
    this.fastInk?.destroy();
    this.bookmarks?.removeAll();
    removeEinkClasses();
    for (const t of this.inkTimers.values()) window.clearTimeout(t);
    void this.ocr?.flush();
    this.images?.clear();
  }

  private async onLayoutReady(): Promise<void> {
    await this.ocr.loadCache();
    this.bookmarks.refreshAll();
    this.detectClosedDrawings();
    if (!this.settings.setupDone) window.setTimeout(() => new SetupWizard(this).open(), 800);
    window.setTimeout(() => void this.processQueue(), 8000);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  readonly saveSettingsSoon = debounce(() => void this.saveSettings(), 1000, true);

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** Pure core functions, exposed for troubleshooting from the developer console. */
  readonly internals = { classifyScene, planOcrUnits, layoutTranscript, parseInkFile, serializeInkFile };

  // ------------------------------------------------------------------ ink pages

  /** Is a file (by path) an ink page that should open in the ink view? */
  isInkPath(path: string): boolean {
    if (isInkPath(path)) return true;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile) || f.extension !== "md") return false;
    return this.app.metadataCache.getFileCache(f)?.frontmatter?.[INK_FRONTMATTER_KEY] !== undefined;
  }

  inkViews(): InkView[] {
    return this.app.workspace
      .getLeavesOfType(INK_VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is InkView => v instanceof InkView);
  }

  /** The notebook as it is in an open ink view (with unsaved changes), if open. */
  liveInk(file: TFile): InkFile | null {
    return findInkView(this, file)?.inkFile ?? null;
  }

  /** Be told when a notebook changes in an ink view (before it is saved). */
  onInkChange(fn: (path: string) => void): () => void {
    this.inkListeners.add(fn);
    return () => this.inkListeners.delete(fn);
  }

  /** Called by ink views on every change. */
  inkChanged(file: TFile): void {
    for (const fn of [...this.inkListeners]) fn(file.path);
    // optionally transcribe while writing
    if (!this.settings.autoTranscribe || !this.pairs.textFor(file)) return;
    const prev = this.inkTimers.get(file.path);
    if (prev) window.clearTimeout(prev);
    this.inkTimers.set(
      file.path,
      window.setTimeout(() => {
        this.inkTimers.delete(file.path);
        void this.sync.syncInkToText(file, { network: true }).catch((e) => console.warn("Ink Notebook: auto transcription failed", e));
      }, 6000),
    );
  }

  setBusy(file: TFile, busy: boolean): void {
    if (busy) this.busy.add(file.path);
    else this.busy.delete(file.path);
    this.bookmarks.refreshAll();
  }

  isBusy(file: TFile): boolean {
    return this.busy.has(file.path);
  }

  /** Apply changed settings to the open ink views and the e-ink look. */
  applyInkSettings(): void {
    applyEinkClasses(this.settings);
    for (const v of this.inkViews()) v.applySettings();
    this.bookmarks.refreshAll();
    this.fastInk.update();
  }

  /** Show an ink page's file as Markdown (the raw data). */
  async openAsMarkdown(leaf: WorkspaceLeaf): Promise<void> {
    const file = (leaf.view as { file?: TFile | null }).file;
    if (!file) return;
    if (leaf.view instanceof InkView) await leaf.view.save();
    await this.redirect.asMarkdown(() => leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source" } }));
  }

  ocrConfigured(): boolean {
    return isOcrConfigured(this.settings);
  }

  selectionToText(view: InkView): Promise<void> {
    return selectionToText(this, view);
  }

  /**
   * Add a Mermaid diagram to the object library (asked for, prefilled with
   * `initial`). On an ink page the library opens with the new diagram ready
   * to be placed.
   */
  async addMermaidDiagram(initial: Partial<MermaidDraft> = {}): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(InkView);
    const draft = await MermaidModal.ask(this.app, inkTextMeasure(), initial);
    if (!draft) return;
    try {
      const added = await this.library.addMermaid(draft.name, draft.code);
      view?.showLibraryItem(added.source, added.item);
    } catch (e) {
      this.switcher.reportError("Could not add the Mermaid diagram", e);
    }
  }

  /** The Mermaid diagram the cursor of the active note is in (to prefill "Add a Mermaid diagram"). */
  private mermaidAtCursor(): Partial<MermaidDraft> {
    const editor = this.app.workspace.activeEditor?.editor;
    const file = this.app.workspace.activeEditor?.file;
    if (!editor) return {};
    const code = mermaidBlockAt(editor.getValue(), editor.posToOffset(editor.getCursor()));
    return code ? { code, name: mermaidName(code, file?.basename) ?? undefined } : {};
  }

  /** Search arXiv and import a paper (as a new ink page, or – with `into` – as more pages of that one). */
  openPaperSearch(into: InkView | null = null): void {
    new PaperSearchModal(this, into).open();
  }

  appendPdfPages(view: InkView): Promise<void> {
    return appendPdfPages(this, view);
  }

  exportPageImage(view?: InkView | null): Promise<void> {
    return exportPageImage(this, view);
  }

  exportNotebookPdf(view?: InkView | null): Promise<void> {
    return exportNotebookPdf(this, view);
  }

  exportAnnotatedPdf(view?: InkView | null): Promise<void> {
    return exportAnnotatedPdf(this, view);
  }

  // ------------------------------------------------------------------ queue

  private queueAdd(path: string): void {
    if (!this.settings.queue.includes(path)) {
      this.settings.queue.push(path);
      this.saveSettingsSoon();
    }
  }

  private queueRemove(path: string): void {
    const i = this.settings.queue.indexOf(path);
    if (i >= 0) {
      this.settings.queue.splice(i, 1);
      this.saveSettingsSoon();
    }
  }

  /** Transcribe pages that could not be transcribed earlier (offline, errors). */
  async processQueue(verbose = false): Promise<void> {
    if (this.queueRunning) return;
    if (this.settings.queue.length === 0) {
      if (verbose) new Notice("No pages are waiting for transcription.");
      return;
    }
    if (!isOnline()) {
      if (verbose) new Notice("You are offline – the pages will be transcribed when you are back online.");
      return;
    }
    this.queueRunning = true;
    let done = 0;
    try {
      for (const path of [...this.settings.queue]) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !this.pairs.isDrawing(file)) {
          this.queueRemove(path);
          continue;
        }
        try {
          const r = await this.sync.syncInkToText(file, { network: true });
          if (r.text && r.pending === 0) done++;
          if (r.status === "offline") break;
        } catch (e) {
          console.warn("Ink Notebook: queued transcription failed", path, e);
        }
      }
    } finally {
      this.queueRunning = false;
    }
    if (verbose || done > 0) new Notice(`Ink Notebook: transcribed ${done} waiting page${done === 1 ? "" : "s"}.`);
  }

  // ------------------------------------------------------------------ events

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const i = this.settings.queue.indexOf(oldPath);
    if (i >= 0) {
      this.settings.queue[i] = file.path;
      this.saveSettingsSoon();
    }
    if (this.openDrawings.delete(oldPath)) this.openDrawings.add(file.path);
    if (this.lastPage.has(oldPath)) {
      this.lastPage.set(file.path, this.lastPage.get(oldPath) ?? 0);
      this.lastPage.delete(oldPath);
    }
    this.images.invalidate(oldPath);
    // a PDF or picture used on ink pages moved: follow it
    if (file instanceof TFile && file.extension !== "md") void this.renameAsset(oldPath, file.path);
    // wait for the metadata cache to pick up the new path
    window.setTimeout(() => {
      void this.pairs
        .onRename(file, oldPath, this.settings.keepNamesInSync)
        .catch((e) => console.warn("Ink Notebook: rename sync failed", e))
        .then(() => this.bookmarks.refreshAll());
    }, 300);
  }

  /** Update the paths of a renamed picture/PDF in the ink pages that use it. */
  private async renameAsset(oldPath: string, newPath: string): Promise<void> {
    const swapBg = (bg: PageBackground): PageBackground => (bg.kind !== "paper" && bg.path === oldPath ? { ...bg, path: newPath } : bg);
    const fix = (ink: InkFile): InkFile | null => {
      let changed = false;
      const pages = ink.doc.pages.map((p) => {
        const bg = swapBg(p.bg);
        const images = p.images.map((im) => (im.src === oldPath ? { ...im, src: newPath } : im));
        if (bg === p.bg && images.every((im, k) => im === p.images[k])) return p;
        changed = true;
        return { ...p, bg, images };
      });
      return changed ? { doc: { ...ink.doc, pages }, meta: ink.meta } : null;
    };
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.pairs.isDrawing(f)) continue;
      const view = findInkView(this, f);
      try {
        if (view?.inkFile) {
          const next = fix(view.inkFile);
          if (next) view.replaceQuietly(next);
          continue;
        }
        const data = await this.app.vault.cachedRead(f);
        if (!data.includes(oldPath.replace(/%/g, "\\u0025")) && !data.includes(oldPath)) continue;
        await this.app.vault.process(f, (cur) => {
          const parsed = parseInkFile(cur);
          const next = fix(parsed);
          return next ? serializeInkFile(parsed.frontmatter, next) : cur;
        });
      } catch (e) {
        console.warn("Ink Notebook: could not update a renamed file on", f.path, e);
      }
    }
  }

  private onModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") {
      this.images.invalidate(file.path);
      return;
    }
    // typed notes shown on ink pages
    if (this.pairs.isTextPage(file)) {
      const drawing = this.pairs.drawingFor(file);
      if (drawing) findInkView(this, drawing)?.textChanged();
    }
  }

  /**
   * Opening a text page whose ink page changed after the transcript was written
   * (e.g. synced from another device) refreshes it in the background.
   */
  private refreshStaleTextPage(file: TFile | null): void {
    if (!file || !this.pairs.isTextPage(file)) return;
    const drawing = this.pairs.drawingFor(file);
    if (!drawing || drawing.stat.mtime <= file.stat.mtime + 2000) return;
    if (findInkView(this, drawing)) return; // the open ink page syncs itself
    if (this.sync.isUpToDate(drawing)) return;
    window.setTimeout(() => {
      void this.sync.syncInkToText(drawing, { network: true }).catch((e) => console.warn("Ink Notebook: refresh failed", e));
    }, 500);
  }

  /** When an ink page is closed (navigated away) update its text page in the background. */
  private detectClosedDrawings(): void {
    const now = new Set<string>();
    for (const v of this.inkViews()) if (v.file) now.add(v.file.path);
    const closed = [...this.openDrawings].filter((p) => !now.has(p));
    this.openDrawings = now;
    for (const path of closed) {
      window.setTimeout(() => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !this.pairs.isDrawing(file) || !this.pairs.textFor(file)) return;
        if (findInkView(this, file)) return; // reopened meanwhile
        if (this.sync.isUpToDate(file)) return; // e.g. just synced by flipping
        void this.sync.syncInkToText(file, { network: true }).catch((e) => console.warn("Ink Notebook: background sync failed", e));
      }, 1500);
    }
  }

  // ------------------------------------------------------------------ matching up pages

  /**
   * Rename ink pages whose two files do not match – e.g. a daily note that was
   * the drawing itself ("2026-10-27.md") with its text page "2026-10-27 (text).md":
   * afterwards the text page is "2026-10-27.md" and the drawing
   * "Attachments/2026-10-27.ink.md".
   */
  async matchUpPages(): Promise<void> {
    const plans = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.pairs.isDrawing(f))
      .map((drawing) => ({ drawing, moves: this.pairs.tidyPlan(drawing) }))
      .filter((p) => p.moves.length > 0);
    if (plans.length === 0) {
      new Notice("Every ink page already has the name of its text page.");
      return;
    }
    const moves = plans.flatMap((p) => p.moves);
    const examples = moves
      .slice(0, 4)
      .map((m) => `${m.file.path} → ${m.to}`)
      .join("\n");
    const ok = await ConfirmModal.ask(this.app, {
      title: `Match up ${plans.length} ink page${plans.length === 1 ? "" : "s"}?`,
      text: `${moves.length} file${moves.length === 1 ? " is" : "s are"} renamed or moved, so that each text page "Name.md" has its ink page "Name.ink.md" in the ink subfolder next to it. Links to a page keep working.\n\n${examples}${moves.length > 4 ? "\n…" : ""}`,
      confirm: "Rename",
    });
    if (!ok) return;
    let moved = 0;
    for (const p of plans) {
      try {
        moved += await this.pairs.tidy(p.drawing);
      } catch (e) {
        console.warn("Ink Notebook: could not match up", p.drawing.path, e);
      }
    }
    const skipped = moves.length - moved;
    new Notice(`Ink Notebook: renamed ${moved} file${moved === 1 ? "" : "s"}.${skipped > 0 ? ` ${skipped} could not be renamed: a file of that name exists.` : ""}`, 8000);
    this.bookmarks.refreshAll();
  }

  // ------------------------------------------------------------------ commands

  private activeLeafFile(): { leaf: WorkspaceLeaf; file: TFile } | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
    return leaf && file instanceof TFile ? { leaf, file } : null;
  }

  private activeInkView(): InkView | null {
    const v = this.app.workspace.getMostRecentLeaf()?.view;
    return v instanceof InkView && v.inkFile ? v : null;
  }

  private registerCommands(): void {
    const run = (p: Promise<unknown>, what: string) => void p.catch((e) => this.switcher.reportError(what, e));
    const onInk = (id: string, name: string, icon: string, fn: (v: InkView) => unknown) =>
      this.addCommand({
        id,
        name,
        icon,
        checkCallback: (checking) => {
          const v = this.activeInkView();
          if (!v) return false;
          if (!checking) {
            const r = fn(v);
            if (r instanceof Promise) run(r, name);
          }
          return true;
        },
      });

    this.addCommand({
      id: "new-page",
      name: "New ink page",
      icon: "pencil-line",
      callback: () => run(this.switcher.createPage(), "Could not create the page"),
    });
    this.addCommand({
      id: "flip-page",
      name: "Flip between ink and text page",
      icon: "book-open",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        if (!a || !this.pairs.pairOf(a.file)) return false;
        if (!checking) run(this.switcher.flip(a.leaf), "Could not flip the page");
        return true;
      },
    });
    this.addCommand({
      id: "transcribe-now",
      name: "Transcribe handwriting now",
      icon: "refresh-cw",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        const info = a && this.pairs.pairOf(a.file);
        if (!info) return false;
        if (!checking) run(this.switcher.transcribeNow(info.pair.drawing, false), "Transcription failed");
        return true;
      },
    });
    this.addCommand({
      id: "retranscribe",
      name: "Re-transcribe from scratch (discard edits in the transcript)",
      icon: "rotate-ccw",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        const info = a && this.pairs.pairOf(a.file);
        if (!info) return false;
        if (!checking) run(this.switcher.transcribeNow(info.pair.drawing, true), "Transcription failed");
        return true;
      },
    });
    this.addCommand({
      id: "side-by-side",
      name: "Open ink and text page side by side",
      icon: "columns-2",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        if (!a || !this.pairs.pairOf(a.file)) return false;
        if (!checking) run(this.switcher.openSideBySide(a.leaf), "Could not open the pages");
        return true;
      },
    });
    this.addCommand({
      id: "add-ink-to-note",
      name: "Add an ink page to this note",
      icon: "pencil-line",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        if (!a || a.leaf.view instanceof InkView || !this.pairs.canAddInk(a.file)) return false;
        if (!checking) run(this.switcher.addInkToNote(a.file, { leaf: a.leaf, askPaper: true }), "Could not add the ink page");
        return true;
      },
    });
    this.addCommand({
      id: "open-today-ink",
      name: "Open today's daily note on the ink page",
      icon: "calendar-days",
      callback: () => run(this.daily.openToday(), "Could not open today's ink page"),
    });
    this.addCommand({
      id: "match-up-pages",
      name: "Match up the names of ink and text pages",
      icon: "link-2",
      callback: () => run(this.matchUpPages(), "Could not rename the pages"),
    });
    onInk("add-paper-page", "Add a page… (choose paper and position)", "file-plus-2", (v) => v.addPageInteractive());
    onInk("add-page-after", "Add a page after this one (same paper)", "file-plus-2", (v) => v.surface.addPage("after"));
    onInk("change-paper", "Change the paper of this page…", "layout-template", (v) => v.changePaper());
    onInk("delete-page", "Delete this page", "trash-2", (v) => v.deletePage());
    onInk("next-page", "Next page", "chevron-right", (v) => v.surface.next());
    onInk("previous-page", "Previous page", "chevron-left", (v) => v.surface.prev());
    onInk("undo", "Undo on the ink page", "undo-2", (v) => v.surface.undo());
    onInk("redo", "Redo on the ink page", "redo-2", (v) => v.surface.redo());
    const tools: Array<[ToolId, string, string]> = [
      ["pen", "Pen", "pen-tool"],
      ["marker", "Highlighter", "highlighter"],
      ["eraser", "Eraser", "eraser"],
      ["lasso", "Lasso", "lasso"],
      ["shape", "Shapes", "shapes"],
      ["fill", "Fill", "paint-bucket"],
      ["text", "Text", "type"],
    ];
    for (const [tool, label, icon] of tools) {
      onInk(`tool-${tool}`, `Tool: ${label}`, icon, (v) => {
        v.surface.setTools({ tool });
        this.settings.tools = structuredClone(v.surface.tools);
        this.saveSettingsSoon();
      });
    }
    this.addCommand({
      id: "annotate-pdf",
      name: "Annotate a PDF…",
      icon: "file-text",
      callback: () => run(annotatePdf(this, null), "Could not annotate the PDF"),
    });
    this.addCommand({
      id: "import-arxiv",
      name: "Import a paper from arXiv…",
      icon: "graduation-cap",
      callback: () => this.openPaperSearch(),
    });
    this.addCommand({
      id: "annotate-image",
      name: "Annotate an image…",
      icon: "image",
      callback: () => run(annotateImage(this, null), "Could not annotate the image"),
    });
    onInk("object-library", "Open the object library (flowchart shapes, Mermaid diagrams, Excalidraw libraries)", "library", (v) => v.openLibrary());
    this.addCommand({
      id: "add-mermaid",
      name: "Add a Mermaid diagram to the object library…",
      icon: "workflow",
      callback: () => void this.addMermaidDiagram(this.mermaidAtCursor()),
    });
    onInk("export-annotated-pdf", "Export annotated PDF", "download", (v) => {
      if (!v.surface.document.pages.some((p) => p.bg.kind === "pdf")) {
        new Notice('This ink page has no PDF pages. Use "Annotate a PDF" to start one.');
        return;
      }
      return this.exportAnnotatedPdf(v);
    });
    onInk("export-pdf", "Export the ink page as PDF", "file-down", (v) => this.exportNotebookPdf(v));
    onInk("export-page-image", "Export this page as an image", "image-down", (v) => this.exportPageImage(v));
    this.addCommand({
      id: "process-queue",
      name: "Transcribe pages waiting for a connection",
      icon: "cloud-upload",
      callback: () => run(this.processQueue(true), "Transcription failed"),
    });
    this.addCommand({
      id: "toggle-eink",
      name: "Toggle e-ink optimisations",
      icon: "monitor",
      callback: async () => {
        this.settings.einkMode = einkActive(this.settings) ? "off" : "on";
        this.applyInkSettings();
        await this.saveSettings();
        new Notice(`E-ink optimisations ${einkActive(this.settings) ? "on" : "off"}.`);
      },
    });
    this.addCommand({
      id: "migrate-excalidraw",
      name: "Convert ink pages made with Excalidraw (earlier versions)",
      icon: "wand",
      callback: () => run(migrateExcalidrawPages(this), "Conversion failed"),
    });
    this.addCommand({
      id: "open-setup",
      name: "Open setup assistant",
      icon: "wand",
      callback: () => new SetupWizard(this).open(),
    });
  }

  private registerFileMenus(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        const code = mermaidBlockAt(editor.getValue(), editor.posToOffset(editor.getCursor()));
        if (code) {
          menu.addItem((i) =>
            i
              .setTitle("Add this Mermaid diagram to the ink library")
              .setIcon("workflow")
              .onClick(() => void this.addMermaidDiagram({ code, name: mermaidName(code, file?.basename) ?? undefined })),
          );
        }
        if (!file || !this.pairs.canAddInk(file)) return;
        const leaf = info instanceof MarkdownView ? info.leaf : undefined;
        menu.addItem((i) =>
          i
            .setTitle("Add an ink page")
            .setIcon("pencil-line")
            .onClick(() => void this.switcher.addInkToNote(file, { leaf, askPaper: true }).catch((e) => this.switcher.reportError("Could not add the ink page", e))),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((i) =>
            i
              .setTitle("New ink page")
              .setIcon("pencil-line")
              .onClick(() => void this.switcher.createPage({ folder: file.path }).catch((e) => this.switcher.reportError("Could not create the page", e))),
          );
          return;
        }
        if (!(file instanceof TFile)) return;
        const ext = file.extension.toLowerCase();
        if (ext === "mmd" || ext === "mermaid") {
          menu.addItem((i) =>
            i
              .setTitle("Add to the ink object library")
              .setIcon("workflow")
              .onClick(async () => {
                const code = await this.app.vault.cachedRead(file);
                void this.addMermaidDiagram({ code, name: mermaidName(code, file.basename) ?? undefined });
              }),
          );
          return;
        }
        if (ext === "pdf") {
          menu.addItem((i) =>
            i
              .setTitle("Annotate with Ink Notebook")
              .setIcon("pencil-line")
              .onClick(() => void annotatePdf(this, file)),
          );
        } else if (IMAGE_EXTENSIONS.includes(ext)) {
          menu.addItem((i) =>
            i
              .setTitle("Annotate with Ink Notebook")
              .setIcon("pencil-line")
              .onClick(() => void annotateImage(this, file)),
          );
        } else if (this.pairs.canAddInk(file)) {
          menu.addItem((i) =>
            i
              .setTitle("Add an ink page")
              .setIcon("pencil-line")
              .onClick(() => void this.switcher.addInkToNote(file, { askPaper: true }).catch((e) => this.switcher.reportError("Could not add the ink page", e))),
          );
        } else if (this.pairs.isDrawing(file) && !this.pairs.textFor(file)) {
          menu.addItem((i) =>
            i
              .setTitle("Create text page (Ink Notebook)")
              .setIcon("file-text")
              .onClick(async () => {
                try {
                  await this.pairs.createTextPage(file);
                  await this.sync.syncInkToText(file, { network: true });
                  this.bookmarks.refreshAll();
                } catch (e) {
                  this.switcher.reportError("Could not create the text page", e);
                }
              }),
          );
        }
      }),
    );
  }
}
