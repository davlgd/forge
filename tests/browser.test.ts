import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import fixture from "./demo.json";
import { testThemes } from "./theme";
import { testMenus } from "./menus";
import { testPreferences } from "./preferences";
import { testUsability } from "./usability";
import type { Dashboard, WorkItem } from "../static/types";
import {
  serveFixture,
  stopFixtures,
  testProgressiveSync,
  testRetainedRows,
  testCachedReplay,
  waitForSync,
  type SyncFrame,
} from "./sync";
import { testRepositoryScope, testWorkItems } from "./work-items";

const base = Bun.env.DASHBOARD_URL || "http://127.0.0.1:8080";
const data = {
  ...fixture,
  mode: "demo",
  fetchedAt: Date.now() / 1000,
};

export type DashboardFixture = Omit<typeof data, "viewer"> & {
  viewer: Dashboard["viewer"];
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(Bun.env.CHROMIUM_PATH ? { executablePath: Bun.env.CHROMIUM_PATH } : {}),
  });
});

afterEach(async () => {
  try {
    await Promise.all(
      browser?.contexts().map((context) => context.close()) ?? [],
    );
  } finally {
    stopFixtures();
  }
});

afterAll(async () => {
  await browser?.close();
});

test("repository filters, mobile layout and HTML escaping", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const fixtureServer = serveFixture(base, data);
  await page.goto(fixtureServer.url);
  await waitForSync(page);
  await page.locator("#dashboard").waitFor({ state: "visible" });
  expect(await page.locator("html").getAttribute("lang")).toMatch(/^en(?:-|$)/);
  expect(
    await page
      .locator('input[name="theme"]')
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value),
      ),
  ).toEqual(["system", "light", "dark"]);
  expect(await page.locator("#repo-rows tr").count()).toBe(10);
  expect(await page.locator("#notice").isVisible()).toBe(true);
  expect(
    await page.locator("#repo-rows a").count(),
    "demo links must not navigate to unrelated repos",
  ).toBe(0);
  await page.locator("#search").fill("tiny");
  expect(await page.locator("#repo-rows tr").count()).toBe(1);
  await page.locator("#search").fill("nothing-matches-this");
  expect(await page.locator("#empty").isVisible()).toBe(true);
  await page.locator("#search").fill("");
  await page.locator("#language").selectOption("Rust");
  expect(await page.locator("#repo-rows tr").count()).toBe(4);
  await page.locator("#language").selectOption("");
  await page.locator("#archived").check();
  expect(await page.locator("#repo-rows tr").count()).toBe(11);
  await page.locator("#archived").uncheck();
  await page.locator("#repository-type").selectOption("forks");
  expect(await page.locator("#repo-rows tr").count()).toBe(1);
  await page.locator("#repository-type").selectOption("all");
  await page.locator('.nav-item[data-view="popular"]').click();
  expect(
    await page.locator("#repo-rows tr:first-child .repo-name").textContent(),
  ).toBe("orbit");
  await page.locator('.nav-item[data-view="overview"]').click();
  await page.keyboard.press("/");
  expect(
    await page
      .locator("#search")
      .evaluate((node) => node === document.activeElement),
  ).toBe(true);
  await page.locator("#search").blur();
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile body must not overflow horizontally",
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(errors, "browser errors or CSP violations").toEqual([]);
  // Malicious descriptions must remain text, including attribute contexts.
  const evil = structuredClone(data);
  evil.owner.repositories[0]!.description =
    '<img src=x onerror="window.pwned=true">';
  fixtureServer.dashboard = evil;
  const escaped = page.waitForResponse((response) =>
    response.url().includes("/api/sync"),
  );
  await page.locator("#refresh").click();
  await (await escaped).finished();
  await waitForSync(page);
  expect(await page.locator("#repo-rows img").count()).toBe(0);
  expect(
    await page.evaluate(() => (window as Window & { pwned?: boolean }).pwned),
  ).toBe(undefined);
  expect(fixtureServer.rejectedPaths).toEqual([]);
  await page.close();
  fixtureServer.stop();
}, 120_000);

for (const [name, run] of [
  ["system, light and dark themes", testThemes],
  ["workspace and user menus", testMenus],
  ["saved preferences and repository sorting", testPreferences],
  ["keyboard navigation and responsive usability", testUsability],
  ["actionable issue and pull request inboxes", testWorkItems],
  ["repository-scoped conversation filters", testRepositoryScope],
  ["progressive synchronization and error recovery", testProgressiveSync],
  ["retained rows during refresh", testRetainedRows],
  ["cached replay and expiration", testCachedReplay],
] as const) {
  test(name, () => run(browser, base, data), 120_000);
}

test.skipIf(Bun.env.VERIFY_LIVE !== "1")(
  "live GitHub synchronization and conversation destinations",
  async () => {
    const live = await browser.newPage();
    const result = live.waitForResponse((response) =>
      response.url().includes("/api/sync"),
    );
    await live.goto(base);
    const response = await result;
    expect(response.status()).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SyncFrame);
    expect(events.some((event) => event.type === "complete")).toBe(true);
    const owner = events.find((event) => event.type === "context");
    if (!owner) throw new Error("Live sync did not identify its owner.");
    const repositories = events.flatMap((event) =>
      event.type === "repositories" ? event.repositories : [],
    );
    await waitForSync(live);
    expect(await live.locator("#repo-rows tr").count()).toBe(
      repositories.filter((repository) => !repository.isArchived).length,
    );
    expect(await live.locator("#owner-toggle").innerText()).toContain(
      owner.owner.login,
    );
    for (const kind of ["issues", "prs"] as const) {
      const items: WorkItem[] = events.flatMap((event) =>
        event.type === "work-items" && event.kind === kind ? event.items : [],
      );
      await live.locator(`.nav-item[data-view="${kind}"]`).click();
      expect(await live.locator("#work-list .work-item").count()).toBe(
        Math.min(50, items.length),
      );
      const urls = await live
        .locator("#work-list a.work-title")
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLAnchorElement).href),
        );
      expect(urls.every((url) => items.some((item) => item.url === url))).toBe(
        true,
      );
      console.log(
        `Live ${kind}: ${items.length} conversations with direct GitHub destinations.`,
      );
    }
    await live.close();
  },
  120_000,
);
