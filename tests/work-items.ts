import { expect } from "bun:test";
import type { Browser, Page } from "playwright";
import type { DashboardFixture } from "./browser.test";
import { workFixtures } from "./fixtures";
import { serveFixture, waitForRows, waitForSync } from "./sync";

export async function expectWorkCount(page: Page, count: number) {
  await waitForRows(page, "#work-list .work-item", count);
}

export async function testWorkItems(
  browser: Browser,
  upstream: string,
  dashboard: DashboardFixture,
) {
  const fixture = serveFixture(upstream, { ...dashboard, mode: "proxy" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.url + "/?view=issues");
    await waitForSync(page);
    await expectWorkCount(page, 3);
    expect(await page.locator("#repositories-section").isVisible()).toBe(false);
    expect(await page.locator("#work-section").isVisible()).toBe(true);
    expect(await page.locator("#work-summary").getAttribute("role")).toBe(
      "status",
    );
    expect(await page.locator("#work-status").isVisible()).toBe(false);
    await page.keyboard.press("/");
    expect(
      await page
        .locator("#work-search")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.locator("#work-search").blur();
    expect(await page.locator(".work-title").first().getAttribute("href")).toBe(
      workFixtures.issues[0]!.url,
    );
    expect(await page.locator(".work-item").first().innerText()).toContain(
      "bug",
    );
    for (const query of ["timeout", "#41", "atlas", "lee", "documentation"]) {
      await page.locator("#work-search").fill(query);
      await expectWorkCount(page, 1);
      expect(
        (await page.locator("#work-count").textContent())?.startsWith("1 "),
      ).toBe(true);
    }
    await page.locator("#work-search").fill("nothing-matches");
    await page.locator("#work-empty").waitFor({ state: "visible" });
    const filteredEmpty = await page.locator("#work-empty").innerText();
    await page.locator("#work-reset").click();
    await expectWorkCount(page, 3);
    await page.locator("#work-repository").selectOption("orbit");
    await expectWorkCount(page, 2);
    await page.locator("#work-assignee").selectOption("me");
    await expectWorkCount(page, 1);
    await page.locator("#work-search").fill("timeout");
    await page.locator("#work-sort").selectOption("oldest");
    expect(fixture.requests).toHaveLength(1);
    const refreshed = page.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await page.locator("#refresh").click();
    await (await refreshed).finished();
    await waitForSync(page);
    await expectWorkCount(page, 1);
    expect(await page.locator("#work-search").inputValue()).toBe("timeout");
    expect(await page.locator("#work-repository").inputValue()).toBe("orbit");
    expect(await page.locator("#work-assignee").inputValue()).toBe("me");
    expect(await page.locator("#work-sort").inputValue()).toBe("oldest");
    expect(fixture.requests).toHaveLength(2);
    await page.locator("#work-search").fill("");
    await page.locator("#work-assignee").selectOption("all");
    await page.locator("#work-repository").selectOption("");
    await expectWorkCount(page, 3);
    expect(await page.locator(".work-title").first().textContent()).toBe(
      "Document map keyboard controls",
    );
    await page.locator("#work-sort").selectOption("created");
    expect(await page.locator(".work-title").first().textContent()).toBe(
      "Fix request timeout",
    );
    await page.locator("#work-assignee").selectOption("unassigned");
    await expectWorkCount(page, 1);
    expect(await page.locator(".work-title").textContent()).toBe(
      "Document map keyboard controls",
    );

    await page.locator('.nav-item[data-view="prs"]').click();
    await expectWorkCount(page, 4);
    expect(await page.locator("#work-status").isVisible()).toBe(true);
    for (const [status, title] of [
      ["review", "Add retry budget"],
      ["changes", "Correct map focus order"],
      ["approved", "Speed up cache reads"],
      ["draft", "Prototype offline maps"],
    ] as const) {
      await page.locator("#work-status").selectOption(status);
      await expectWorkCount(page, 1);
      expect(await page.locator(".work-title").textContent()).toBe(title);
      expect(await page.locator(".work-title").getAttribute("href")).toMatch(
        /\/pull\/\d+$/,
      );
    }
    await page.locator("#work-status").selectOption("all");
    await expectWorkCount(page, 4);
    expect(fixture.requests).toHaveLength(2);

    fixture.items.prs = [];
    const emptied = page.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await page.locator("#refresh").click();
    await (await emptied).finished();
    await waitForSync(page);
    await page.locator("#work-empty").waitFor({ state: "visible" });
    expect(await page.locator("#work-empty").innerText()).not.toBe(
      filteredEmpty,
    );
    fixture.items = structuredClone(workFixtures);

    await page.locator('.nav-item[data-view="overview"]').click();
    await page
      .locator('[data-work-kind="issues"][data-repository="orbit"]')
      .first()
      .click();
    await expectWorkCount(page, 2);
    expect(await page.locator("#work-repository").inputValue()).toBe("orbit");
    await page.screenshot({
      path: "test-results/work-items-desktop.png",
      fullPage: true,
    });
    fixture.items.issues[0]!.title = '<img src=x onerror="window.pwned=true">';
    fixture.items.issues[0]!.labels = [
      {
        name: '<svg onload="window.pwned=true">',
        color: 'bad" onclick="window.pwned=true',
      },
    ];
    const escaped = page.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await page.locator("#refresh").click();
    await (await escaped).finished();
    await waitForSync(page);
    await expectWorkCount(page, 2);
    expect(
      await page
        .locator("#work-list img, #work-list svg[onload], #work-list [onclick]")
        .count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => (window as Window & { pwned?: boolean }).pwned),
    ).toBeUndefined();
    expect(await page.locator("#work-list").innerText()).toContain(
      '<img src=x onerror="window.pwned=true">',
    );

    fixture.dashboard = { ...dashboard, mode: "demo" };
    await page.reload();
    await waitForSync(page);
    await expectWorkCount(page, 2);
    expect(await page.locator("#work-repository").inputValue()).toBe("orbit");
    expect(await page.locator("#work-list a.work-title").count()).toBe(0);
    await page.locator('.nav-item[data-view="overview"]').click();
    await page
      .locator('[data-work-kind="prs"][data-repository="orbit"]')
      .first()
      .click();
    await expectWorkCount(page, 2);
    expect(await page.locator("#work-repository").inputValue()).toBe("orbit");
    expect(await page.locator("#work-list a.work-title").count()).toBe(0);
    expect(fixture.rejectedPaths).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}

export async function testRepositoryScope(
  browser: Browser,
  upstream: string,
  dashboard: DashboardFixture,
) {
  const fixture = serveFixture(upstream, { ...dashboard, mode: "proxy" });
  fixture.items.issues = workFixtures.issues.slice(0, 2);
  fixture.items.prs = workFixtures.prs.slice(0, 1);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(fixture.url + "/?view=issues");
    await waitForSync(page);
    expect(
      await page
        .locator("#work-repository option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        ),
    ).toEqual(["", "atlas", "orbit"]);
    await page.locator('.nav-item[data-view="prs"]').click();
    await expectWorkCount(page, 1);
    expect(
      await page
        .locator("#work-repository option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        ),
    ).toEqual(["", "orbit"]);
    await page.locator('.nav-item[data-view="issues"]').click();
    await page.locator("#work-repository").selectOption("atlas");
    await expectWorkCount(page, 1);
    fixture.items.issues = workFixtures.issues.slice(0, 1);
    const closed = page.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await page.locator("#refresh").click();
    await (await closed).finished();
    await waitForSync(page);
    await page.locator("#work-empty").waitFor({ state: "visible" });
    expect(await page.locator("#work-repository").inputValue()).toBe("atlas");
    expect(await page.locator("#work-list .work-item").count()).toBe(0);
    expect(await page.locator("#work-empty").innerText()).toContain(
      "No matching",
    );
    await page.locator("#work-reset").click();
    await expectWorkCount(page, 1);
    expect(await page.locator("#work-repository").inputValue()).toBe("");
    expect(fixture.requests).toHaveLength(2);
  } finally {
    await context.close();
    fixture.stop();
  }
}
