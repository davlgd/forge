import { expect } from "bun:test";
import type { Browser, Page } from "playwright";
import type { DashboardFixture } from "./browser.test";
import type { Repository, WorkItem, WorkKind } from "../static/types";
import { workFixtures } from "./fixtures";
import { chooseOwner } from "./actions";

type Owner = { login: string; avatarUrl: string };
export type SyncFrame =
  | {
      type: "context";
      viewer: DashboardFixture["viewer"];
      owner: Owner;
      mode: string;
      cacheTtlSeconds?: number;
      cacheAgeSeconds?: number;
      cached?: boolean;
    }
  | {
      type: "repositories";
      repositories: Repository[];
      total: number;
      owner: Owner;
    }
  | { type: "work-items"; kind: WorkKind; items: WorkItem[] }
  | { type: "section-complete"; section: "repositories" | WorkKind }
  | { type: "complete"; fetchedAt: number }
  | { type: "error"; message: string; status: number };

export interface FixtureStream {
  url: URL;
  aborted: boolean;
  send(frame: SyncFrame): void;
  sendRaw(text: string): void;
  close(): void;
}

export function sendSnapshot(
  stream: FixtureStream,
  dashboard: DashboardFixture,
  items = workFixtures,
  cache = { cacheTtlSeconds: 1800, cacheAgeSeconds: 0, cached: false },
  fetchedAt = Date.now() / 1000,
) {
  const owner = {
    login: stream.url.searchParams.get("owner") || dashboard.owner.login,
    avatarUrl: "",
  };
  stream.send({
    type: "context",
    viewer: dashboard.viewer,
    owner,
    mode: dashboard.mode,
    ...cache,
  });
  stream.send({
    type: "repositories",
    owner,
    total: dashboard.owner.repositories.length,
    repositories: dashboard.owner.repositories,
  });
  stream.send({ type: "section-complete", section: "repositories" });
  const kinds: WorkKind[] =
    stream.url.searchParams.get("priority") === "prs"
      ? ["prs", "issues"]
      : ["issues", "prs"];
  for (const kind of kinds) {
    stream.send({ type: "work-items", kind, items: items[kind] });
    stream.send({ type: "section-complete", section: kind });
  }
  stream.send({ type: "complete", fetchedAt });
  stream.close();
}

const runningFixtures = new Set<() => void>();

export function stopFixtures() {
  for (const stop of runningFixtures) stop();
}

// A local HTTP stream exercises incremental fetch reads; route.fulfill buffers bodies.
export function serveFixture(upstream: string, initial: DashboardFixture) {
  const fixture = {
    dashboard: initial,
    items: structuredClone(workFixtures),
    cache: { cacheTtlSeconds: 1800, cacheAgeSeconds: 0, cached: false },
    fetchedAt: undefined as number | undefined,
    requests: [] as FixtureStream[],
    rejectedPaths: [] as string[],
    handler: undefined as ((stream: FixtureStream) => void) | undefined,
    failure: null as { status: number; error: string } | null,
  };
  const allowed = new Set([
    "/",
    "/app.js",
    "/theme.js",
    "/app.css",
    "/favicon.svg",
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/sync") {
        if (fixture.failure) {
          return Response.json(
            { error: fixture.failure.error },
            { status: fixture.failure.status },
          );
        }
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let closed = false;
        const encoder = new TextEncoder();
        const stream: FixtureStream = {
          url,
          aborted: false,
          send(frame) {
            if (!closed)
              controller.enqueue(
                encoder.encode(
                  JSON.stringify(
                    frame.type === "context"
                      ? {
                          cacheTtlSeconds: 1800,
                          cacheAgeSeconds: 0,
                          cached: false,
                          ...frame,
                        }
                      : frame,
                  ) + "\n",
                ),
              );
          },
          sendRaw(text) {
            if (!closed) controller.enqueue(encoder.encode(text));
          },
          close() {
            if (!closed) {
              closed = true;
              controller.close();
            }
          },
        };
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel() {
            stream.aborted = true;
            closed = true;
          },
        });
        request.signal.addEventListener("abort", () => {
          stream.aborted = true;
          closed = true;
        });
        fixture.requests.push(stream);
        (
          fixture.handler ??
          ((value) =>
            sendSnapshot(
              value,
              fixture.dashboard,
              fixture.items,
              fixture.cache,
              fixture.fetchedAt,
            ))
        )(stream);
        return new Response(body, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-store",
          },
        });
      }
      if (!allowed.has(url.pathname)) {
        fixture.rejectedPaths.push(url.pathname);
        return new Response("Unexpected fixture request", { status: 404 });
      }
      // Never forward Origin, cookies, or authorization to the real static server.
      const response = await fetch(new URL(url.pathname, upstream));
      if (url.pathname !== "/") return response;
      const html = (await response.text()).replace(
        /data-auth-mode="[^"]*"/,
        `data-auth-mode="${fixture.dashboard.mode}"`,
      );
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(html, { status: response.status, headers });
    },
  });
  const stop = () => {
    server.stop(true);
    runningFixtures.delete(stop);
  };
  runningFixtures.add(stop);
  return Object.assign(fixture, {
    url: `http://127.0.0.1:${server.port}`,
    stop,
  });
}

async function waitForValue<T>(read: () => T, expected: T) {
  const deadline = Date.now() + 5_000;
  while (read() !== expected && Date.now() < deadline) await Bun.sleep(10);
  expect(read()).toBe(expected);
}

export async function waitForRows(page: Page, selector: string, count: number) {
  await page.waitForFunction(
    ({ selector, count }) =>
      document.querySelectorAll(selector).length === count,
    { selector, count },
  );
}

export async function waitForSync(page: Page) {
  await page.waitForFunction(() =>
    document
      .querySelector("#sync-message")
      ?.textContent?.startsWith("All sections up to date"),
  );
  expect(await page.locator("#sync-status").isVisible()).toBe(false);
}

export async function testProgressiveSync(
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
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-06T09:00:00Z") });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    fixture.handler = () => {};
    await page.goto(fixture.url + "/?view=prs");
    await page.waitForFunction(
      () =>
        document.querySelector("#sync-status")?.getAttribute("role") ===
        "status",
    );
    await waitForValue(() => fixture.requests.length, 1);
    const first = fixture.requests[0]!;
    expect(first.url.searchParams.get("priority")).toBe("prs");
    const owner = { login: "studio", avatarUrl: "" };
    first.send({
      type: "context",
      viewer: fixture.dashboard.viewer,
      owner,
      mode: "proxy",
    });
    first.send({
      type: "work-items",
      kind: "issues",
      items: workFixtures.issues.slice(0, 1),
    });
    await page.locator('.nav-item[data-view="issues"]').click();
    await waitForRows(page, "#work-list .work-item", 1);
    expect(
      await page.locator('#work-repository option[value="orbit"]').count(),
    ).toBe(1);
    await page.locator("#work-repository").selectOption("orbit");
    await waitForRows(page, "#work-list .work-item", 1);
    await page.locator("#work-repository").selectOption("");
    first.send({
      type: "repositories",
      owner,
      repositories: dashboard.owner.repositories.slice(0, 2),
      total: dashboard.owner.repositories.length,
    });
    await page.locator('.nav-item[data-view="repositories"]').click();
    await waitForRows(page, "#repo-rows tr", 2);
    const repositoryAction = page.locator(
      '#repo-rows [data-work-kind="issues"][data-repository="orbit"]',
    );
    await repositoryAction.focus();
    first.send({
      type: "repositories",
      owner,
      repositories: dashboard.owner.repositories.slice(2),
      total: dashboard.owner.repositories.length,
    });
    first.send({ type: "section-complete", section: "repositories" });
    await waitForRows(page, "#repo-rows tr", 10);
    await page.locator("#repo-loading").waitFor({ state: "hidden" });
    expect(
      await repositoryAction.evaluate(
        (node) => node === document.activeElement,
      ),
    ).toBe(true);
    await page.locator('.nav-item[data-view="issues"]').click();
    expect(await page.locator("#work-empty").isVisible()).toBe(false);
    await waitForRows(page, "#work-list .work-item", 1);
    expect(await page.locator(".work-title").textContent()).toBe(
      "Fix request timeout",
    );
    await page.locator("#work-search").fill("cache");
    await waitForRows(page, "#work-list .work-item", 0);
    expect(
      await page.locator("#work-empty").isVisible(),
      "a partial batch is not an empty inbox",
    ).toBe(false);
    expect(await page.locator("#work-count").textContent()).toContain(
      "0 matches · 1 received",
    );
    first.send({
      type: "work-items",
      kind: "issues",
      items: workFixtures.issues.slice(2),
    });
    await waitForRows(page, "#work-list .work-item", 1);
    expect(await page.locator(".work-title").textContent()).toBe(
      "Improve cache diagnostics",
    );
    expect(await page.locator("#work-search").inputValue()).toBe("cache");
    await page.locator(".work-title").focus();
    first.send({
      type: "work-items",
      kind: "issues",
      items: workFixtures.issues.slice(1, 2),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#work-count")
        ?.textContent?.includes("3 received"),
    );
    expect(
      await page
        .locator(".work-title")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    first.send({ type: "section-complete", section: "issues" });
    first.send({ type: "work-items", kind: "prs", items: workFixtures.prs });
    first.send({ type: "section-complete", section: "prs" });
    expect(await page.locator("#sync-status").isVisible()).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    expect(first.aborted).toBe(false);
    first.send({ type: "complete", fetchedAt: Date.now() / 1000 });
    first.close();
    await waitForSync(page);
    expect(await page.locator("#sync-time").textContent()).toMatch(
      /^Synced at /,
    );

    for (const view of [
      "overview",
      "repositories",
      "issues",
      "prs",
      "popular",
    ]) {
      await page.locator(`.nav-item[data-view="${view}"]`).click();
    }
    expect(
      fixture.requests,
      "all views reuse one completed owner snapshot",
    ).toHaveLength(1);
    await page.locator('.nav-item[data-view="prs"]').click();
    await page.locator("#work-search").fill("retry");
    await page.locator("#work-status").selectOption("review");
    await page.locator("#refresh").click();
    await waitForValue(() => fixture.requests.length, 2);
    const second = fixture.requests[1]!;
    expect(await page.locator(".work-title").textContent()).toBe(
      "Add retry budget",
    );
    expect(await page.locator("#sync-status").isVisible()).toBe(true);
    expect(await page.locator("#sync-time").textContent()).not.toMatch(
      /^Synced at /,
    );
    sendSnapshot(second, fixture.dashboard, fixture.items);
    await waitForSync(page);
    expect(await page.locator("#work-search").inputValue()).toBe("retry");
    expect(await page.locator("#work-status").inputValue()).toBe("review");
    expect(fixture.requests).toHaveLength(2);

    // Fresh backend snapshots remain reusable for thirty minutes.
    const freshnessStart = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(freshnessStart + 1_799_000);
    await page.locator('.nav-item[data-view="issues"]').click();
    expect(await page.locator("#work-search").inputValue()).toBe("cache");
    await page.locator("#work-search").fill("");
    expect(fixture.requests).toHaveLength(2);
    await page.clock.setSystemTime(freshnessStart + 1_801_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitForValue(() => fixture.requests.length, 3);
    const expired = fixture.requests[2]!;
    expect(await page.locator("#work-list .work-item").count()).toBe(3);
    expired.send({
      type: "context",
      viewer: fixture.dashboard.viewer,
      owner,
      mode: "proxy",
    });
    expired.send({
      type: "work-items",
      kind: "issues",
      items: workFixtures.issues.slice(0, 1),
    });
    await waitForRows(page, "#work-list .work-item", 3);
    await page
      .getByText("Not yet refreshed", { exact: true })
      .first()
      .waitFor({ state: "visible" });
    expired.send({
      type: "error",
      message: "GitHub interrupted this sync.",
      status: 502,
    });
    expired.close();
    await page.locator("#sync-retry").waitFor({ state: "visible" });
    expect(await page.locator("#sync-message").innerText()).toContain(
      "GitHub interrupted this sync.",
    );
    expect(await page.locator("#sync-time").textContent()).not.toMatch(
      /^Synced at /,
    );
    expect(await page.locator("#work-list .work-item").count()).toBe(3);
    expect(
      await page.getByText("Not yet refreshed", { exact: true }).count(),
    ).toBe(2);
    // Partial failure never becomes a warm cache; navigation retries immediately.
    await page.locator('.nav-item[data-view="popular"]').click();
    await waitForValue(() => fixture.requests.length, 4);
    fixture.requests[3]!.close();
    await page.locator("#sync-retry").waitFor({ state: "visible" });
    expect(await page.locator("#sync-message").innerText()).toContain(
      "interrupted",
    );
    expect(await page.locator("#sync-time").textContent()).not.toMatch(
      /^Synced at /,
    );
    await page.locator("#sync-retry").click();
    await waitForValue(() => fixture.requests.length, 5);
    const retry = fixture.requests[4]!;
    fixture.items.issues = fixture.items.issues.filter(
      (item) => item.number !== 41,
    );
    sendSnapshot(retry, fixture.dashboard, fixture.items);
    await waitForSync(page);
    await page.locator('.nav-item[data-view="issues"]').click();
    await waitForRows(page, "#work-list .work-item", 2);
    expect(await page.locator("#work-list").innerText()).not.toContain(
      "Fix request timeout",
    );
    await page.locator("#work-repository").selectOption("orbit");
    await waitForRows(page, "#work-list .work-item", 1);
    expect(await page.locator(".work-title").textContent()).toBe(
      "Improve cache diagnostics",
    );
    expect(fixture.requests).toHaveLength(5);

    // Changing owners cancels pending work and removes the previous owner's items.
    await page.locator("#refresh").click();
    await waitForValue(() => fixture.requests.length, 6);
    const oldOwner = fixture.requests[5]!;
    oldOwner.send({
      type: "context",
      viewer: fixture.dashboard.viewer,
      owner,
      mode: "proxy",
    });
    await chooseOwner(page, "example-team");
    await waitForValue(() => fixture.requests.length, 7);
    await waitForValue(() => oldOwner.aborted, true);
    expect(await page.locator("#work-list .work-item:visible").count()).toBe(0);
    const nextOwner = fixture.requests[6]!;
    expect(nextOwner.url.searchParams.get("owner")).toBe("example-team");
    nextOwner.send({
      type: "error",
      message: "The selected account is unavailable.",
      status: 404,
    });
    nextOwner.close();
    await page.locator("#sync-retry").waitFor({ state: "visible" });
    expect(await page.locator("#owner-toggle").isEnabled()).toBe(true);
    await chooseOwner(page, "studio");
    await waitForValue(() => fixture.requests.length, 8);
    const recoveredOwner = fixture.requests[7]!;
    sendSnapshot(recoveredOwner, fixture.dashboard, fixture.items);
    await waitForSync(page);
    await chooseOwner(page, "example-team");
    await waitForValue(() => fixture.requests.length, 9);
    const finalOwner = fixture.requests[8]!;
    const nextItems = structuredClone(fixture.items);
    nextItems.issues = [
      {
        ...workFixtures.issues[1]!,
        title: "New account issue",
        repository: { name: "atlas", nameWithOwner: "example-team/atlas" },
      },
    ];
    sendSnapshot(finalOwner, fixture.dashboard, nextItems);
    await waitForSync(page);
    await waitForRows(page, "#work-list .work-item", 1);
    expect(await page.locator(".work-title").textContent()).toBe(
      "New account issue",
    );
    expect(await page.locator("#work-repository").inputValue()).toBe("");
    expect(fixture.rejectedPaths).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}

export async function testRetainedRows(
  browser: Browser,
  upstream: string,
  dashboard: DashboardFixture,
) {
  const fixture = serveFixture(upstream, { ...dashboard, mode: "proxy" });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(fixture.url + "/?view=prs");
    await waitForSync(page);
    await waitForRows(page, "#work-list .work-item", 4);
    fixture.handler = () => {};
    await page.locator("#refresh").click();
    await waitForValue(() => fixture.requests.length, 2);
    const refreshing = fixture.requests[1]!;
    const owner = { login: "studio", avatarUrl: "" };
    refreshing.send({
      type: "context",
      viewer: dashboard.viewer,
      owner,
      mode: "proxy",
    });
    refreshing.send({
      type: "work-items",
      kind: "prs",
      items: workFixtures.prs.slice(0, 1),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#work-count")
        ?.textContent?.includes("1 received"),
    );
    expect(await page.locator("#work-list .work-item").count()).toBe(4);
    expect(
      await page.getByText("Not yet refreshed", { exact: true }).count(),
    ).toBe(3);
    refreshing.send({
      type: "error",
      message: "Remaining pull requests could not be checked.",
      status: 502,
    });
    refreshing.close();
    await page.locator("#sync-retry").waitFor({ state: "visible" });
    expect(await page.locator("#work-list .work-item").count()).toBe(4);
    expect(
      await page.getByText("Not yet refreshed", { exact: true }).count(),
    ).toBe(3);
    await page.locator("#sync-retry").click();
    await waitForValue(() => fixture.requests.length, 3);
    const retried = fixture.requests[2]!;
    retried.send({
      type: "context",
      viewer: dashboard.viewer,
      owner,
      mode: "proxy",
    });
    retried.send({
      type: "work-items",
      kind: "prs",
      items: workFixtures.prs.slice(0, 1),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#work-count")
        ?.textContent?.includes("1 received"),
    );
    expect(await page.locator("#work-list .work-item").count()).toBe(4);
    retried.send({ type: "section-complete", section: "prs" });
    await waitForRows(page, "#work-list .work-item", 1);
    expect(
      await page.getByText("Not yet refreshed", { exact: true }).count(),
    ).toBe(0);
    expect(await page.locator(".work-title").textContent()).toBe(
      "Add retry budget",
    );
    expect(await page.locator("#sync-progress").isVisible()).toBe(true);
    retried.send({
      type: "repositories",
      owner,
      total: dashboard.owner.repositories.length,
      repositories: dashboard.owner.repositories,
    });
    retried.send({ type: "section-complete", section: "repositories" });
    retried.send({
      type: "work-items",
      kind: "issues",
      items: workFixtures.issues,
    });
    retried.send({ type: "section-complete", section: "issues" });
    retried.send({ type: "complete", fetchedAt: Date.now() / 1000 });
    retried.close();
    await waitForSync(page);
    expect(await page.locator("#work-list .work-item").count()).toBe(1);
    expect(fixture.rejectedPaths).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}

export async function testCachedReplay(
  browser: Browser,
  upstream: string,
  dashboard: DashboardFixture,
) {
  const fixture = serveFixture(upstream, dashboard);
  fixture.cache = {
    cacheTtlSeconds: 1800,
    cacheAgeSeconds: 1790,
    cached: true,
  };
  fixture.fetchedAt = 1_788_684_000;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-09-06T09:00:00Z") });
    fixture.handler = () => {};
    await page.goto(fixture.url);
    await waitForValue(() => fixture.requests.length, 1);
    const replay = fixture.requests[0]!;
    const owner = { login: dashboard.owner.login, avatarUrl: "" };
    replay.send({
      type: "context",
      viewer: dashboard.viewer,
      owner,
      mode: dashboard.mode,
      ...fixture.cache,
    });
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const replayedAt = await page.evaluate(() => Date.now());
    // Receiving a cached replay takes six of its ten remaining valid seconds.
    await page.clock.setSystemTime(replayedAt + 6_000);
    replay.send({
      type: "repositories",
      owner,
      repositories: dashboard.owner.repositories,
      total: dashboard.owner.repositories.length,
    });
    replay.send({ type: "section-complete", section: "repositories" });
    for (const kind of ["issues", "prs"] as const) {
      replay.send({ type: "work-items", kind, items: fixture.items[kind] });
      replay.send({ type: "section-complete", section: kind });
    }
    replay.send({ type: "complete", fetchedAt: fixture.fetchedAt! });
    replay.close();
    await waitForSync(page);
    fixture.handler = undefined;
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]!.url.searchParams.get("refresh")).not.toBe(
      "true",
    );
    await page.clock.setSystemTime(replayedAt + 9_000);
    await page.locator('.nav-item[data-view="issues"]').click();
    expect(fixture.requests).toHaveLength(1);
    await page.clock.setSystemTime(replayedAt + 11_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitForValue(() => fixture.requests.length, 2);
    await waitForSync(page);
    const timestamp = await page.locator("#sync-time").textContent();
    await page.reload();
    await waitForSync(page);
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]!.url.searchParams.get("refresh")).not.toBe(
      "true",
    );
    expect(await page.locator("#sync-time").textContent()).toBe(timestamp);
    await page.locator("#refresh").click();
    await waitForValue(() => fixture.requests.length, 4);
    await waitForSync(page);
    expect(fixture.requests[3]!.url.searchParams.get("refresh")).toBe("true");
    expect(fixture.rejectedPaths).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}
