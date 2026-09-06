import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { targets, version } from "./package";

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error(`${args[0]} ${args[1]} failed`);
  return output.trim();
}

const releaseVersion = await version();
const tag = releaseVersion;
if (Bun.env.GITHUB_REF_TYPE !== "tag" || Bun.env.GITHUB_REF_NAME !== tag)
  throw new Error(
    `Run this workflow on the tag ${tag}, matching all package versions`,
  );
const changelog = await Bun.file("CHANGELOG.md").text();
const section = changelog
  .split(/^## /m)
  .find((entry) => entry.startsWith(`${releaseVersion} — `));
if (!section)
  throw new Error(`CHANGELOG.md has no entry for ${releaseVersion}`);
if (Bun.argv[2] === "check") {
  console.log(`Release tag and changelog match ${tag}`);
} else if (Bun.argv[2] === "publish") {
  const files: string[] = [];
  const sums: string[] = [];
  for (const target of targets) {
    const extension = target.includes("windows") ? "zip" : "tar.gz";
    const name = `forge-${releaseVersion}-${target}.${extension}`;
    const archive = Bun.file(join("dist", name));
    const checksum = new Bun.CryptoHasher("sha256")
      .update(await archive.arrayBuffer())
      .digest("hex");
    const line = `${checksum}  ${name}\n`;
    if ((await Bun.file(join("dist", `${name}.sha256`)).text()) !== line)
      throw new Error(`Checksum mismatch: ${name}`);
    files.push(name, `${name}.sha256`);
    sums.push(line);
  }
  const unexpected = (await readdir("dist")).filter(
    (name) => !files.includes(name),
  );
  if (unexpected.length)
    throw new Error(`Unexpected release artifacts: ${unexpected.join(", ")}`);
  await Bun.write("dist/SHA256SUMS", sums.join(""));
  files.push("SHA256SUMS");
  async function verifyTag() {
    const refs = await command([
      "git",
      "ls-remote",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]);
    const entries = refs.split("\n").map((line) => line.split(/\s+/));
    const commit = (entries.find(([, ref]) => ref?.endsWith("^{}")) ||
      entries[0])?.[0];
    if (commit !== Bun.env.GITHUB_SHA)
      throw new Error("The release tag moved after this build started");
  }
  async function verifyDraft() {
    const state = JSON.parse(
      await command(["gh", "release", "view", tag, "--json", "isDraft"]),
    );
    if (!state.isDraft)
      throw new Error(
        "The draft was published by another process; refusing to modify it",
      );
  }
  await verifyTag();
  const existing: { tagName: string; isDraft: boolean }[] = JSON.parse(
    await command([
      "gh",
      "release",
      "list",
      "--limit",
      "1000",
      "--json",
      "tagName,isDraft",
    ]),
  );
  const release = existing.find((entry) => entry.tagName === tag);
  if (release && !release.isDraft)
    throw new Error(`${tag} is already published; create a new version`);
  const notes = section.slice(section.indexOf("\n") + 1).trim();
  await Bun.write("dist/release-notes.md", notes + "\n");
  if (!release)
    await command([
      "gh",
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      "--title",
      `Forge v${releaseVersion}`,
      "--notes-file",
      "dist/release-notes.md",
      ...(releaseVersion.split("+")[0].includes("-") ? ["--prerelease"] : []),
    ]);
  await verifyTag();
  await verifyDraft();
  await command([
    "gh",
    "release",
    "upload",
    tag,
    ...files.map((name) => join("dist", name)),
    "--clobber",
  ]);
  const uploaded: { assets: { name: string }[] } = JSON.parse(
    await command(["gh", "release", "view", tag, "--json", "assets"]),
  );
  if (
    uploaded.assets.length !== files.length ||
    uploaded.assets.some((asset) => !files.includes(asset.name))
  )
    throw new Error(
      "Draft release assets do not match the complete build; leaving it unpublished",
    );
  await verifyTag();
  await verifyDraft();
  await command([
    "gh",
    "release",
    "edit",
    tag,
    "--notes-file",
    "dist/release-notes.md",
    "--draft=false",
  ]);
  console.log(
    `Published Forge ${tag} with ${targets.length} verified platform archives`,
  );
} else {
  throw new Error("Usage: bun scripts/release.ts check|publish");
}
