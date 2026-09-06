import { expect } from "bun:test";
import type { Browser } from "playwright";
import type { DashboardFixture } from "./browser.test";
import { expectWorkCount } from "./work-items";
import { serveFixture, waitForSync } from "./sync";
import { chooseTheme } from "./actions";

export async function testUsability(
  browser: Browser,
  base: string,
  fixture: DashboardFixture,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const languages = [
      "JavaScript",
      "Rust",
      "V",
      "Shell",
      "C#",
      "TypeScript",
      "Other",
      "HTML",
      "Python",
      "Scala",
      "CSS",
      "Go",
      "Dart",
      "Ruby",
      "Astro",
      "Dockerfile",
      "C",
      "PHP",
      "Swift",
      "VCL",
    ];
    const languageRepositories = languages.map((name, index) => ({
      ...fixture.owner.repositories[0]!,
      name: `language-example-${index}`,
      nameWithOwner: `studio/language-example-${index}`,
      isFork: false,
      isArchived: false,
      stargazerCount: 0,
      forkCount: 0,
      issues: { totalCount: 0 },
      pullRequests: { totalCount: 0 },
      primaryLanguage: { name, color: "#6f50d8" },
    }));
    const data = {
      ...fixture,
      owner: {
        ...fixture.owner,
        repositories: [...fixture.owner.repositories, ...languageRepositories],
      },
      viewer: { ...fixture.viewer, name: "A moderately long display name" },
      mode: "proxy",
    };
    const fixtureServer = serveFixture(base, data);
    await page.goto(fixtureServer.url);
    await waitForSync(page);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const navigation = page
      .getByRole("navigation", { name: "Main navigation" })
      .locator(":scope > *");
    expect(
      await navigation.evaluateAll((nodes) =>
        nodes.map(
          (node) => node.getAttribute("data-view") || node.textContent?.trim(),
        ),
      ),
    ).toEqual([
      "overview",
      "popular",
      "KEEP TRACK",
      "repositories",
      "issues",
      "prs",
    ]);
    expect(
      await navigation.evaluateAll((nodes) =>
        nodes.every(
          (node, index) =>
            index === 0 ||
            node.getBoundingClientRect().top >
              nodes[index - 1]!.getBoundingClientRect().top,
        ),
      ),
    ).toBe(true);
    await page.locator("#repository-type").selectOption("forks");
    await page.locator('button[data-sort="name"]').click();
    await page.locator("#language").selectOption("Rust");
    await page.locator("#search").fill("upstream");
    await page.locator("#archived").check();
    const refreshed = page.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await page.locator("#refresh").click();
    await (await refreshed).finished();
    await waitForSync(page);
    expect(await page.locator("#repository-type").inputValue()).toBe("forks");
    expect(
      await page
        .locator('th:has(button[data-sort="name"])')
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(await page.locator("#language").inputValue()).toBe("Rust");
    expect(await page.locator("#search").inputValue()).toBe("upstream");
    expect(await page.locator("#archived").isChecked()).toBe(true);
    expect(await page.locator("#repo-rows tr").count()).toBe(1);
    await page.locator("#search").focus();
    expect(
      await page
        .locator("#repositories-section .search")
        .evaluate((node) => getComputedStyle(node).outlineWidth),
    ).not.toBe("0px");
    await page.locator("#search").fill("");
    await page.locator("#language").selectOption("");
    await page.locator("#repository-type").selectOption("all");
    await page.locator("#archived").uncheck();

    // The compact language summary can reveal every language without overflowing.
    const totalLanguages = await page.locator("#language-legend .lang").count();
    expect(totalLanguages).toBe(21);
    expect(
      await page.locator("#language-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
    expect(await page.locator("#language-legend .lang:visible").count()).toBe(
      6,
    );
    await page.locator("#language-toggle").click();
    expect(
      await page.locator("#language-toggle").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(await page.locator("#language-legend .lang:visible").count()).toBe(
      totalLanguages,
    );
    for (const width of [360, 390, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 390)
        await page.screenshot({
          path: "test-results/languages-expanded-mobile.png",
          fullPage: true,
        });
      for (const language of await page
        .locator("#language-legend .lang:visible")
        .all()) {
        const box = await language.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width).toBeTruthy();
      }
    }
    await page.locator("#language-toggle").click();
    expect(await page.locator("#language-legend .lang:visible").count()).toBe(
      6,
    );

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.nav-item[data-view="issues"]').click();
    await expectWorkCount(page, 3);
    for (const row of await page.locator(".work-item").all()) {
      const rowBox = await row.boundingBox();
      const metadata = await row.locator(".work-meta").boundingBox();
      const details = await row.locator(".work-details").boundingBox();
      expect(
        rowBox && rowBox.height <= 90,
        "typical desktop conversations remain compact",
      ).toBeTruthy();
      expect(
        metadata && details && metadata.x + metadata.width <= details.x + 1,
        "metadata is left of labels and assignees on wide screens",
      ).toBeTruthy();
    }
    expect(
      await page
        .locator("#page-title")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(await page.locator(".stats").isVisible()).toBe(false);
    for (const theme of ["light", "dark"]) {
      await chooseTheme(page, theme);
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "no page overflow",
        ).toBe(true);
        for (const selector of [
          '.nav-item[data-view="prs"]',
          "#profile-toggle",
          "#work-search",
          "#work-repository",
          "#work-assignee",
          "#work-sort",
          ".work-title",
        ]) {
          const box = await page.locator(selector).first().boundingBox();
          expect(
            box && box.x >= 0 && box.x + box.width <= width,
            selector + " reachable on mobile",
          ).toBeTruthy();
        }
        expect(await page.locator(".work-item").first().innerText()).toContain(
          "orbit",
        );
        expect(
          await page.locator(".work-title").first().getAttribute("href"),
        ).toBe("https://github.com/studio/orbit/issues/41");
        await page.screenshot({
          path: `test-results/triage-${theme}-${width}.png`,
          fullPage: true,
        });
      }
    }
    await page.locator('.nav-item[data-view="prs"]').click();
    await expectWorkCount(page, 4);
    expect(await page.locator(".work-title").first().getAttribute("href")).toBe(
      "https://github.com/studio/orbit/pull/54",
    );
    await page.screenshot({
      path: "test-results/pull-requests-dark-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.nav-item[data-view="popular"]').click();
    expect(
      (await page.locator("th:visible").allTextContents()).map((label) =>
        label.trim(),
      ),
    ).toEqual(["Repository", "Stars"]);
    expect(
      (
        await page
          .locator("#repo-rows tr:first-child td:nth-child(3)")
          .textContent()
      )?.replace(/\D/g, ""),
    ).toBe("1284");
    await page.screenshot({
      path: "test-results/popular-dark-mobile.png",
      fullPage: true,
    });
    const longTitle =
      "Investigate synchronization for " + "long_identifier_".repeat(20);
    fixtureServer.items.issues[0]!.title = longTitle;
    fixtureServer.items.issues[0]!.labels = [
      { name: "category_".repeat(25), color: "6f50d8" },
    ];
    await page.locator('.nav-item[data-view="issues"]').click();
    const longItems = page.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await page.locator("#refresh").click();
    await (await longItems).finished();
    await waitForSync(page);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await page
          .locator(".work-item")
          .first()
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      expect(await page.locator(".work-title").first().textContent()).toBe(
        longTitle,
      );
    }
    await page.screenshot({
      path: "test-results/long-conversation-mobile.png",
      fullPage: true,
    });
    expect(fixtureServer.rejectedPaths).toEqual([]);
    expect(errors).toEqual([]);
    fixtureServer.stop();
  } finally {
    await context.close();
  }
}
