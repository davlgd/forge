import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SyncEvent } from "../static/sync";

/** Run the packaged server without relying on the checkout or installed tools. */
export async function withDemoServer<T>(
  binary: string,
  callback: (url: string) => Promise<T>,
): Promise<T> {
  const executable = resolve(binary);
  assert(await Bun.file(executable).exists(), `Missing binary: ${executable}`);
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reservation.port;
  await reservation.stop(true);
  const directory = await mkdtemp(join(tmpdir(), "forge-smoke-"));
  const url = `http://127.0.0.1:${port}`;
  // Windows needs its system directory to load OS libraries. No user settings,
  // credentials, external assets, Bun or GitHub CLI reach the child process.
  const env: Record<string, string> = {
    PATH: "",
    DASHBOARD_AUTH: "demo",
    PORT: String(port),
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
  }
  let output = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const readers: Promise<void>[] = [];
  try {
    const server = Bun.spawn([executable], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    child = server;
    for (const stream of [server.stdout, server.stderr]) {
      readers.push(
        (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) {
            output = (output + decoder.decode(chunk, { stream: true })).slice(
              -16_384,
            );
          }
        })(),
      );
    }
    const deadline = performance.now() + 10_000;
    let ready = false;
    while (performance.now() < deadline && server.exitCode === null) {
      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(500),
        });
        ready = response.ok && (await response.json()).status === "ok";
        if (ready) break;
      } catch {
        // The listener may not have bound its socket yet.
      }
      await Bun.sleep(50);
    }
    assert(
      ready,
      "The packaged server did not become healthy within 10 seconds",
    );
    return await callback(url);
  } catch (error) {
    throw new Error(`${String(error)}\nServer output:\n${output}`, {
      cause: error,
    });
  } finally {
    if (child) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await Promise.allSettled(readers);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function smoke(binary: string): Promise<void> {
  await withDemoServer(binary, async (url) => {
    for (const [path, type, marker] of [
      ["/", "text/html", 'src="/app.js"'],
      ["/app.css", "text/css", "--"],
      ["/app.js", "text/javascript", "repositories"],
      ["/theme.js", "text/javascript", "theme"],
      ["/favicon.svg", "image/svg+xml", "<svg"],
    ]) {
      const response = await fetch(url + path, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200, `${path}: HTTP status`);
      assert(
        response.headers.get("content-type")?.startsWith(type),
        `${path}: content type`,
      );
      assert(
        (await response.text()).includes(marker),
        `${path}: asset content`,
      );
    }
    let fetchedAt: number | undefined;
    for (const cached of [false, true]) {
      const response = await fetch(`${url}/api/sync?priority=issues`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, "Synchronization HTTP status");
      const events: SyncEvent[] = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const context = events[0];
      assert(
        context?.type === "context",
        "Synchronization starts with context",
      );
      assert.equal(context.mode, "demo");
      assert.equal(
        context.cached,
        cached,
        "Completed results replay from cache",
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "section-complete")
          .map((event) => event.section)
          .sort(),
        ["issues", "prs", "repositories"],
        "Every section completes",
      );
      assert(!events.some((event) => event.type === "error"));
      const complete = events.at(-1);
      assert(complete?.type === "complete", "Synchronization finishes cleanly");
      assert(complete.fetchedAt > 0);
      if (cached) assert.equal(complete.fetchedAt, fetchedAt);
      fetchedAt = complete.fetchedAt;
    }
  });
  console.log(`Smoke checks passed: ${binary}`);
}

if (import.meta.main) {
  assert.equal(Bun.argv.length, 3, "Usage: bun scripts/smoke.ts <binary>");
  await smoke(Bun.argv[2]);
}
