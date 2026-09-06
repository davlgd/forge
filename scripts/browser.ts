import { resolve } from "node:path";
import { smoke, withDemoServer } from "./smoke";

const binary = resolve(
  "target/release/github-dashboard" +
    (process.platform === "win32" ? ".exe" : ""),
);
await smoke(binary);
await withDemoServer(binary, async (url) => {
  const child = Bun.spawn([process.execPath, "test", "tests"], {
    env: { ...Bun.env, DASHBOARD_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error("Browser checks failed");
});
