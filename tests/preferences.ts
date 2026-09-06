import { expect } from "bun:test";
import type { Browser } from "playwright";
import type { DashboardFixture } from "./browser.test";
import { chooseOwner } from "./actions";
import { serveFixture, waitForSync } from "./sync";

export async function testPreferences(
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
  });
  try {
    const page = await context.newPage();
    await page.goto(fixture.url + "/?view=repositories");
    await waitForSync(page);
    const repoByName = new Map(
      dashboard.owner.repositories.map((repository) => [
        repository.name,
        repository,
      ]),
    );
    for (const key of [
      "name",
      "language",
      "stars",
      "issues",
      "prs",
      "activity",
    ] as const) {
      const button = page.locator(`button[data-sort="${key}"]`);
      const header = page.locator(`th:has(button[data-sort="${key}"])`);
      const directions = new Set<string | null>();
      for (let click = 0; click < 2; click++) {
        await button.click();
        const direction = await header.getAttribute("aria-sort");
        directions.add(direction);
        expect(["ascending", "descending"]).toContain(direction ?? "");
        const names = await page
          .locator("#repo-rows .repo-name")
          .allTextContents();
        const values = names.map((name) => {
          const repository = repoByName.get(name);
          if (!repository)
            throw new Error(`Unexpected fixture repository: ${name}`);
          switch (key) {
            case "name":
              return repository.name;
            case "language":
              return repository.primaryLanguage?.name ?? "";
            case "stars":
              return repository.stargazerCount;
            case "issues":
              return repository.issues.totalCount;
            case "prs":
              return repository.pullRequests.totalCount;
            case "activity":
              return new Date(
                repository.pushedAt || repository.updatedAt,
              ).getTime();
          }
        });
        // Missing languages are allowed at either edge; named languages must sort.
        const comparable =
          key === "language" ? values.filter((value) => value !== "") : values;
        const sign = direction === "ascending" ? 1 : -1;
        expect(
          comparable.every(
            (value, index) =>
              index === 0 ||
              sign *
                (typeof value === "number"
                  ? value - Number(comparable[index - 1])
                  : value.localeCompare(String(comparable[index - 1]), "en")) >=
                0,
          ),
          `${key} follows its announced ${direction} order`,
        ).toBe(true);
      }
      expect(directions).toEqual(new Set(["ascending", "descending"]));
      const beforeReload = await page
        .locator("#repo-rows .repo-name")
        .allTextContents();
      const announced = await header.getAttribute("aria-sort");
      await page.reload();
      await waitForSync(page);
      expect(await header.getAttribute("aria-sort")).toBe(announced);
      expect(
        await page.locator("#repo-rows .repo-name").allTextContents(),
      ).toEqual(beforeReload);
    }
    await page.locator("#repository-type").selectOption("forks");
    await page.locator("#language").selectOption("Rust");
    await page.locator("#search").fill("upstream");
    await page.locator("#archived").check();
    await page.reload();
    await waitForSync(page);
    expect(await page.locator("#repository-type").inputValue()).toBe("forks");
    expect(await page.locator("#language").inputValue()).toBe("Rust");
    expect(await page.locator("#search").inputValue()).toBe("upstream");
    expect(await page.locator("#archived").isChecked()).toBe(true);
    expect(await page.locator("#repo-rows tr").count()).toBe(1);
    await page.locator('.nav-item[data-view="prs"]').click();
    await page.locator("#work-search").fill("retry");
    await page.locator("#work-repository").selectOption("orbit");
    await page.locator("#work-assignee").selectOption("me");
    await page.locator("#work-status").selectOption("review");
    await page.locator("#work-sort").selectOption("oldest");
    await page.reload();
    await waitForSync(page);
    expect(new URL(page.url()).searchParams.get("view")).toBe("prs");
    expect(await page.locator("#work-search").inputValue()).toBe("retry");
    expect(await page.locator("#work-repository").inputValue()).toBe("orbit");
    expect(await page.locator("#work-assignee").inputValue()).toBe("me");
    expect(await page.locator("#work-status").inputValue()).toBe("review");
    expect(await page.locator("#work-sort").inputValue()).toBe("oldest");
    expect(await page.locator(".work-title").textContent()).toBe(
      "Add retry budget",
    );
    await page.locator('.nav-item[data-view="issues"]').click();
    expect(await page.locator("#work-search").inputValue()).toBe("");
    await page.locator('.nav-item[data-view="prs"]').click();
    expect(await page.locator("#work-search").inputValue()).toBe("retry");
    await chooseOwner(page, "example-team");
    await waitForSync(page);
    expect(await page.locator("#work-search").inputValue()).toBe("");
    await page.locator("#work-search").fill("map");
    await page.goto(fixture.url + "/");
    await waitForSync(page);
    expect(new URL(page.url()).searchParams.get("owner")).toBe("example-team");
    expect(new URL(page.url()).searchParams.get("view")).toBe("prs");
    expect(await page.locator("#work-search").inputValue()).toBe("map");
    await page.goto(fixture.url + "/?owner=studio&view=repositories");
    await waitForSync(page);
    expect(new URL(page.url()).searchParams.get("owner")).toBe("studio");
    expect(new URL(page.url()).searchParams.get("view")).toBe("repositories");
    expect(await page.locator("#repository-type").inputValue()).toBe("forks");
    expect(await page.locator("#search").inputValue()).toBe("upstream");
    expect(fixture.rejectedPaths).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}
