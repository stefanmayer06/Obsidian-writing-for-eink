import { describe, expect, it } from "vitest";
import { BUILD_ID, buildOf, buildTime, compareBuilds } from "../src/core/build";

describe("which build of the plugin this is", () => {
  it("has a name only when built for release", () => {
    // tests run the sources: no build put a name in
    expect(BUILD_ID).toBe("dev");
  });

  it("reads a build's name out of main.js", () => {
    expect(buildOf('var a="ink-notebook-build:",b="ink-notebook-build:20261114-1840-0cb277b";')).toBe("20261114-1840-0cb277b");
    expect(buildOf("x='ink-notebook-build:20261114-1840-0cb277b+local'")).toBe("20261114-1840-0cb277b+local");
    // a plugin from before builds were named
    expect(buildOf("module.exports = class extends Plugin {}")).toBeNull();
  });

  it("sorts builds by their time", () => {
    expect(buildTime("20261114-1840-0cb277b")).toBe("20261114-1840");
    expect(buildTime("dev")).toBeNull();
    expect(compareBuilds("20261114-1840-0cb277b", "20261114-1840-0cb277b")).toBe("same");
    expect(compareBuilds("20261114-1655-bfdf08a", "20261114-1840-0cb277b")).toBe("older");
    expect(compareBuilds("20261115-0900-1234567", "20261114-1840-0cb277b")).toBe("newer");
    // another build of the same minute is not the same build
    expect(compareBuilds("20261114-1840-aaaaaaa", "20261114-1840-0cb277b")).toBe("older");
    expect(compareBuilds("dev", "20261114-1840-0cb277b")).toBe("unknown");
  });
});
