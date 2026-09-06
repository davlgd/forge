export interface Account {
  login: string;
  avatarUrl: string;
}

export interface Repository {
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  stargazerCount: number;
  forkCount: number;
  pushedAt: string | null;
  updatedAt: string;
  primaryLanguage: { name: string; color: string | null } | null;
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
}

export interface Dashboard {
  viewer: Account & {
    name: string | null;
    organizations: (Account & { name: string | null })[];
  };
  owner: Account & { repositories: Repository[] };
  totals: {
    repositories: number;
    stars: number;
    forks: number;
    issues: number;
    pullRequests: number;
    archived: number;
  };
  fetchedAt: number;
  mode: "gh" | "proxy" | "demo";
}

export type WorkKind = "issues" | "prs";

export interface WorkItem {
  id: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  repository: { name: string; nameWithOwner: string };
  labels: { name: string; color: string }[];
  assignees: { login: string }[];
  comments: number;
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

export interface WorkItems {
  owner: string;
  kind: WorkKind;
  items: WorkItem[];
  fetchedAt: number;
  mode: Dashboard["mode"];
}
