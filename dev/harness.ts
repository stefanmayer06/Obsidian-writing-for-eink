/**
 * Runs the ink surface and toolbar outside Obsidian, in a plain browser page
 * (dev/harness.html), for fast checks of drawing, tools and speed.
 * Build: node dev/build-harness.mjs
 */
import "./obsidianDom";
import { InkSurface } from "../src/ink/surface";
import { Toolbar } from "../src/ink/ui/toolbar";
import { newDoc, EMPTY_META } from "../src/core/ink/model";
import { inkTextMeasure, NO_IMAGES } from "../src/ink/render";
import { mermaidToItems } from "../src/core/ink/fromMermaid";
import { parseInkFile, serializeInkFile } from "../src/core/ink/codec";
import { drawThumb, LibraryPanel } from "../src/ink/ui/libraryPanel";
import { FLOWCHART_LIBRARY_ID, flowchartLibrary } from "../src/core/ink/flowchart";
import { libraryItems, parseExcalidrawLibrary } from "../src/core/ink/excalidrawLib";
import { FastInkBridge } from "../src/obsidian/fastInkBridge";
import type InkNotebookPlugin from "../src/main";

/** A small Excalidraw library (as from libraries.excalidraw.com). */
const SAMPLE_LIBRARY = {
  type: "excalidrawlib",
  version: 2,
  libraryItems: [
    {
      id: "cloud",
      name: "Labelled box",
      status: "published",
      elements: [
        { id: "r", type: "rectangle", x: 0, y: 0, width: 200, height: 90, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "hachure", strokeWidth: 2, roundness: { type: 3 }, angle: 0, opacity: 100 },
        { id: "t", type: "text", x: 50, y: 32, width: 100, height: 25, text: "Server", originalText: "Server", fontSize: 20, textAlign: "center", containerId: "r", strokeColor: "#1971c2" },
      ],
    },
  ],
};

/** A Mermaid diagram (from the feature request: subgraphs, labelled links, a loop back, classDef colours). */
const SAMPLE_MERMAID = `flowchart TD
    subgraph Notes
        B["Board object<br/>2D array, n × n"]
        P["Player object<br/>Lives on board, owns a logger"]
    end
    subgraph SU["Start up"]
        M["main(): random(n)"] --> D
        T["Tests: fixed(6, 6)"] --> D
        D["Create dice shaker<br/>DiceRollerFactory"] --> CP(["Create player"])
        CP --> AB["Add to board<br/>Place on start square"]
        AB --> CL["Create logger<br/>One per player"]
        subgraph LCF["Logger creation flow"]
            LF(["Logger creation flow"]) --> PV["Pass player var<br/>Through an interface"]
            PV --> AC["Assign log colour<br/>Unique per player"]
            AC --> LR["Logger ready<br/>Prints player + dice roll"]
        end
        CL --> LF
        LR --> MP{"More players?"}
        MP -- yes --> CP
    end
    MP -- no --> SG["Start game<br/>Game(shaker, players)"]
    classDef dice fill:#E1F5EE,stroke:#0F6E56,color:#085041
    classDef logger fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    class M,T,D dice
    class LF,PV,AC,LR logger`;

const root = document.getElementById("app") as HTMLElement;
root.classList.add("ink-view-content");
root.dataset.toolbar = "top";

const icon = (el: HTMLElement, name: string) => {
  el.textContent = name.slice(0, 2);
  el.dataset.icon = name;
};

const log: string[] = [];
let changes = 0;
let toolbar: Toolbar | null = null;
let library: LibraryPanel | null = null;
/** The "Sample" library (replace it from the console to try any .excalidrawlib). */
let sample: unknown = SAMPLE_LIBRARY;
/** Instant ink, when attached (window.attachFastInk). */
let fastInk: FastInkBridge | null = null;
const surface = new InkSurface(root, {
  images: NO_IMAGES,
  icon,
  openLink: (t) => log.push(`open:${t}`),
  changed: () => changes++,
  pageChanged: (i, n) => toolbar?.refreshPage(i, n),
  historyChanged: (u, r) => toolbar?.refreshHistory(u, r),
  toolChanged: () => {
    toolbar?.refreshTools();
    library?.markActive();
  },
  notice: (m) => log.push(`notice:${m}`),
  viewChanged: () => fastInk?.update(),
  penDown: (x, y) => fastInk?.penDown(x, y),
  inkDiscarded: () => fastInk?.discard(),
  pageRedrawn: () => fastInk?.refreshSoon(),
});
toolbar = new Toolbar(root, surface, {
  icon,
  openPages: () => log.push("pages"),
  insertMenu: () => [{ items: [{ icon: "link", label: "Link to a note…", run: () => surface.insertLink("Some note") }] }],
  moreMenu: () => [{ items: [{ icon: "file-plus", label: "Add page at the end", run: () => surface.addPage("end") }] }],
  toolsChanged: () => undefined,
  settingsChanged: () => undefined,
  endButtons: () => [{ id: "text", icon: "file-text", label: "Text", showLabel: true, run: () => log.push("text") }],
  openLibrary: () => {
    if (library) {
      library.close();
      return;
    }
    library = new LibraryPanel(
      surface.el,
      surface,
      {
        icon,
        sources: async () => [
          { id: FLOWCHART_LIBRARY_ID, name: "Flowchart", flowchart: true },
          { id: "mermaid", name: "Mermaid", editable: true },
          { id: "sample", name: "Sample" },
        ],
        items: async (id) =>
          id === FLOWCHART_LIBRARY_ID
            ? flowchartLibrary()
            : id === "mermaid"
              ? [{ id: "mermaid:Start up.md#0", name: "Start up", items: mermaidToItems(SAMPLE_MERMAID, inkTextMeasure()).items, fitPage: true }]
              : libraryItems(parseExcalidrawLibrary(sample)),
        setTools: (patch) => {
          surface.setTools(patch);
          toolbar?.refreshTools();
        },
        actions: () => [{ icon: "upload", label: "Import a library file…", run: () => log.push("import") }],
      },
      () => (library = null),
    );
  },
});
// the toolbar goes first in the flex column
root.prepend(toolbar.el);
surface.load({ doc: newDoc(), meta: EMPTY_META });
surface.resize();

/**
 * Instant ink with the real plugin code, talking to a Bridge on 127.0.0.1
 * (dev/fastink-e2e.cjs runs one without Android). The plugin around it is a
 * stand-in: settings, a vault adapter in memory, DOM events.
 */
function attachFastInk(): FastInkBridge {
  const files = new Map<string, string>();
  const plugin = {
    settings: { fastInk: "on", fastInkRefreshMs: 800, sideButton: "eraser" },
    manifest: { id: "ink-notebook", dir: ".obsidian/plugins/ink-notebook" },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
          mkdir: async () => undefined,
          write: async (p: string, t: string) => void files.set(p, t),
          read: async (p: string) => files.get(p) ?? "",
        },
      },
    },
    registerDomEvent: (el: EventTarget, name: string, fn: EventListener) => el.addEventListener(name, fn),
    registerInterval: (id: number) => id,
  } as unknown as InkNotebookPlugin;
  fastInk = new FastInkBridge(plugin, () => ({ surface, containerEl: root }));
  fastInk.start();
  return fastInk;
}

Object.assign(window, {
  attachFastInk,
  fastInk: () => fastInk,
  surface,
  library: () => library,
  log,
  getChanges: () => changes,
  parseInkFile,
  serializeInkFile,
  setSampleLibrary: (v: unknown) => (sample = v),
  libraryThumbs: (v: unknown) => libraryItems(parseExcalidrawLibrary(v)).map((it) => {
    const c = document.createElement("canvas");
    drawThumb(c, it);
    return c;
  }),
});
