import { App, Notice, PluginSettingTab, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import type InkNotebookPlugin from "../main";
import { paperLabel } from "../core/paper";
import { cleanSubfolder } from "../core/folders";
import { PaperPickerModal } from "./paperPicker";
import { SetupWizard } from "./setupWizard";
import { recognitionItems } from "./recognitionSettings";
import { DAILY_INK_OPTIONS } from "../settings";
import { dailyNoteSettings } from "./dailyNotes";
import { BRIDGE_DOWNLOAD_URL, BRIDGE_START_URL } from "./fastInkBridge";
import { controlsByKey, folderValue, positiveInt, renderSettingItems, settingStore, type InkControl, type InkSetting, type InkSettingItem, type SettingStore } from "./settingItems";

/**
 * The settings tab. Obsidian 1.13+ renders it from getSettingDefinitions()
 * (and finds the settings in its settings search); older versions call
 * display(), which draws the same items.
 */
export class InkSettingTab extends PluginSettingTab {
  private readonly store: SettingStore;
  private controls = new Map<string, InkControl>();

  constructor(
    app: App,
    private plugin: InkNotebookPlugin,
  ) {
    super(app, plugin);
    this.store = settingStore(plugin);
    this.containerEl.addClass("ink-settings");
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const items = this.items();
    this.controls = controlsByKey(items);
    return items;
  }

  getControlValue(key: string): unknown {
    return Reflect.get(this.plugin.settings, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const control = this.controls.get(key);
    if (control) await this.store.set(control, value);
  }

  /** Obsidian before 1.13. */
  display(): void {
    this.draw();
  }

  hide(): void {
    this.plugin.fastInk.onChange = null;
    super.hide();
  }

  /** Where instant ink stands, in words. */
  private fastInkStatus(): string {
    const b = this.plugin.fastInk;
    const page = b.onPage;
    let onPage = "";
    if (page && b.connection !== "off") {
      onPage = page.armed
        ? ` On the ink page: instant ink was on – ${page.bridgeDrew ? "the Bridge was drawing" : "but the Bridge had not reported drawing"}, ${page.strokes} stroke(s) written since.`
        : ` On the ink page: instant ink was off – ${page.reason ?? "unknown"}.`;
    }
    return this.fastInkConnection() + onPage;
  }

  private fastInkConnection(): string {
    const b = this.plugin.fastInk;
    switch (b.connection) {
      case "off":
        return this.plugin.settings.fastInk === "off"
          ? "Off."
          : "Not on this device: instant ink needs an Onyx Boox tablet (or choose “Always on” for another Android tablet with the Boox firmware).";
      case "waiting": {
        let text = "Not connected. Install the Bridge app on your Boox, allow it to display over other apps and to access files, start it, then open an ink page.";
        const direct = b.lastDirectConnection;
        if (direct === "failed") text += " Direct connection: refused (Obsidian blocks it, or the Bridge is not running) – the control file in the vault is used instead.";
        else if (direct === "none") text += " Direct connection: not tried yet (it is tried while an ink page is open).";
        const vault = b.vaultPath;
        if (vault) {
          text += b.vaultInAppStorage
            ? ` Your vault is in Obsidian's app storage (${vault}), which the Bridge cannot read: it needs the direct connection, or move the vault to the device storage.`
            : ` Vault: ${vault} (the Bridge looks for it there; it is listed in the Bridge app under Vaults).`;
        }
        return text;
      }
      case "connected": {
        const s = b.status;
        const via = b.transport === "socket" ? "direct connection" : "control file";
        let text = `Connected to the Bridge app${s?.app ? ` ${s.app}` : ""} (${via}).`;
        if (s && !s.calibrated) text += " The position on screen is measured from your first strokes.";
        if (s?.error) text += ` Problem: ${s.error}`;
        return text;
      }
    }
  }

  private draw(): void {
    this.containerEl.empty();
    renderSettingItems(this.containerEl, this.items(), this.store);
  }

  /** Show the settings again after a change that changes other settings' names or descriptions. */
  private refresh(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.draw();
  }

  private items(): InkSettingItem[] {
    const s = this.plugin.settings;
    const apply = () => this.plugin.applyInkSettings();
    const toggle = (name: string, desc: string, key: Extract<InkControl, { type: "toggle" }>["key"], applyAfter = false): InkSetting => ({
      name,
      desc,
      control: { type: "toggle", key, after: applyAfter ? apply : undefined },
    });
    const dailyAvailable = !!dailyNoteSettings(this.app);

    return [
      {
        name: "Setup assistant",
        desc: "Walk through the setup again (writing, e-ink, handwriting recognition).",
        render: (setting) => {
          setting.addButton((b) => b.setButtonText("Open").onClick(() => new SetupWizard(this.plugin).open()));
        },
      },
      {
        type: "group",
        heading: "Writing",
        items: [
          {
            name: "Pen side button",
            desc: "What holding the button on the side of the pen does (the eraser end of the pen always erases).",
            control: { type: "dropdown", key: "sideButton", options: { eraser: "Erase", lasso: "Lasso (select)", none: "Nothing" }, after: apply },
          },
          toggle("Draw with a finger", "Off: only the pen writes; fingers turn pages, scroll and zoom (best with a stylus – your palm can rest on the screen).", "fingerDrawing", true),
          toggle("Pressure sensitivity", "Lines get wider the harder you press (fountain pen, brush, pencil).", "pressure", true),
          toggle("Scribble to erase", "Scratch quickly back and forth over writing with the pen to erase it.", "scribbleErase", true),
          toggle("Snap shapes when holding the pen", "Draw a line, rectangle, triangle or circle and keep the pen still at the end: it becomes a clean shape.", "holdToShape", true),
          toggle("Swipe to turn pages", "Swipe left/right (or up/down) with one finger.", "swipePages", true),
          toggle("Two-finger tap undoes", "", "twoFingerUndo", true),
          toggle("Three-finger tap redoes", "", "threeFingerRedo", true),
          {
            name: "Page on screen",
            control: { type: "dropdown", key: "fit", options: { page: "Whole page", width: "Page width (scroll down)" }, after: apply },
          },
          {
            name: "Toolbar",
            control: { type: "dropdown", key: "toolbarPosition", options: { top: "Top", bottom: "Bottom", left: "Left", right: "Right" }, after: apply },
          },
          {
            name: "Low-latency drawing",
            desc: "Draws the ink straight to the screen. Automatic leaves it off on e-ink screens, where it can show colours and the highlighter with a stripy pattern. Turn it off if the page flickers on your device.",
            control: { type: "dropdown", key: "lowLatency", options: { auto: "Automatic", on: "Always on", off: "Off" }, after: apply },
          },
        ],
      },
      {
        type: "group",
        heading: "Instant ink on Boox",
        items: [
          {
            name: "Instant ink",
            desc: "With the Ink Notebook Bridge app, the Boox firmware draws your writing straight onto the screen – with no lag, like in the Boox Notes app – while Ink Notebook records the strokes as always. Automatic: on Boox tablets, once the Bridge app is running.",
            aliases: ["Boox", "latency", "lag", "Bridge"],
            control: { type: "dropdown", key: "fastInk", options: { auto: "Automatic", on: "Always on", off: "Off" }, after: () => this.refresh() },
          },
          {
            name: "Page's own ink after",
            desc: "Milliseconds after you lift the pen before the instant ink gives way to the page's own drawing of the strokes. Longer means fewer screen refreshes while you write.",
            control: { type: "slider", key: "fastInkRefreshMs", min: 200, max: 3000, step: 100, after: () => this.plugin.fastInk.update() },
          },
          {
            name: "Ink Notebook Bridge app",
            desc: this.fastInkStatus(),
            render: (setting) => {
              this.plugin.fastInk.onChange = () => this.refresh();
              setting
                .addButton((b) => b.setButtonText("Start the Bridge").onClick(() => window.open(BRIDGE_START_URL)))
                .addButton((b) => b.setButtonText("Get the app").onClick(() => window.open(BRIDGE_DOWNLOAD_URL)));
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Pages",
        items: [
          {
            name: "Where new pages go",
            desc: "The folder of the note you are in, always the same folder, or choose the folder for each page. (When the paper picker is on, it shows the folder too, with a button to choose another.)",
            control: {
              type: "dropdown",
              key: "pageLocation",
              options: { current: "Folder of the current note", fixed: "Fixed folder", ask: "Ask every time" },
              after: () => this.refresh(),
            },
          },
          {
            name: s.pageLocation === "fixed" ? "Folder for new pages" : "Folder when no note is open",
            control: { type: "text", key: "folder", parse: folderValue("Ink") },
          },
          {
            name: "Subfolder for ink files",
            desc: "The ink pages (Name.ink.md) go into this subfolder of the text page's folder, so your folders only show your notes. Leave empty to keep them next to the text page.",
            control: { type: "text", key: "inkSubfolder", placeholder: "next to the text page", parse: (v) => (typeof v === "string" ? cleanSubfolder(v) : undefined) },
          },
          {
            name: "Paper for new pages",
            desc: paperLabel(s.paper),
            aliases: ["template", "ruled", "dotted", "squared"],
            render: (setting) => {
              setting.addButton((b) =>
                b.setButtonText("Choose…").onClick(async () => {
                  const choice = await PaperPickerModal.pick(this.app, { mode: "default", initial: s.paper });
                  if (!choice) return;
                  s.paper = choice.spec;
                  await this.plugin.saveSettings();
                  setting.setDesc(paperLabel(s.paper));
                }),
              );
            },
          },
          toggle("Choose the paper for every new page", "Show the paper picker (ruled, dotted, squared, … with spacing, colour and orientation) when creating a page.", "askForPaper"),
          toggle("Ask for a name when creating a page", "Type the name of a new page (the date and time is filled in – keep it or type over it). Off: pages are named with the date and time; rename them any time.", "askForPageName"),
          {
            name: "Open the text page in",
            control: { type: "dropdown", key: "textViewMode", options: { reading: "Reading view (calm, best on e-ink)", editing: "Editing view", keep: "Obsidian default" } },
          },
          {
            name: "Daily notes",
            desc: dailyAvailable
              ? "A new daily note gets an ink page (in its ink subfolder) when it opens. \"Opened to write on\" shows the ink page in its place. The command \"Open today's daily note on the ink page\" works with every option."
              : "Turn on the Daily notes core plugin (or Periodic Notes) – then new daily notes can come with an ink page.",
            control: { type: "dropdown", key: "dailyInk", options: { ...DAILY_INK_OPTIONS } },
          },
          {
            name: "Match up ink and text pages",
            desc: "Rename ink pages so that each text page Name.md has its ink page Name.ink.md in the ink subfolder next to it (e.g. a \"2026-10-27 (text)\" text page becomes \"2026-10-27\"). You see the list before anything is renamed.",
            render: (setting) => {
              setting.addButton((b) => b.setButtonText("Match up…").onClick(() => void this.plugin.matchUpPages()));
            },
          },
          toggle("Keep names in sync", "Renaming or moving the ink or text page renames/moves the other one too.", "keepNamesInSync"),
        ],
      },
      {
        type: "group",
        heading: "Handwriting recognition",
        items: [
          ...recognitionItems(this.plugin, { advanced: true }),
          toggle(
            "Mark uncertain words",
            "Highlight words the recognition is unsure about (==like this==) on the text page so they are easy to proofread – also words it read correctly but found hard to read. The highlights stay in the note until you remove them.",
            "highlightUncertain",
          ),
          toggle(
            "Transcribe while writing",
            "Also update the text page a few seconds after you stop writing (uses more requests). Otherwise it updates when you open the text page or leave the ink page.",
            "autoTranscribe",
          ),
          {
            name: "Wait for recognition when flipping (seconds)",
            desc: "If recognition takes longer, the text page opens anyway and updates when the result arrives.",
            control: { type: "slider", key: "transcribeTimeoutSec", min: 3, max: 60, step: 1 },
          },
          toggle("Clickable handwritten links", "A handwritten [[Page]] gets a link button on the ink page, so you can jump to the page from your handwriting.", "linkHandwriting"),
          {
            name: "Diagram detection",
            desc: "How eagerly drawings (not text) are shown as pictures on the text page. Tip: select a drawing with the lasso and tap \"Figure\" to force it.",
            control: { type: "dropdown", key: "diagramSensitivity", options: { low: "Only clear drawings", normal: "Normal", high: "Also small sketches" } },
          },
          {
            name: "Offline queue",
            desc: `${s.queue.length} page(s) waiting for handwriting recognition.`,
            render: (setting) => {
              setting
                .addButton((b) => b.setButtonText("Retry now").onClick(() => void this.plugin.processQueue(true)))
                .addButton((b) =>
                  b.setButtonText("Clear recognition cache").onClick(() => {
                    this.plugin.ocr.clearCache();
                    new Notice("Recognition cache cleared. Pages are recognised again the next time you flip them.");
                  }),
                );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Display & e-ink",
        items: [
          {
            name: "E-ink optimisations",
            desc: "No animations or shadows, high contrast, larger touch targets. Automatic turns this on for Boox and other e-ink devices.",
            aliases: ["Boox", "eink"],
            control: { type: "dropdown", key: "einkMode", options: { auto: "Automatic", on: "Always on", off: "Off" }, after: apply },
          },
          toggle("Large touch targets", "Bigger buttons on phones, tablets and e-ink devices.", "largeTouchTargets", true),
          {
            name: "Bookmark position",
            desc: "Where the Ink/Text bookmarks prefer to sit on the right edge of the text page.",
            control: { type: "dropdown", key: "bookmarkPosition", options: { top: "Upper", middle: "Middle", bottom: "Lower" }, after: () => this.plugin.bookmarks.refreshAll() },
          },
        ],
      },
      {
        type: "group",
        heading: "PDF annotation",
        items: [
          {
            name: "Ask which pages to import above",
            desc: "PDFs with more pages ask for a page range (big PDFs are slow on e-ink devices).",
            control: { type: "number", key: "pdfMaxPagesWithoutAsking", min: 1, parse: positiveInt },
          },
          {
            name: "Folder for papers from arXiv",
            desc: "Imported papers get a text page here (with title, authors and abstract); the PDF and the ink page go into its subfolder for ink files.",
            control: { type: "text", key: "papersFolder", parse: folderValue("Papers") },
          },
        ],
      },
      {
        type: "group",
        heading: "Object libraries",
        items: [
          {
            name: "Folder for libraries",
            desc: "Excalidraw libraries you import and “My library” (what you keep with “To library” in the lasso menu) are saved here, and Mermaid diagrams in its “Mermaid” folder (one note with a ```mermaid block each – change the note and the diagram changes). Libraries (.excalidrawlib) anywhere else in the vault and the library of the Excalidraw plugin are shown too.",
            control: { type: "text", key: "libraryFolder", parse: folderValue("Ink libraries") },
          },
        ],
      },
    ];
  }
}
