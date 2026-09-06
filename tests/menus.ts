import { expect } from "bun:test";
import type { Browser } from "playwright";
import type { DashboardFixture } from "./browser.test";
import { serveFixture, waitForSync } from "./sync";

import { chooseTheme, selectedTheme } from "./actions";

export async function testMenus(
  browser: Browser,
  upstream: string,
  dashboard: DashboardFixture,
) {
  const fixture = serveFixture(upstream, {
    ...dashboard,
    mode: "proxy",
    viewer: {
      ...dashboard.viewer,
      organizations: [
        { login: "example-team", name: "Example team", avatarUrl: "" },
      ],
    },
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(fixture.url);
    await waitForSync(page);
    const owner = page.locator("#owner-toggle");
    const profile = page.locator("#profile-toggle");
    await owner.focus();
    await page.keyboard.press("Enter");
    expect(await owner.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator("#owner-panel").isVisible()).toBe(true);
    await page.keyboard.press("Tab");
    const keyboardOwner = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-owner"),
    );
    expect(keyboardOwner).toBeTruthy();
    await page.keyboard.press("Enter");
    await waitForSync(page);
    expect(await owner.getAttribute("aria-expanded")).toBe("false");
    expect(
      await owner.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(
      await page
        .locator(`#owner-options button[data-owner="${keyboardOwner}"]`)
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await owner.click();
    await page.keyboard.press("Escape");
    expect(
      await owner.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(await owner.getAttribute("aria-expanded")).toBe("false");
    await profile.focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#profile-panel").isVisible()).toBe(true);
    expect(await page.locator("#logout").isVisible()).toBe(true);
    // The label's padding must activate the choice without closing the menu.
    for (const theme of ["dark", "light", "system"]) {
      const label = page.locator(
        `.theme-options label:has(input[value="${theme}"])`,
      );
      const box = await label.boundingBox();
      if (!box) throw new Error("Theme option is not visible");
      await label.click({ position: { x: box.width - 5, y: box.height - 5 } });
      expect(await selectedTheme(page)).toBe(theme);
      expect(await page.locator("#profile-panel").isVisible()).toBe(true);
    }
    for (const theme of ["dark", "light", "system"]) {
      const box = await page
        .locator(`.theme-options label:has(input[value="${theme}"])`)
        .boundingBox();
      if (!box) throw new Error("Theme option is not visible");
      await page.touchscreen.tap(box.x + box.width - 5, box.y + box.height - 5);
      expect(await selectedTheme(page)).toBe(theme);
      expect(await page.locator("#profile-panel").isVisible()).toBe(true);
    }
    const light = page.locator('input[name="theme"][value="light"]');
    await light.check();
    await light.focus();
    await page.keyboard.press("ArrowRight");
    expect(await selectedTheme(page)).toBe("dark");
    await page.keyboard.press("ArrowLeft");
    expect(await selectedTheme(page)).toBe("light");
    await page.keyboard.press("Escape");
    expect(
      await profile.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(await page.locator("#profile-panel").isVisible()).toBe(false);
    await profile.click();
    await page.locator("#search").click();
    expect(await page.locator("#profile-panel").isVisible()).toBe(false);
    expect(
      await page
        .locator("#search")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    for (const theme of ["light", "dark"]) {
      await chooseTheme(page, theme);
      for (const width of [360, 390, 900]) {
        await page.setViewportSize({ width, height: 844 });
        for (const [toggle, panel] of [
          [owner, "#owner-panel"],
          [profile, "#profile-panel"],
        ] as const) {
          await toggle.click();
          const box = await page.locator(panel).boundingBox();
          expect(
            box &&
              box.x >= 0 &&
              box.x + box.width <= width &&
              box.y >= 0 &&
              box.y + box.height <= 844,
            `${panel} fits ${width}px in ${theme} mode`,
          ).toBeTruthy();
          await page.keyboard.press("Escape");
          expect(
            await toggle.evaluate((node) => node === document.activeElement),
          ).toBe(true);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    }
    expect(fixture.rejectedPaths).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}
