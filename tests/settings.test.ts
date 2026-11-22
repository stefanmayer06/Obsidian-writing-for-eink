import { describe, expect, it } from "vitest";
import { isOcrConfigured, loadSettings } from "../src/settings";

describe("recognition settings", () => {
  it("is configured with an Azure endpoint and key", () => {
    expect(isOcrConfigured(loadSettings({ azureEndpoint: "https://x.cognitiveservices.azure.com", azureKey: "k" }))).toBe(true);
    expect(isOcrConfigured(loadSettings({ azureEndpoint: "https://x.cognitiveservices.azure.com" }))).toBe(false);
    expect(isOcrConfigured(loadSettings({}))).toBe(false);
  });

  it("drops the settings of the removed Ink Notebook Cloud", () => {
    const s = loadSettings({ ocrProvider: "cloud", cloudLicenseKey: "INK_abc", cloudEndpoint: "https://x", azureEndpoint: "https://x.cognitiveservices.azure.com", azureKey: "k" });
    expect(s).not.toHaveProperty("ocrProvider");
    expect(s).not.toHaveProperty("cloudLicenseKey");
    expect(s).not.toHaveProperty("cloudEndpoint");
    expect(isOcrConfigured(s)).toBe(true);
  });

  it("marks uncertain words only when the user turned it on", () => {
    expect(loadSettings({}).highlightUncertain).toBe(false);
    // stored before version 2, when it was on by default
    expect(loadSettings({ highlightUncertain: true }).highlightUncertain).toBe(false);
    const turnedOn = loadSettings({ ...loadSettings({}), highlightUncertain: true });
    expect(turnedOn.highlightUncertain).toBe(true);
    expect(loadSettings(JSON.parse(JSON.stringify(turnedOn))).highlightUncertain).toBe(true);
  });

  it("asks for the name of a new page unless the user turned it off", () => {
    expect(loadSettings({}).askForPageName).toBe(true);
    // stored before version 4, when pages were named with the date and time by default
    expect(loadSettings({ askForPageName: false, settingsVersion: 3 }).askForPageName).toBe(true);
    const turnedOff = loadSettings({ ...loadSettings({}), askForPageName: false });
    expect(turnedOff.askForPageName).toBe(false);
    expect(loadSettings(JSON.parse(JSON.stringify(turnedOff))).askForPageName).toBe(false);
  });
});

describe("favourite pens", () => {
  it("has two by default and keeps the count between 2 and 8", () => {
    expect(loadSettings({}).favoritePens).toBe(2);
    expect(loadSettings({ favoritePens: 5 }).favoritePens).toBe(5);
    expect(loadSettings({ favoritePens: 1 }).favoritePens).toBe(2);
    expect(loadSettings({ favoritePens: 7 }).favoritePens).toBe(7);
    expect(loadSettings({ favoritePens: 12 }).favoritePens).toBe(8);
    expect(loadSettings({ favoritePens: 3.6 }).favoritePens).toBe(4);
    expect(loadSettings({ favoritePens: "4" }).favoritePens).toBe(2);
  });

  it("always has eight slots, keeping the two saved by earlier versions", () => {
    const saved = [
      { pen: "pencil", color: "#6a1b9a", width: 2 },
      { pen: "brush", color: "#2e7d32", width: 5 },
    ];
    const favs = loadSettings({ tools: { favorites: saved } }).tools.favorites;
    expect(favs).toHaveLength(8);
    expect(favs.slice(0, 2)).toEqual(saved);
    expect(favs[2]).toEqual({ pen: "ballpoint", color: "#1565c0", width: 1.5 });
  });

  it("keeps all eight once they are saved", () => {
    const eight = loadSettings({}).tools.favorites.map((f, i) => ({ ...f, width: 1 + i }));
    expect(loadSettings(JSON.parse(JSON.stringify({ tools: { favorites: eight } }))).tools.favorites).toEqual(eight);
  });
});
