import { expect } from "bun:test";

import type { Browser, BrowserContext, Page } from "playwright";
import type { DashboardFixture } from "./browser.test";
import { serveFixture, waitForSync } from "./sync";
import { chooseTheme, selectedTheme } from "./actions";

export async function testThemes(
  browser: Browser,
  base: string,
  data: DashboardFixture,
) {
  const fixtureServer = serveFixture(base, data);
  async function pageFor(context: BrowserContext) {
    const page = await context.newPage();
    await page.goto(fixtureServer.url);
    await waitForSync(page);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    return page;
  }

  async function expectTheme(page: Page, theme: "light" | "dark") {
    const background =
      theme === "dark" ? "rgb(16, 18, 27)" : "rgb(248, 249, 252)";
    await page.waitForFunction(
      (expected) =>
        getComputedStyle(document.documentElement).backgroundColor === expected,
      background,
    );
    await page.waitForFunction(
      (expected) =>
        document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content === expected,
      theme === "dark" ? "#10121b" : "#f8f9fc",
    );
  }

  const context = await browser.newContext({
    colorScheme: "light",
    viewport: { width: 1440, height: 1100 },
  });
  try {
    const page = await pageFor(context);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    expect(await selectedTheme(page)).toBe("system");
    await expectTheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme(page, "dark");
    await page.screenshot({
      path: "test-results/dark-desktop.png",
      fullPage: true,
    });

    // An explicit choice survives reload and ignores subsequent system changes.
    await chooseTheme(page, "light");
    await expectTheme(page, "light");
    await page.reload();
    await expectTheme(page, "light");
    expect(await selectedTheme(page)).toBe("light");
    await chooseTheme(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, "dark");

    const other = await pageFor(context);
    await expectTheme(other, "dark");
    await chooseTheme(other, "system");
    await expectTheme(page, "light");
    await expectTheme(other, "light");
    await other.evaluate(() => localStorage.setItem("forge.theme", "invalid"));
    expect(await selectedTheme(page)).toBe("system");
    await page.reload();
    await expectTheme(page, "light");

    // Small text must remain readable on both palettes, including active badges.
    for (const theme of ["light", "dark"]) {
      await chooseTheme(page, theme);
      await page.locator("#dashboard").waitFor({ state: "visible" });
      const contrast = await page.evaluate(() => {
        function rgb(value: string) {
          return (value.match(/[\d.]+/g) ?? []).map(Number);
        }
        function luminance(values: number[]) {
          return values
            .slice(0, 3)
            .map((v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        }
        return [
          ".repo-description",
          ".stat-note",
          ".nav-item.active",
          ".numeric-link.issue-active",
          ".numeric-link.pr-active",
          "#profile-toggle",
        ].map((selector) => {
          const node = document.querySelector<HTMLElement>(selector);
          if (!node) throw new Error(`Missing contrast sample: ${selector}`);
          let parent: HTMLElement | null = node;
          let background;
          do {
            background = rgb(getComputedStyle(parent!).backgroundColor);
            parent = parent!.parentElement;
          } while (background[3] === 0 && parent);
          const fg = luminance(rgb(getComputedStyle(node).color));
          const bg = luminance(background);
          return {
            selector,
            ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
          };
        });
      });
      for (const sample of contrast)
        expect(
          sample.ratio >= 4.5,
          `${theme} ${sample.selector}: ${sample.ratio.toFixed(2)} contrast`,
        ).toBeTruthy();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("#profile-toggle").isVisible()).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/dark-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  const blocked = await browser.newContext({ colorScheme: "dark" });
  try {
    await blocked.addInitScript(() => {
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        Storage.prototype[method] = () => {
          throw new DOMException("Blocked", "SecurityError");
        };
      }
    });
    const page = await pageFor(blocked);
    await expectTheme(page, "dark");
    await chooseTheme(page, "light");
    await expectTheme(page, "light");
    await page.reload();
    await expectTheme(page, "dark");
  } finally {
    await blocked.close();
  }
  fixtureServer.stop();
  console.log(
    "Theme checks passed: system changes, overrides, persistence, cross-tab, blocked storage, contrast, mobile.",
  );
}
