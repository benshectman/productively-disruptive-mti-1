import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixCss = readFileSync(new URL("../src/contrast-fix.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("inverse-surface contrast regression", () => {
  it.each([".deep-title", ".generating", ".purpose-transition"])(
    "%s forces Astryx typography to inherit its foreground color",
    (surface) => {
      expect(fixCss).toContain(surface);
      expect(fixCss).toMatch(/:where\(h1, h2, h3, h4, h5, h6, p, small, a, button, summary\)/);
      expect(fixCss).toContain("color: inherit");
      expect(appCss).toContain(`${surface}{`);
    }
  );

  it("the approved paper-on-ink pair exceeds WCAG AA for normal text", () => {
    expect(contrast("#f2f0e9", "#171714")).toBeGreaterThanOrEqual(4.5);
  });
});
