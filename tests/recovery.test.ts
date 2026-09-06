import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import fixture from "./demo.json";
import { serveFixture, stopFixtures, waitForSync } from "./sync";

const base = Bun.env.DASHBOARD_URL || "http://127.0.0.1:8080";
const data = { ...fixture, mode: "gh", fetchedAt: Date.now() / 1000 };
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

for (const mode of ["gh", "proxy"] as const) {
  for (const expired of [false, true]) {
    test(`${mode} authentication recovery ${expired ? "after a successful sync" : "before the first context"}`, async () => {
      const server = serveFixture(base, { ...data, mode });
      const page = await browser.newPage();
      const failure = {
        status: 401,
        error:
          mode === "gh"
            ? "GitHub CLI authentication is missing or expired. Run gh auth login, then retry."
            : "GitHub authentication expired or missing. Reconnect with GitHub.",
      };
      if (!expired) server.failure = failure;
      await page.goto(server.url);
      if (expired) {
        await waitForSync(page);
        server.failure = failure;
        await page.locator('.nav-item[data-view="issues"]').click();
        await page.locator("#refresh").click();
      }
      await page
        .locator(expired ? "#sync-status.sync-error" : "#error")
        .waitFor({ state: "visible" });
      if (mode === "gh") {
        for (const selector of ["#login", "#sync-login", "#work-login"]) {
          expect(await page.locator(selector).isVisible(), selector).toBe(
            false,
          );
        }
        expect(
          await page
            .locator(expired ? "#sync-message" : "#error-message")
            .innerText(),
        ).toContain("gh auth login");
        if (expired)
          expect(
            await page.locator("#work-error-message").innerText(),
          ).toContain("gh auth login");
      } else {
        expect(
          await page.locator(expired ? "#sync-login" : "#login").isVisible(),
        ).toBe(true);
        if (expired)
          expect(await page.locator("#work-login").isVisible()).toBe(true);
      }
    }, 30_000);
  }
}

test("large streamed snapshots do not exhaust the browser history update budget", async () => {
  const server = serveFixture(base, data);
  const repositories = Array.from({ length: 150 }, (_, index) => ({
    ...data.owner.repositories[0]!,
    name: `streamed-${index}`,
    nameWithOwner: `studio/streamed-${index}`,
    isArchived: false,
  }));
  server.handler = (stream) => {
    const owner = { login: data.owner.login, avatarUrl: "" };
    stream.send({ type: "context", viewer: data.viewer, owner, mode: "gh" });
    for (const repository of repositories) {
      stream.send({
        type: "repositories",
        owner,
        repositories: [repository],
        total: repositories.length,
      });
    }
    for (const section of ["repositories", "issues", "prs"] as const) {
      stream.send({ type: "section-complete", section });
    }
    stream.send({ type: "complete", fetchedAt: Date.now() / 1000 });
    stream.close();
  };
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = history.replaceState.bind(history);
    let calls = 0;
    Reflect.set(window, "historyReplaceCalls", calls);
    history.replaceState = (...args) => {
      Reflect.set(window, "historyReplaceCalls", ++calls);
      if (calls > 100) {
        throw new DOMException("Too many history updates", "SecurityError");
      }
      original(...args);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await waitForSync(page);
  expect(await page.locator("#repo-rows tr").count()).toBe(150);
  expect(
    await page.evaluate(() => Reflect.get(window, "historyReplaceCalls")),
  ).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
}, 30_000);

test("a truncated JSON tail reports an interrupted sync and retains provisional rows", async () => {
  const server = serveFixture(base, data);
  server.handler = (stream) => {
    const owner = { login: data.owner.login, avatarUrl: "" };
    stream.send({ type: "context", viewer: data.viewer, owner, mode: "gh" });
    stream.send({
      type: "repositories",
      owner,
      repositories: [data.owner.repositories[0]!],
      total: 2,
    });
    stream.sendRaw('{"type":"section-complete","sect');
    stream.close();
  };
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.locator("#sync-status.sync-error").waitFor({ state: "visible" });
  const message = await page.locator("#sync-message").innerText();
  expect(message).toContain(
    "Synchronization was interrupted before every section finished. Try again.",
  );
  expect(message).not.toMatch(/SyntaxError|JSON|Unexpected/);
  expect(await page.locator("#repo-rows tr").count()).toBe(1);
}, 30_000);
