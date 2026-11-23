import { hexToHsv, hsvToHex, type Hsv } from "../../core/color";
import { normalizeColor } from "../../core/palette";
import { button, el, type IconFn } from "./popover";

/**
 * A colour picker of the plugin's own, inside a card: a square for saturation
 * and brightness, a hue slider, the colour code and a preview. The system's
 * picker (<input type="color">) is not used: Obsidian on Android has none.
 * Pen, finger and mouse all drag the handles.
 */

export interface ColorPickerOptions {
  icon: IconFn;
  /** The colour it starts at. */
  initial: string;
  /** Label of the button that takes the colour. */
  okLabel: string;
  onPick(color: string): void;
  onCancel(): void;
}

export function colorPicker(parent: HTMLElement, o: ColorPickerOptions): void {
  let hsv: Hsv = hexToHsv(o.initial) ?? { h: 210, s: 0.7, v: 0.8 };
  const root = el(parent, "div", "ink-colorpicker");

  const sv = el(root, "div", "ink-cp-sv");
  sv.setAttribute("role", "slider");
  sv.setAttribute("aria-label", "Saturation and brightness");
  const svThumb = el(sv, "div", "ink-cp-thumb");

  const hue = el(root, "div", "ink-cp-hue");
  hue.setAttribute("role", "slider");
  hue.setAttribute("aria-label", "Hue");
  const hueThumb = el(hue, "div", "ink-cp-thumb");

  const row = el(root, "div", "ink-cp-row");
  const preview = el(row, "div", "ink-cp-preview");
  const code = el(row, "input", "ink-cp-code");
  code.type = "text";
  code.spellcheck = false;
  code.maxLength = 7;
  code.setAttribute("aria-label", "Colour code");

  const buttons = el(root, "div", "ink-pop-row");
  button(buttons, o.icon, { label: "Cancel", showLabel: true, cls: "ink-pop-wide", onClick: () => o.onCancel() });
  button(buttons, o.icon, { icon: "plus", label: o.okLabel, showLabel: true, cls: "ink-pop-wide ink-cp-ok", onClick: () => o.onPick(hsvToHex(hsv)) });

  const show = (fromCode = false) => {
    const color = hsvToHex(hsv);
    sv.style.setProperty("--cp-hue", hsvToHex({ h: hsv.h, s: 1, v: 1 }));
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    svThumb.style.background = color;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    hueThumb.style.background = hsvToHex({ h: hsv.h, s: 1, v: 1 });
    preview.style.background = color;
    if (!fromCode) code.value = color;
  };

  drag(sv, (fx, fy) => {
    hsv = { ...hsv, s: fx, v: 1 - fy };
    show();
  });
  drag(hue, (fx) => {
    hsv = { ...hsv, h: Math.min(359.9, fx * 360) };
    show();
  });
  code.addEventListener("input", () => {
    const c = normalizeColor(code.value.startsWith("#") ? code.value : `#${code.value}`);
    const next = c ? hexToHsv(c) : null;
    if (next) {
      hsv = next;
      show(true);
    }
  });
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter") o.onPick(hsvToHex(hsv));
  });
  show();
}

/** Follow a press on an area: `fn` gets the position as fractions (0–1) of its size. */
function drag(area: HTMLElement, fn: (fx: number, fy: number) => void): void {
  let pointer = -1;
  const at = (e: PointerEvent) => {
    const r = area.getBoundingClientRect();
    fn(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  area.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pointer = e.pointerId;
    try {
      area.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    at(e);
  });
  area.addEventListener("pointermove", (e) => {
    if (e.pointerId === pointer) at(e);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId === pointer) pointer = -1;
  };
  area.addEventListener("pointerup", end);
  area.addEventListener("pointercancel", end);
}
