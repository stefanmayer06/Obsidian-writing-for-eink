import { describe, expect, it } from "vitest";
import {
  cleanLabel,
  linkCurve,
  looksLikeMermaid,
  mermaidBlockAt,
  mermaidBlocks,
  MermaidError,
  mermaidNote,
  mermaidName,
  parseMermaid,
  parseStyle,
  removeMermaidBlock,
} from "../src/core/ink/mermaid";
import { layoutGraph, placeInOrder, type LayoutGraph } from "../src/core/ink/layered";
import { approxTextWidth, cssColor, mermaidToItems, routeEdge } from "../src/core/ink/fromMermaid";
import { closedOutline } from "../src/core/ink/fill";
import { pointInPolygon, strokePointBounds } from "../src/core/ink/geom";
import { followMoves, isConnectable } from "../src/core/ink/connectors";
import { cloneItems, paperPage, type Stroke } from "../src/core/ink/model";
import { strokeRuns } from "../src/core/ink/pens";
import { shapeFromDrag } from "../src/core/ink/shapes";
import { transformItems, translation } from "../src/core/ink/transform";
import type { Rect } from "../src/core/geometry";

/** The diagram from the feature request: subgraphs in subgraphs, labelled links, a loop back, classDef colours. */
const START_UP = `flowchart TD
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

const inside = (r: Rect, o: Rect, slack = 0.5) => r.x >= o.x - slack && r.y >= o.y - slack && r.x + r.w <= o.x + o.w + slack && r.y + r.h <= o.y + o.h + slack;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function points(s: Stroke): Array<{ x: number; y: number }> {
  const out = [];
  for (let i = 0; i + 2 < s.pts.length; i += 3) out.push({ x: s.pts[i], y: s.pts[i + 1] });
  return out;
}

/** The sharpest turn of a line between two of its pieces, in degrees. */
function sharpest(pts: ReadonlyArray<{ x: number; y: number }>): number {
  let worst = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    worst = Math.max(worst, (d * 180) / Math.PI);
  }
  return worst;
}

const crosses = (pts: ReadonlyArray<{ x: number; y: number }>, r: Rect) => pts.some((p) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h);

describe("Mermaid: reading flowcharts", () => {
  it("reads the diagram of the request: nodes, shapes, labels, links, nested subgraphs and classes", () => {
    const g = parseMermaid(START_UP);
    expect(g.dir).toBe("TB");
    expect(g.nodes.size).toBe(14);
    expect(g.nodes.get("B")?.label).toBe("Board object\n2D array, n × n");
    expect(g.nodes.get("CP")?.shape).toBe("stadium");
    expect(g.nodes.get("MP")?.shape).toBe("diamond");
    expect(g.nodes.get("M")?.label).toBe("main(): random(n)");
    expect(g.edges).toHaveLength(12);
    expect(g.edges.find((e) => e.from === "MP" && e.to === "CP")?.label).toBe("yes");
    expect(g.edges.find((e) => e.from === "MP" && e.to === "SG")?.label).toBe("no");
    expect(g.root).toEqual(["Notes", "SU", "SG"]);
    expect(g.subgraphs.get("SU")?.title).toBe("Start up");
    expect(g.subgraphs.get("SU")?.children).toEqual(["M", "D", "T", "CP", "AB", "CL", "LCF", "MP"]);
    expect(g.subgraphs.get("LCF")?.parent).toBe("SU");
    expect(g.subgraphs.get("LCF")?.children).toEqual(["LF", "PV", "AC", "LR"]);
    expect(g.nodes.get("D")?.classes).toEqual(["dice"]);
    expect(g.nodes.get("LR")?.classes).toEqual(["logger"]);
    expect(g.classDefs.get("dice")).toEqual({ fill: "#E1F5EE", stroke: "#0F6E56", color: "#085041" });
  });

  it("knows every node shape", () => {
    const g = parseMermaid(`graph LR
      a[rect] --> b(round) --> c([stadium]) --> d[[sub]] --> e[(db)] --> f((circle)) --> g(((double)))
      h>flag] --> i{diamond} --> j{{hex}} --> k[/lean r/] --> l[\\lean l\\] --> m[/trap\\] --> n[\\inv/]
      o@{ shape: doc, label: "Report" } --> p@{ shape: cyl } --> q`);
    const shape = (id: string) => g.nodes.get(id)?.shape;
    expect(["a", "b", "c", "d", "e", "f", "g"].map(shape)).toEqual(["rect", "round", "stadium", "subroutine", "cylinder", "circle", "double-circle"]);
    expect(["h", "i", "j", "k", "l", "m", "n"].map(shape)).toEqual(["asymmetric", "diamond", "hexagon", "lean-right", "lean-left", "trapezoid", "trapezoid-top"]);
    expect(shape("o")).toBe("document");
    expect(g.nodes.get("o")?.label).toBe("Report");
    expect(shape("p")).toBe("cylinder");
    expect(g.nodes.get("p")?.label).toBe("p");
    expect(shape("q")).toBe("rect");
    expect(g.dir).toBe("LR");
  });

  it("reads every kind of link, their labels, lengths, chains and &", () => {
    const g = parseMermaid(`flowchart TB
      A --> B
      A --- C
      A -.-> D
      A ==> E
      A <--> F
      A --o G
      A ~~~ H
      A -- text --> I
      A -->|bars| J
      A -. dotted .-> K
      A == thick ==> L
      A ---> M
      N & O --> P --> Q
      R-->S
      T e1@--> U`);
    const e = (to: string) => g.edges.find((x) => x.to === to);
    expect(e("B")).toMatchObject({ stroke: "normal", end: true, start: false, minlen: 1, label: "" });
    expect(e("C")).toMatchObject({ stroke: "normal", end: false });
    expect(e("D")).toMatchObject({ stroke: "dotted", end: true });
    expect(e("E")).toMatchObject({ stroke: "thick", end: true });
    expect(e("F")).toMatchObject({ start: true, end: true });
    expect(e("G")).toMatchObject({ end: true });
    expect(e("H")).toMatchObject({ stroke: "invisible" });
    expect(e("I")?.label).toBe("text");
    expect(e("J")?.label).toBe("bars");
    expect(e("K")).toMatchObject({ stroke: "dotted", label: "dotted", end: true });
    expect(e("L")).toMatchObject({ stroke: "thick", label: "thick", end: true });
    expect(e("M")?.minlen).toBe(2);
    expect(g.edges.filter((x) => x.to === "P").map((x) => x.from)).toEqual(["N", "O"]);
    expect(e("Q")?.from).toBe("P");
    expect(e("S")?.from).toBe("R");
    expect(e("U")?.from).toBe("T");
  });

  it("reads labels: quotes, line breaks, HTML, Markdown strings and entities", () => {
    expect(cleanLabel('"a<br/>b<br>c"')).toBe("a\nb\nc");
    expect(cleanLabel("<b>bold</b> and <i>it</i>")).toBe("bold and it");
    expect(cleanLabel('"`**Bold** text`"')).toBe("Bold text");
    expect(cleanLabel("A #quot;quote#quot; #35; &amp; #9829;")).toBe('A "quote" # & ♥');
    expect(cleanLabel("fa:fa-car Car")).toBe("Car");
    const g = parseMermaid('graph TD\n  A["Text with [brackets] and (parens)"] --> B["`Markdown\nover lines`"]');
    expect(g.nodes.get("A")?.label).toBe("Text with [brackets] and (parens)");
    expect(g.nodes.get("B")?.label).toBe("Markdown\nover lines");
  });

  it("puts a node into the innermost subgraph it is written in, and links to subgraphs go to the subgraph", () => {
    const g = parseMermaid(`flowchart LR
      x --> y
      subgraph A [Outer]
        direction TB
        y --> z
        subgraph B
          z --> w
        end
      end
      x --> A
      subgraph "Only a title"
        q
      end`);
    expect(g.root).toEqual(["x", "A", "subgraph-1"]);
    expect(g.subgraphs.get("A")?.children).toEqual(["y", "B"]);
    expect(g.subgraphs.get("A")?.dir).toBe("TB");
    expect(g.subgraphs.get("B")?.children).toEqual(["z", "w"]);
    expect(g.subgraphs.get("subgraph-1")?.title).toBe("Only a title");
    expect(g.nodes.has("A")).toBe(false);
    expect(g.edges.find((e) => e.to === "A")?.from).toBe("x");
  });

  it("reads how links are drawn: Mermaid's curve, from the frontmatter, an init directive or linkStyle", () => {
    expect(parseMermaid("flowchart TD\n  A --> B").curve).toBe("curve");
    expect(parseMermaid("---\nconfig:\n  flowchart:\n    curve: stepAfter\n---\nflowchart TD\n  A --> B").curve).toBe("step");
    expect(parseMermaid(`%%{init: {"flowchart": {"curve": "linear"}}}%%\nflowchart TD\n  A --> B`).curve).toBe("linear");
    expect(parseMermaid("%%{ init: { 'flowchart': { 'curve': 'monotoneX' } } }%%\ngraph LR\n  A --> B").curve).toBe("curve");
    const g = parseMermaid("flowchart TD\n  A --> B --> C\n  linkStyle 1 interpolate step stroke:#f00\n  linkStyle default interpolate linear");
    expect(g.edges[0].curve).toBe("linear");
    expect(g.edges[1].curve).toBe("step");
    expect(g.edges[1].style.stroke).toBe("#f00");
    expect(["basis", "bumpY", "cardinal", "curveCatmullRom", "natural", "step", "stepBefore", "linear", ""].map((n) => linkCurve(n))).toEqual([
      "curve",
      "curve",
      "curve",
      "curve",
      "curve",
      "step",
      "step",
      "linear",
      null,
    ]);
  });

  it("reads styles, classes, comments, frontmatter and statements on one line", () => {
    const g = parseMermaid(`---
title: My flow
config:
  look: classic
---
%%{init: {"theme": "forest"}}%%
graph LR; A:::hot --> B; B --> C %% a comment
classDef hot fill:#f96,stroke:#333,stroke-width:4px,stroke-dasharray: 5 5
classDef default fill:rgb(240, 240, 240)
style B fill:#bbf,color:#fff
linkStyle 1 stroke:#ff3,stroke-width:4px
linkStyle default stroke:blue`);
    expect(g.title).toBe("My flow");
    expect(g.nodes.get("A")?.classes).toEqual(["hot"]);
    expect(g.classDefs.get("hot")).toEqual({ fill: "#f96", stroke: "#333", strokeWidth: 4, dash: true });
    expect(g.classDefs.get("default")?.fill).toBe("rgb(240, 240, 240)");
    expect(g.nodes.get("B")?.style).toEqual({ fill: "#bbf", color: "#fff" });
    expect(g.edges[1].style).toEqual({ stroke: "#ff3", strokeWidth: 4 });
    expect(g.edges[0].style).toEqual({ stroke: "blue" });
    expect(parseStyle("fill:rgba(1,2,3,0.5), stroke:none")).toEqual({ fill: "rgba(1,2,3,0.5)", stroke: "none" });
    // a name: the title, else the note's name, else the biggest subgraph
    expect(mermaidName(START_UP)).toBe("Start up");
    expect(mermaidName(START_UP, "Snakes and ladders")).toBe("Snakes and ladders");
    expect(mermaidName("---\ntitle: Given\n---\nflowchart TD\n A --> B", "File")).toBe("Given");
    expect(mermaidName("flowchart TD\n A --> B")).toBeNull();
  });

  it("says what is wrong, with the line", () => {
    expect(() => parseMermaid("sequenceDiagram\n  A->>B: hi")).toThrow(/sequence diagram.*Only flowcharts/);
    expect(() => parseMermaid("")).toThrow(MermaidError);
    expect(() => parseMermaid("flowchart XY\n A --> B")).toThrow(/not a direction/);
    expect(() => parseMermaid("flowchart TD\n  A --> B\n  end")).toThrow(/Line 3/);
    expect(() => parseMermaid("flowchart TD\n  A[open --> B")).toThrow(/Line 2.*not closed/);
    expect(() => parseMermaid("flowchart TD\n  A -->")).toThrow(/no node at its end/);
  });

  it("finds diagrams in notes, the one under the cursor, and removes one", () => {
    const note = "# Title\n\n```mermaid\ngraph TD\n  A --> B\n```\n\ntext\n\n~~~mermaid\nflowchart LR\n  C --> D\n~~~\n";
    expect(mermaidBlocks(note)).toEqual(["graph TD\n  A --> B", "flowchart LR\n  C --> D"]);
    expect(mermaidBlocks("flowchart TD\n A --> B")).toEqual(["flowchart TD\n A --> B"]);
    expect(mermaidBlocks("just a note")).toEqual([]);
    expect(looksLikeMermaid("%% c\ngraph LR\nA-->B")).toBe(true);
    expect(mermaidBlockAt(note, note.indexOf("A -->"))).toBe("graph TD\n  A --> B");
    expect(mermaidBlockAt(note, note.indexOf("text"))).toBeNull();
    expect(mermaidBlocks(removeMermaidBlock(note, 0) as string)).toEqual(["flowchart LR\n  C --> D"]);
    expect(removeMermaidBlock(note, 5)).toBeNull();
    expect(mermaidBlocks(mermaidNote("graph TD\r\n A --> B\r\n"))).toEqual(["graph TD\n A --> B"]);
  });
});

describe("layered layout", () => {
  it("places in order, as close as it can to the attractors (weighted medians)", () => {
    // free: each where it wants to be
    expect(placeInOrder([[[0, 1]], [[100, 1]]], [0, 0], [10])).toEqual([0, 100]);
    // in each other's way: kept apart, the heavier one keeps its place
    expect(placeInOrder([[[50, 1]], [[50, 5]]], [0, 0], [20])).toEqual([30, 50]);
    // a node pulled both ways stays where it was
    expect(placeInOrder([[[0, 1], [10, 1]]], [7], [])).toEqual([7]);
  });

  const sizes = (ids: string[]) => new Map(ids.map((id) => [id, { w: 80, h: 40 }]));

  it("puts nodes in ranks along the flow, without overlaps, and edges between the ranks", () => {
    const g: LayoutGraph = {
      dir: "TB",
      nodes: sizes(["a", "b", "c", "d"]),
      clusters: new Map(),
      root: ["a", "b", "c", "d"],
      edges: [
        { id: "1", from: "a", to: "b" },
        { id: "2", from: "a", to: "c" },
        { id: "3", from: "b", to: "d" },
        { id: "4", from: "c", to: "d" },
        { id: "5", from: "a", to: "d", label: { w: 30, h: 18 } },
      ],
    };
    const r = layoutGraph(g);
    const n = (id: string) => r.nodes.get(id) as Rect;
    expect(n("b").y).toBeGreaterThan(n("a").y + n("a").h);
    expect(n("d").y).toBeGreaterThan(n("b").y + n("b").h);
    expect(overlap(n("b"), n("c"))).toBe(false);
    const long = r.edges.get("5");
    expect(long?.reversed).toBe(false);
    expect(long?.points.length).toBeGreaterThan(0);
    expect(long?.label).not.toBeNull();
    for (const id of ["a", "b", "c", "d"]) expect(overlap(long?.label as Rect, n(id))).toBe(false);
    // left to right turns it on its side
    const lr = layoutGraph({ ...g, dir: "LR" });
    expect((lr.nodes.get("b") as Rect).x).toBeGreaterThan((lr.nodes.get("a") as Rect).x + 80);
    const bt = layoutGraph({ ...g, dir: "BT" });
    expect((bt.nodes.get("a") as Rect).y).toBeGreaterThan((bt.nodes.get("d") as Rect).y);
  });

  it("keeps clusters around what they hold, and loops go back against the flow", () => {
    const g: LayoutGraph = {
      dir: "TB",
      nodes: sizes(["a", "b", "c", "x"]),
      clusters: new Map([["k", { children: ["b", "c"], title: { w: 60, h: 20 } }]]),
      root: ["a", "k", "x"],
      edges: [
        { id: "1", from: "a", to: "b" },
        { id: "2", from: "b", to: "c" },
        { id: "3", from: "c", to: "x" },
        { id: "4", from: "x", to: "a" },
      ],
    };
    const r = layoutGraph(g);
    const k = r.clusters.get("k") as Rect;
    expect(inside(r.nodes.get("b") as Rect, k)).toBe(true);
    expect(inside(r.nodes.get("c") as Rect, k)).toBe(true);
    expect(inside(r.nodes.get("a") as Rect, k)).toBe(false);
    expect(r.clusters.get("k")?.title).not.toBeNull();
    expect(r.edges.get("4")?.reversed).toBe(true);
    expect(r.edges.get("1")?.reversed).toBe(false);
  });
});

describe("Mermaid as ink", () => {
  const ink = mermaidToItems(START_UP);
  const { strokes, texts } = ink.items;
  const shapes = strokes.filter((s) => isConnectable(s));
  const arrows = strokes.filter((s) => s.from || s.to);

  it("has a shape for every node and subgraph, and an attached arrow for every link", () => {
    expect(ink.shapes).toBe(14);
    expect(ink.arrows).toBe(12);
    expect(shapes).toHaveLength(14 + 3);
    expect(arrows).toHaveLength(12);
    for (const a of arrows) {
      expect(a.curve).toBe(true);
      // versions without curves route it with right angles
      expect(a.elbow).toBe(true);
      expect(a.arrow).toBe(true);
      expect(shapes.some((s) => s.id === a.from)).toBe(true);
      expect(shapes.some((s) => s.id === a.to)).toBe(true);
    }
  });

  it("puts the labels in their shapes, the titles in their subgraphs, the link labels beside the links", () => {
    const labels = texts.filter((t) => t.container);
    expect(labels).toHaveLength(14);
    for (const t of labels) {
      const s = shapes.find((x) => x.id === t.container) as Stroke;
      const b = strokePointBounds(s);
      expect(t.align).toBe("center");
      expect(t.y).toBeGreaterThan(b.y);
      expect(t.y + t.h).toBeLessThan(b.y + b.h);
    }
    // wide enough for the text as measured, with room to spare: it is not wrapped again when the diagram is scaled
    for (const t of labels) for (const line of t.text.split("\n")) expect(approxTextWidth(line, t.size) * 1.03).toBeLessThan(t.w);
    expect(labels.find((t) => t.text === "More players?")).toBeDefined();
    expect(texts.find((t) => t.text === "Start up" && !t.container)).toBeDefined();
    expect(texts.find((t) => t.text === "yes")).toBeDefined();
    expect(texts.find((t) => t.text === "no")).toBeDefined();
    // nothing is written over a shape it does not belong to
    for (const t of texts) {
      for (const s of shapes) {
        if (s.id === t.container || s.fill?.startsWith("#f3") || s.fill?.startsWith("#e7")) continue;
        if (t.container) continue;
        const b = strokePointBounds(s);
        const inSubgraph = t.x >= b.x && t.x + t.w <= b.x + b.w && t.y >= b.y && t.y + t.h <= b.y + b.h;
        if (!inSubgraph) expect(overlap(t, b)).toBe(false);
      }
    }
  });

  it("keeps the colours of classDef, and draws the rest black on white", () => {
    const shapeOf = (label: string) => shapes.find((s) => s.id === texts.find((t) => t.text === label)?.container) as Stroke;
    const dice = shapeOf("Create dice shaker\nDiceRollerFactory");
    expect(dice.fill).toBe("#e1f5ee");
    expect(dice.color).toBe("#0f6e56");
    expect(texts.find((t) => t.text === "Create dice shaker\nDiceRollerFactory")?.color).toBe("#085041");
    expect(shapeOf("Logger ready\nPrints player + dice roll").fill).toBe("#eeedfe");
    const plain = shapeOf("Create player");
    expect(plain.color).toBe("#000000");
    expect(plain.fill).toBe("#ffffff");
  });

  it("draws subgraphs underneath what they hold, around it", () => {
    const boxes = shapes.filter((s) => texts.some((t) => !t.container && t.text === "Start up") && s.fill?.match(/^#(f3f3f3|e7e7e7)$/));
    expect(boxes).toHaveLength(3);
    const first = Math.max(...boxes.map((b) => strokes.indexOf(b)));
    const nodes = shapes.filter((s) => !boxes.includes(s));
    expect(Math.min(...nodes.map((n) => strokes.indexOf(n)))).toBeGreaterThan(first);
    const su = boxes.find((b) => strokePointBounds(b).h > 1000) as Stroke;
    const logger = shapes.find((s) => s.id === texts.find((t) => t.text.startsWith("Assign log"))?.container) as Stroke;
    expect(inside(strokePointBounds(logger), strokePointBounds(su))).toBe(true);
  });

  it("lays out without overlaps, and links run as smooth curves from outline to outline", () => {
    const nodes = shapes.filter((s) => s.fill === "#ffffff" || s.fill === "#e1f5ee" || s.fill === "#eeedfe");
    expect(nodes).toHaveLength(14);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(overlap(strokePointBounds(nodes[i]), strokePointBounds(nodes[j]))).toBe(false);
    const linkLabels = texts.filter((t) => !t.container && (t.text === "yes" || t.text === "no"));
    expect(linkLabels).toHaveLength(2);
    for (const a of arrows) {
      const pts = points(a);
      // no corners
      expect(sharpest(pts)).toBeLessThan(30);
      // not through other shapes, nor through the labels of links
      for (const n of nodes) if (n.id !== a.from && n.id !== a.to) expect(crosses(pts, strokePointBounds(n))).toBe(false);
      for (const t of linkLabels) expect(crosses(pts, t)).toBe(false);
      // the arrow comes straight in (from above, or into a side)
      const [p, q] = [pts[pts.length - 2], pts[pts.length - 1]];
      const [dx, dy] = [Math.abs(q.x - p.x), Math.abs(q.y - p.y)];
      expect(Math.min(dx, dy)).toBeLessThan(Math.max(dx, dy) * 0.2 + 0.11);
      // the ends are just outside their shapes, not inside them
      const from = shapes.find((s) => s.id === a.from) as Stroke;
      const to = shapes.find((s) => s.id === a.to) as Stroke;
      const end = pts[pts.length - 1];
      const start = pts[0];
      expect(pointInPolygon(end.x, end.y, closedOutline(to) as never)).toBe(false);
      expect(pointInPolygon(start.x, start.y, closedOutline(from) as never)).toBe(false);
      const tb = strokePointBounds(to);
      expect(end.x).toBeGreaterThan(tb.x - 6);
      expect(end.x).toBeLessThan(tb.x + tb.w + 6);
    }
  });

  it("keeps the main line straight: the loop back goes round the side", () => {
    const center = (label: string) => {
      const s = shapes.find((x) => x.id === texts.find((t) => t.container && t.text.startsWith(label))?.container) as Stroke;
      const b = strokePointBounds(s);
      return b.x + b.w / 2;
    };
    const xs = ["Create player", "Add to board", "Create logger", "Logger creation flow", "Pass player", "Assign log", "Logger ready", "More players?", "Start game"].map(center);
    for (const x of xs) expect(Math.abs(x - xs[0])).toBeLessThan(1);
    const target = (a: Stroke) => texts.find((t) => t.container === a.to)?.text;
    const yes = arrows.find((a) => target(a) === "Create player" && texts.find((t) => t.container === a.from)?.text === "More players?") as Stroke;
    const p = points(yes);
    // out of the diamond's side, round the side of what lies between, into the stadium's side
    const first = p[0];
    const last = p[p.length - 1];
    expect(Math.abs(p[1].y - first.y)).toBeLessThan(Math.abs(p[1].x - first.x) * 0.2);
    expect(Math.abs(last.y - p[p.length - 2].y)).toBeLessThan(Math.abs(last.x - p[p.length - 2].x) * 0.2);
    expect(last.y).toBeLessThan(first.y);
    // beside the logger creation flow, not through it
    const flow = strokePointBounds(shapes.find((s) => s.fill === "#e7e7e7") as Stroke);
    expect(Math.max(...p.map((x) => x.x))).toBeGreaterThan(flow.x + flow.w);
    expect(crosses(p, flow)).toBe(false);
    expect(sharpest(p)).toBeLessThan(30);
  });

  it("starts at (0, 0), can be copied, and its arrows follow their shapes", () => {
    const xs = [...strokes.flatMap((s) => points(s).map((p) => p.x)), ...texts.map((t) => t.x)];
    // the bounds include the width of the lines
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeLessThan(4);
    const copy = cloneItems(ink.items);
    const ids = new Set(copy.strokes.map((s) => s.id));
    for (const s of copy.strokes) {
      if (s.from) expect(ids.has(s.from)).toBe(true);
      if (s.to) expect(ids.has(s.to)).toBe(true);
    }
    for (const t of copy.texts) if (t.container) expect(ids.has(t.container)).toBe(true);
    // move one shape: its arrows are routed again to it
    const page = { ...paperPage(), strokes: copy.strokes, texts: copy.texts };
    const target = copy.strokes.find((s) => s.id === copy.texts.find((t) => t.text === "Start game\nGame(shaker, players)")?.container) as Stroke;
    const moved = transformItems({ strokes: [target], texts: [], images: [], links: [], figures: [] }, translation(300, 50)).strokes[0];
    const next = followMoves({ ...page, strokes: page.strokes.map((s) => (s.id === moved.id ? moved : s)) }, new Set([moved.id]));
    const arrow = next.strokes.find((s) => s.to === moved.id) as Stroke;
    // still a curve
    expect(arrow.curve).toBe(true);
    expect(points(arrow).length).toBeGreaterThan(4);
    expect(sharpest(points(arrow))).toBeLessThan(30);
    const end = points(arrow).pop() as { x: number; y: number };
    const b = strokePointBounds(moved);
    expect(end.x).toBeGreaterThan(b.x - 6);
    expect(end.x).toBeLessThan(b.x + b.w + 6);
    expect(end.y).toBeLessThan(b.y + b.h + 6);
  });

  it("draws other diagrams too: left to right, every shape, styles, links between subgraphs", () => {
    const lr = mermaidToItems(`graph LR
      A[Rectangle] --> B(Rounded) --> C([Stadium]) -.-> D[[Subroutine]] ==> E[(Database)] --> F((Circle))
      A --- G>Flag] --> H{Decision} -->|one| I{{Hexagon}}
      H -- two --> J[/Lean/] <--> K[\\Lean\\] --> N(((Double)))
      style A fill:#f9f,stroke:#333,stroke-width:4px
      linkStyle 3 stroke:#ff3,stroke-width:4px`);
    expect(lr.shapes).toBe(12);
    const a = lr.items.strokes.find((s) => s.fill === "#ff99ff") as Stroke;
    expect(a.color).toBe("#333333");
    expect(a.width).toBeGreaterThan(4);
    expect(lr.items.strokes.find((s) => s.color === "#ffff33")?.arrow).toBe(true);
    expect(lr.items.strokes.some((s) => s.arrow && s.arrowStart)).toBe(true);
    expect(lr.items.strokes.some((s) => s.dash && s.arrow)).toBe(true);
    // a cylinder and a subroutine have lines inside them
    expect(lr.items.strokes.filter((s) => !s.closed && !s.from && !s.to).length).toBeGreaterThanOrEqual(3);

    const clusters = mermaidToItems(`flowchart TB
      c1-->a2
      subgraph one
      a1-->a2
      end
      subgraph two
      b1-->b2
      end
      subgraph three
      c1-->c2
      end
      one --> two
      three --> two
      two --> c2`);
    expect(clusters.arrows).toBe(7);
    const shapesC = clusters.items.strokes.filter((s) => isConnectable(s));
    const titled = (t: string) => shapesC.find((s) => {
      const label = clusters.items.texts.find((x) => x.text === t && !x.container);
      if (!label) return false;
      const b = strokePointBounds(s);
      return label.x >= b.x && label.y >= b.y && label.x <= b.x + b.w && label.y <= b.y + b.h && s.fill === "#f3f3f3";
    });
    const two = titled("two") as Stroke;
    expect(clusters.items.strokes.filter((s) => s.from === two.id || s.to === two.id)).toHaveLength(3);
    // "two --> c2" comes into c2 from the side: it does not run through c1
    const c1 = shapesC.find((s) => s.id === clusters.items.texts.find((t) => t.text === "c1")?.container) as Stroke;
    const c2 = shapesC.find((s) => s.id === clusters.items.texts.find((t) => t.text === "c2")?.container) as Stroke;
    const into = clusters.items.strokes.find((s) => s.from === two.id && s.to === c2.id) as Stroke;
    const b1 = strokePointBounds(c1);
    const pts = points(into);
    for (let i = 1; i < pts.length; i++) {
      const seg = { x: Math.min(pts[i].x, pts[i - 1].x), y: Math.min(pts[i].y, pts[i - 1].y), w: Math.abs(pts[i].x - pts[i - 1].x) + 0.01, h: Math.abs(pts[i].y - pts[i - 1].y) + 0.01 };
      expect(overlap(seg, b1)).toBe(false);
    }
  });

  it("copes with small and odd diagrams", () => {
    const cases: Array<[string, number, number]> = [
      ["flowchart TD\n  A", 1, 0],
      ["graph LR", 0, 0],
      ["flowchart TD\n  subgraph X [Empty]\n  end", 0, 0],
      ["flowchart TD\n  A --> A", 1, 1],
      ["flowchart TD\n  subgraph S\n    A --> B\n  end\n  A --> S\n  S --> C", 3, 3],
      ["flowchart BT\n  A --> B --> C\n  C --> A", 3, 3],
      ["flowchart RL\n  A -- a label --> B\n  B --> C & D", 4, 3],
      ["flowchart TD\n  subgraph X\n    direction LR\n    a --> b --> c\n  end\n  subgraph Y\n    direction BT\n    d --> e\n  end", 5, 3],
      [`flowchart TD\n  A["${"a very long label that has to be wrapped onto more lines ".repeat(3)}"] --> B`, 2, 1],
    ];
    for (const [code, shapes, arrows] of cases) {
      const r = mermaidToItems(code);
      expect(r.shapes, code).toBe(shapes);
      expect(r.arrows, code).toBe(arrows);
      for (const st of r.items.strokes) for (const v of st.pts) expect(Number.isFinite(v), code).toBe(true);
      for (const t of r.items.texts) expect(Number.isFinite(t.x + t.y + t.w + t.h), code).toBe(true);
    }
    // a long label is wrapped, and its shape is made tall enough for it
    const long = mermaidToItems(cases[8][0]).items.texts.find((t) => t.text.startsWith("a very")) as { text: string; h: number };
    expect(long.text.split("\n").length).toBeGreaterThan(2);
    // a subgraph's own direction is kept when no link leaves it: a, b, c side by side
    const dirs = mermaidToItems(cases[7][0]).items;
    const ys = ["a", "b", "c"].map((n) => dirs.texts.find((t) => t.text === n)?.y as number);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
  });

  it("draws links with right angles or straight lines when the diagram says so", () => {
    const code = "flowchart TD\n  A --> B & C\n  B --> D\n  C --> D\n  D --> A";
    const corners = (r: ReturnType<typeof mermaidToItems>) => r.items.strokes.filter((s) => s.from).map((s) => points(s));
    const step = mermaidToItems(`---\nconfig:\n  flowchart:\n    curve: step\n---\n${code}`);
    for (const s of step.items.strokes.filter((x) => x.from)) {
      expect(s.elbow).toBe(true);
      expect(s.curve).toBeUndefined();
    }
    for (const pts of corners(step)) for (let i = 1; i < pts.length; i++) expect(Math.min(Math.abs(pts[i].x - pts[i - 1].x), Math.abs(pts[i].y - pts[i - 1].y))).toBeLessThan(0.11);
    const linear = mermaidToItems(`%%{init: {"flowchart": {"curve": "linear"}}}%%\n${code}`);
    for (const s of linear.items.strokes.filter((x) => x.from)) expect(s.elbow || s.curve).toBeFalsy();
    // B → D and C → D come in at a slant
    expect(corners(linear).some((pts) => pts.some((p, i) => i > 0 && Math.abs(p.x - pts[i - 1].x) > 1 && Math.abs(p.y - pts[i - 1].y) > 1))).toBe(true);
    // one link of its own
    const one = mermaidToItems(`${code}\n  linkStyle 0 interpolate step`);
    expect(one.items.strokes.filter((x) => x.from && x.curve)).toHaveLength(4);
  });

  it("gives links coming into one shape places of their own, in the order they come from", () => {
    const r = mermaidToItems("flowchart TD\n  A --> D\n  B --> D\n  C --> D");
    const label = (id: string) => r.items.texts.find((t) => t.text === id)?.container;
    const d = r.items.strokes.find((s) => s.id === label("D")) as Stroke;
    const ends = ["A", "B", "C"].map((n) => {
      const a = r.items.strokes.find((s) => s.from === label(n) && s.to === d.id) as Stroke;
      return points(a).pop() as { x: number; y: number };
    });
    expect(ends[0].x).toBeLessThan(ends[1].x - 10);
    expect(ends[1].x).toBeLessThan(ends[2].x - 10);
    const b = strokePointBounds(d);
    for (const e of ends) {
      expect(e.x).toBeGreaterThan(b.x);
      expect(e.x).toBeLessThan(b.x + b.w);
      expect(e.y).toBeLessThan(b.y);
    }
  });

  it("reads CSS colours", () => {
    expect(cssColor("#f9f")).toBe("#ff99ff");
    expect(cssColor("lightblue")).toBe("#add8e6");
    expect(cssColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(cssColor("rgba(0,0,0,0.5)")).toBe("#808080");
    expect(cssColor("none")).toBeNull();
    expect(cssColor("var(--x)")).toBeUndefined();
  });

  it("routes an edge out of a side when a box is in the way", () => {
    const style = { pen: "ballpoint" as const, color: "#000000", width: 2 };
    const a = shapeFromDrag("rect", { x: 0, y: 0 }, { x: 100, y: 40 }, style);
    const b = shapeFromDrag("rect", { x: 0, y: 200 }, { x: 100, y: 240 }, style);
    const route = { dir: "TB" as const, reversed: false, points: [], gaps: [120], label: null };
    expect(routeEdge(a, b, route).points).toHaveLength(2);
    const block = { x: 20, y: 130, w: 60, h: 40 };
    const p = routeEdge(a, b, route, [block]).points;
    expect(p.length).toBeGreaterThan(2);
    for (let i = 1; i < p.length; i++) {
      const seg = { x: Math.min(p[i].x, p[i - 1].x), y: Math.min(p[i].y, p[i - 1].y), w: Math.abs(p[i].x - p[i - 1].x) + 0.01, h: Math.abs(p[i].y - p[i - 1].y) + 0.01 };
      expect(overlap(seg, block)).toBe(false);
    }
  });
});

describe("arrow heads", () => {
  it("are drawn solid on dashed lines", () => {
    const s = { ...shapeFromDrag("arrow", { x: 0, y: 0 }, { x: 100, y: 0 }, { pen: "ballpoint", color: "#000000", width: 2 }), dash: true };
    const runs = strokeRuns(s);
    expect(runs[0].head).toBeUndefined();
    expect(runs.filter((r) => r.head)).toHaveLength(2);
  });
});
