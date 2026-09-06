import type { WorkItem, WorkKind } from "../static/types";

type Kind = WorkKind;

function item(
  number: number,
  title: string,
  repository: string,
  kind: Kind,
  options: {
    author?: string;
    assignee?: string;
    label?: string;
    updated?: string;
    created?: string;
    review?: WorkItem["reviewDecision"];
    draft?: boolean;
  } = {},
): WorkItem {
  return {
    id: `fixture-${kind}-${number}`,
    number,
    title,
    url: `https://github.com/studio/${repository}/${kind === "issues" ? "issues" : "pull"}/${number}`,
    createdAt: options.created ?? "2026-08-01T08:00:00Z",
    updatedAt: options.updated ?? "2026-09-05T08:00:00Z",
    author: { login: options.author ?? "alex" },
    repository: { name: repository, nameWithOwner: `studio/${repository}` },
    labels: options.label ? [{ name: options.label, color: "aabbcc" }] : [],
    assignees: options.assignee ? [{ login: options.assignee }] : [],
    comments: 3,
    isDraft: options.draft ?? false,
    reviewDecision: options.review ?? null,
  };
}

export const workFixtures = {
  issues: [
    item(41, "Fix request timeout", "orbit", "issues", {
      assignee: "studio",
      label: "bug",
      updated: "2026-09-06T08:00:00Z",
      created: "2026-08-03T08:00:00Z",
    }),
    item(12, "Document map keyboard controls", "atlas", "issues", {
      author: "sam",
      label: "documentation",
      updated: "2026-09-04T08:00:00Z",
    }),
    item(9, "Improve cache diagnostics", "orbit", "issues", {
      author: "lee",
      assignee: "sam",
      created: "2026-08-02T08:00:00Z",
    }),
  ],
  prs: [
    item(54, "Add retry budget", "orbit", "prs", {
      review: "REVIEW_REQUIRED",
      assignee: "studio",
      updated: "2026-09-06T08:00:00Z",
    }),
    item(32, "Correct map focus order", "atlas", "prs", {
      review: "CHANGES_REQUESTED",
    }),
    item(27, "Speed up cache reads", "orbit", "prs", {
      review: "APPROVED",
    }),
    item(18, "Prototype offline maps", "atlas", "prs", { draft: true }),
  ],
};
