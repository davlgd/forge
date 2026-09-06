import type {
  Dashboard,
  Repository,
  WorkItem,
  WorkItems,
  WorkKind,
} from "./types";

export type Section = "repositories" | WorkKind;
export type SyncEvent =
  | {
      type: "context";
      cacheTtlSeconds: number;
      cacheAgeSeconds: number;
      cached: boolean;
      viewer: Dashboard["viewer"];
      owner: { login: string; avatarUrl: string };
      mode: Dashboard["mode"];
    }
  | {
      type: "repositories";
      repositories: Repository[];
      total: number;
      owner: { login: string; avatarUrl: string };
    }
  | { type: "work-items"; kind: WorkKind; items: WorkItem[] }
  | { type: "section-complete"; section: Section }
  | { type: "complete"; fetchedAt: number }
  | { type: "error"; message: string; status: number };

export interface SectionState {
  status: "waiting" | "loading" | "complete";
  stale: boolean;
  received: number;
  pending: ReadonlySet<string>;
}
export interface SyncState {
  owner: string | null;
  dashboard: Dashboard | null;
  work: Record<WorkKind, WorkItems | null>;
  sections: Record<Section, SectionState>;
  repositoryTotal: number | null;
  phase: "idle" | "syncing" | "ready" | "error";
  error: string | null;
  errorStatus: number | null;
  lastSuccess: number | null;
}

const sections: Section[] = ["repositories", "issues", "prs"];
const empty = (owner: string | null): SyncState => ({
  owner,
  dashboard: null,
  work: { issues: null, prs: null },
  sections: {
    repositories: {
      status: "waiting",
      stale: false,
      received: 0,
      pending: new Set(),
    },
    issues: {
      status: "waiting",
      stale: false,
      received: 0,
      pending: new Set(),
    },
    prs: { status: "waiting", stale: false, received: 0, pending: new Set() },
  },
  repositoryTotal: null,
  phase: "idle",
  error: null,
  errorStatus: null,
  lastSuccess: null,
});

function totals(repositories: Repository[]): Dashboard["totals"] {
  return repositories.reduce(
    (sum, repo) => ({
      repositories: sum.repositories + 1,
      stars: sum.stars + repo.stargazerCount,
      forks: sum.forks + repo.forkCount,
      issues: sum.issues + (repo.isArchived ? 0 : repo.issues.totalCount),
      pullRequests:
        sum.pullRequests + (repo.isArchived ? 0 : repo.pullRequests.totalCount),
      archived: sum.archived + Number(repo.isArchived),
    }),
    {
      repositories: 0,
      stars: 0,
      forks: 0,
      issues: 0,
      pullRequests: 0,
      archived: 0,
    },
  );
}

async function readEvents(
  response: Response,
  receive: (event: SyncEvent) => void,
) {
  if (!response.body) throw new Error("No synchronization data was received.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) receive(JSON.parse(line) as SyncEvent);
      }
    }
    // Every server frame ends in a newline; a trailing fragment is incomplete.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createAccountSync(changed: (state: SyncState) => void) {
  let state = empty(null);
  let controller: AbortController | null = null;
  let freshUntil = 0;
  let generation = 0;
  const notify = () => changed(state);

  async function ensure(
    owner: string | null,
    priority: Section,
    force = false,
  ) {
    const sameOwner =
      (owner || state.owner)?.toLowerCase() === state.owner?.toLowerCase();
    if (sameOwner && !force && (controller || Date.now() < freshUntil)) return;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const revision = ++generation;
    if (!sameOwner) state = empty(owner);
    let previousRepositories = state.dashboard?.owner.repositories || [];
    let previousWork = {
      issues: state.work.issues?.items || [],
      prs: state.work.prs?.items || [],
    };
    const waiting = (ids: string[]): SectionState => ({
      status: "waiting",
      stale: ids.length > 0,
      received: 0,
      pending: new Set(ids),
    });
    state = {
      ...state,
      owner,
      phase: "syncing",
      error: null,
      errorStatus: null,
      sections: {
        repositories: waiting(
          previousRepositories.map((repo) => repo.nameWithOwner),
        ),
        issues: waiting(previousWork.issues.map((item) => item.id)),
        prs: waiting(previousWork.prs.map((item) => item.id)),
      },
    };
    freshUntil = 0;
    notify();
    let context: Extract<SyncEvent, { type: "context" }> | null = null;
    const repositories = new Map<string, Repository>();
    const work: Record<WorkKind, Map<string, WorkItem>> = {
      issues: new Map(),
      prs: new Map(),
    };
    let finished = false;
    let replayExpiresAt = 0;

    // Retain unconfirmed old rows until the section's final page arrives.
    function merge<T>(
      section: Section,
      previous: T[],
      fresh: Map<string, T>,
      key: (item: T) => string,
      complete: boolean,
    ): T[] {
      const pending = new Set(
        complete ? [] : previous.map(key).filter((id) => !fresh.has(id)),
      );
      state = {
        ...state,
        sections: {
          ...state.sections,
          [section]: {
            status: complete ? "complete" : "loading",
            stale: pending.size > 0,
            received: fresh.size,
            pending,
          },
        },
      };
      if (complete) return [...fresh.values()];
      const oldIds = new Set(previous.map(key));
      return [
        ...previous.map((item) => fresh.get(key(item)) || item),
        ...[...fresh.values()].filter((item) => !oldIds.has(key(item))),
      ];
    }
    function publishRepositories(complete = false) {
      if (!context)
        throw new Error("Synchronization is missing its account details.");
      const items = merge(
        "repositories",
        previousRepositories,
        repositories,
        (repo) => repo.nameWithOwner,
        complete,
      );
      state = {
        ...state,
        dashboard: {
          viewer: context.viewer,
          owner: { ...context.owner, repositories: items },
          mode: context.mode,
          fetchedAt: state.lastSuccess || 0,
          totals: totals(items),
        },
      };
    }
    function publishWork(kind: WorkKind, complete = false) {
      if (!context)
        throw new Error("Synchronization is missing its account details.");
      const items = merge(
        kind,
        previousWork[kind],
        work[kind],
        (item) => item.id,
        complete,
      );
      state = {
        ...state,
        work: {
          ...state.work,
          [kind]: {
            owner: context.owner.login,
            kind,
            items,
            fetchedAt: state.lastSuccess || 0,
            mode: context.mode,
          },
        },
      };
    }
    function receive(event: SyncEvent) {
      if (revision !== generation) return;
      if (finished)
        throw new Error("Unexpected data after synchronization completed.");
      switch (event.type) {
        case "context": {
          if (context) throw new Error("Account details were received twice.");
          const oldViewer = state.dashboard?.viewer.login;
          if (oldViewer && oldViewer !== event.viewer.login) {
            state = empty(event.owner.login);
            previousRepositories = [];
            previousWork = { issues: [], prs: [] };
          }
          context = event;
          replayExpiresAt =
            Date.now() +
            Math.max(
              0,
              (event.cacheTtlSeconds || 0) - (event.cacheAgeSeconds || 0),
            ) *
              1000;
          state = { ...state, phase: "syncing", owner: event.owner.login };
          if (!state.dashboard) publishRepositories();
          break;
        }
        case "repositories":
          if (!context || state.sections.repositories.status === "complete")
            throw new Error("Unexpected repository data.");
          context.owner = event.owner;
          for (const repo of event.repositories) {
            if (repositories.has(repo.nameWithOwner))
              throw new Error(
                "Duplicate repository data interrupted synchronization.",
              );
            repositories.set(repo.nameWithOwner, repo);
          }
          state = { ...state, repositoryTotal: event.total };
          publishRepositories();
          break;
        case "work-items":
          if (
            !context ||
            !(event.kind in work) ||
            state.sections[event.kind].status === "complete"
          )
            throw new Error("Unexpected conversation data.");
          for (const item of event.items) {
            if (work[event.kind].has(item.id))
              throw new Error(
                "Duplicate conversation data interrupted synchronization.",
              );
            work[event.kind].set(item.id, item);
          }
          publishWork(event.kind);
          break;
        case "section-complete":
          if (
            !sections.includes(event.section) ||
            state.sections[event.section].status === "complete"
          )
            throw new Error("Unexpected section completion.");
          if (event.section === "repositories") {
            if (state.repositoryTotal !== repositories.size)
              throw new Error("Some repositories could not be loaded.");
            publishRepositories(true);
          } else publishWork(event.section, true);
          break;
        case "complete":
          if (
            !state.dashboard ||
            !sections.every(
              (section) => state.sections[section].status === "complete",
            ) ||
            !Number.isFinite(event.fetchedAt)
          )
            throw new Error(
              "Synchronization ended before every section was complete.",
            );
          finished = true;
          state = {
            ...state,
            phase: "ready",
            lastSuccess: event.fetchedAt,
            dashboard: { ...state.dashboard, fetchedAt: event.fetchedAt },
            work: {
              issues: { ...state.work.issues!, fetchedAt: event.fetchedAt },
              prs: { ...state.work.prs!, fetchedAt: event.fetchedAt },
            },
          };
          freshUntil = context?.cached
            ? replayExpiresAt
            : Date.now() + (context?.cacheTtlSeconds || 0) * 1000;
          break;
        case "error":
          state = { ...state, errorStatus: event.status };
          throw new Error(event.message);
        default:
          throw new Error(
            "An unexpected synchronization response was received.",
          );
      }
      notify();
    }
    try {
      const query = new URLSearchParams({ priority });
      if (owner) query.set("owner", owner);
      if (force) query.set("refresh", "true");
      const response = await fetch(`/api/sync?${query}`, {
        signal: request.signal,
        cache: "no-store",
      });
      if (revision !== generation) return;
      if (!response.ok) {
        state = { ...state, errorStatus: response.status };
        const error = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          error?.error ||
            "Unable to synchronize. Refresh the page to sign in again.",
        );
      }
      await readEvents(response, receive);
      if (revision !== generation) return;
      if (!finished)
        throw new Error(
          "Synchronization was interrupted before every section finished. Try again.",
        );
    } catch (error) {
      if (revision !== generation || request.signal.aborted) return;
      freshUntil = 0;
      state = {
        ...state,
        phase: "error",
        error:
          error instanceof Error
            ? error.message
            : "Unable to synchronize your account.",
      };
      notify();
    } finally {
      if (revision === generation) controller = null;
    }
  }
  return {
    ensure,
    get state() {
      return state;
    },
  };
}
