import { Modal, Platform, Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import { paperLabel } from "../core/paper";
import { PaperPickerModal } from "./paperPicker";
import { currentDevice } from "./einkMode";
import { renderRecognitionSettings } from "./recognitionSettings";
import { DAILY_INK_OPTIONS, type DailyInk } from "../settings";

/**
 * First-run setup: device and pen (e-ink, finger drawing, side button), optional
 * handwriting recognition and where pages go. Everything can be changed later
 * in settings.
 */
export class SetupWizard extends Modal {
  constructor(private plugin: InkNotebookPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("ink-modal", "ink-setup");
    this.titleEl.setText("Welcome to Ink Notebook");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.applyInkSettings();
    };
    contentEl.createEl("p", {
      text: "Write by hand on the ink page – like in the Boox Notes app – and read your notes as text on the text page. Three quick steps; you can change everything later in the settings.",
    });

    // ---- Step 1: device and pen ----
    const step1 = this.step(contentEl, "1", "Your device and pen");
    const dev = currentDevice();
    step1.createEl("p", {
      text: dev.isEink
        ? `Detected an e-ink device (${dev.vendor ?? "e-ink"}${dev.model ? ` ${dev.model}` : ""}). E-ink optimisations are on. For the fastest writing, set the refresh mode for Obsidian to "Fast" or "Balanced" in the Boox E-Ink Center.`
        : Platform.isMobile
          ? "On a Boox or other e-ink tablet, turn on the e-ink optimisations."
          : "E-ink optimisations are meant for Boox and other e-ink tablets.",
    });
    new Setting(step1)
      .setName("E-ink optimisations")
      .setDesc("No animations or shadows, high contrast, larger buttons.")
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Automatic (detect e-ink)", on: "Always on", off: "Off" })
          .setValue(s.einkMode)
          .onChange(async (v) => {
            s.einkMode = v as typeof s.einkMode;
            await save();
          }),
      );
    new Setting(step1)
      .setName("Draw with a finger")
      .setDesc("Off (recommended with a pen): only the pen writes; fingers turn pages, scroll and zoom, and your palm can rest on the screen.")
      .addToggle((t) =>
        t.setValue(s.fingerDrawing).onChange(async (v) => {
          s.fingerDrawing = v;
          await save();
        }),
      );
    new Setting(step1)
      .setName("Pen side button")
      .setDesc("Hold it to erase (the eraser end of the pen always erases). On Android (Samsung S Pen, Boox), press it before the pen touches the screen.")
      .addDropdown((d) =>
        d
          .addOptions({ eraser: "Erase", lasso: "Lasso (select)", none: "Nothing" })
          .setValue(s.sideButton)
          .onChange(async (v) => {
            s.sideButton = v as typeof s.sideButton;
            await save();
          }),
      );

    // ---- Step 2: handwriting recognition ----
    const step2 = this.step(contentEl, "2", "Handwriting → text (optional)");
    step2.createEl("p", {
      text: "Without it, your handwriting is shown as a picture on the text page. Offline, pages are queued and transcribed when you're back online.",
    });
    renderRecognitionSettings(step2, this.plugin);

    // ---- Step 3: pages ----
    const step3 = this.step(contentEl, "3", "Your pages");
    new Setting(step3)
      .setName("Where new pages go")
      .setDesc(
        s.inkSubfolder
          ? `The text page goes into the folder of the note you are in, the ink page into its "${s.inkSubfolder}" subfolder.`
          : "The text page and the ink page go into the folder of the note you are in.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ current: "Folder of the current note", fixed: `Always "${s.folder || "Ink"}"`, ask: "Ask every time" })
          .setValue(s.pageLocation)
          .onChange(async (v) => {
            s.pageLocation = v === "fixed" || v === "ask" ? v : "current";
            await this.plugin.saveSettings();
          }),
      );
    new Setting(step3)
      .setName("Daily notes")
      .setDesc("New daily notes (Daily notes core plugin or Periodic Notes) can come with an ink page.")
      .addDropdown((d) =>
        d
          .addOptions(DAILY_INK_OPTIONS)
          .setValue(s.dailyInk)
          .onChange(async (v) => {
            s.dailyInk = v as DailyInk;
            await this.plugin.saveSettings();
          }),
      );
    const paperSetting = new Setting(step3)
      .setName("Paper")
      .setDesc(`${paperLabel(s.paper)} – ruled paper helps handwriting recognition.`)
      .addButton((b) =>
        b.setButtonText("Choose…").onClick(async () => {
          const choice = await PaperPickerModal.pick(this.app, { mode: "default", initial: s.paper });
          if (!choice) return;
          s.paper = choice.spec;
          await this.plugin.saveSettings();
          paperSetting.setDesc(`${paperLabel(s.paper)} – ruled paper helps handwriting recognition.`);
        }),
      );

    // ---- Finish ----
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Close").onClick(async () => {
          s.setupDone = true;
          await this.plugin.saveSettings();
          this.close();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Create my first ink page")
          .setCta()
          .onClick(async () => {
            s.setupDone = true;
            await this.plugin.saveSettings();
            this.close();
            await this.plugin.switcher.createPage({ paper: s.paper });
          }),
      );
  }

  private step(parent: HTMLElement, n: string, title: string): HTMLElement {
    const box = parent.createDiv({ cls: "ink-step" });
    const h = box.createDiv({ cls: "ink-step-title" });
    h.createSpan({ cls: "ink-step-num", text: n });
    h.createSpan({ text: title });
    return box;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
