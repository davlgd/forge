import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { smoke } from "./smoke";

const root = resolve(import.meta.dir, "..");
export const targets: readonly string[] = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
const documents = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  ".env.example",
  "docs/assets/dashboard.png",
];
export async function version(): Promise<string> {
  const manifests = await Promise.all(
    ["Cargo.toml", "crates/github-api/Cargo.toml"].map(
      async (path) =>
        Bun.TOML.parse(await Bun.file(join(root, path)).text()) as {
          package?: { version?: unknown };
        },
    ),
  );
  const frontend = await Bun.file(join(root, "package.json")).json();
  const releaseVersion = manifests[0].package?.version;
  assert(
    typeof releaseVersion === "string" &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        releaseVersion,
      ),
    "Cargo.toml must declare a SemVer version",
  );
  assert.equal(
    manifests[1].package?.version,
    releaseVersion,
    "Rust crate version mismatch",
  );
  assert.equal(frontend.version, releaseVersion, "Frontend version mismatch");
  return releaseVersion;
}

async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, {
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  assert.equal(await child.exited, 0, `${basename(command[0])} failed`);
}

export async function packageRelease(target: string): Promise<void> {
  assert(targets.includes(target), `Unsupported target: ${target}`);
  const releaseVersion = await version();
  const windows = target.endsWith("windows-msvc");
  const executable = windows ? "forge.exe" : "forge";
  const source = join(
    root,
    "target",
    target,
    "release",
    windows ? "github-dashboard.exe" : "github-dashboard",
  );
  assert(await Bun.file(source).exists(), `Build the target first: ${source}`);
  const name = `forge-${releaseVersion}-${target}`;
  const filename = `${name}.${windows ? "zip" : "tar.gz"}`;
  const temporary = await mkdtemp(join(tmpdir(), "forge-package-"));
  const archive = join(temporary, filename);
  const stage = join(temporary, "stage");
  const extracted = join(temporary, "extracted");
  const destination = join(root, "dist", filename);

  try {
    await mkdir(join(stage, name), { recursive: true });
    await copyFile(source, join(stage, name, executable));
    if (!windows) await chmod(join(stage, name, executable), 0o755);
    // This allowlist deliberately excludes deployment state and private files.
    for (const path of documents) {
      const output = join(stage, name, path);
      await mkdir(dirname(output), { recursive: true });
      await copyFile(join(root, path), output);
    }
    await mkdir(extracted);
    if (windows) {
      const env = {
        ...process.env,
        FORGE_PACKAGE_SOURCE: join(stage, name),
        FORGE_PACKAGE_ARCHIVE: archive,
        FORGE_PACKAGE_EXTRACTED: extracted,
      };
      await run(
        [
          "pwsh",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:FORGE_PACKAGE_SOURCE -DestinationPath $env:FORGE_PACKAGE_ARCHIVE; Expand-Archive -LiteralPath $env:FORGE_PACKAGE_ARCHIVE -DestinationPath $env:FORGE_PACKAGE_EXTRACTED",
        ],
        env,
      );
    } else {
      await run(["tar", "-czf", archive, "-C", stage, name]);
      await run(["tar", "-xzf", archive, "-C", extracted]);
    }
    for (const path of [executable, ...documents]) {
      assert(
        await Bun.file(join(extracted, name, path)).exists(),
        `Archive is missing ${path}`,
      );
    }
    await smoke(join(extracted, name, executable));
    const checksum = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(archive).arrayBuffer())
      .digest("hex");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(archive, `${destination}.tmp`);
    await rename(`${destination}.tmp`, destination);
    await Bun.write(`${destination}.sha256`, `${checksum}  ${filename}\n`);
    console.log(`Created ${destination}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(
    Bun.argv.length,
    3,
    "Usage: bun scripts/package.ts <rust-target>",
  );
  await packageRelease(Bun.argv[2]);
}
