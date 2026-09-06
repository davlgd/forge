import type { Dashboard, WorkItem, WorkItems, WorkKind } from "./types";
import { $, age, countLabel, fmt, hostedLogin, icon } from "./ui";
import type { SyncState } from "./sync";
import {
  preferenceScope,
  readPreferences,
  savePreferences,
  savedText,
  savedChoice,
} from "./preferences";

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content: string,
  cls = "",
) {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = cls;
  return node;
}

function status(item: WorkItem) {
  if (item.isDraft) return { label: "Draft", style: "draft" };
  switch (item.reviewDecision) {
    case "APPROVED":
      return { label: "Approved", style: "approved" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", style: "changes" };
    case "REVIEW_REQUIRED":
      return { label: "Review required", style: "review" };
    default:
      return { label: "Open", style: "open" };
  }
}

export function createWorkInbox(retry: () => void) {
  let context: Dashboard | null = null;
  let kind: WorkKind = "issues";
  let snapshot: SyncState | null = null;
  let visibleCount = 50;
  let active = false;
  const rendered = new Map<
    string,
    {
      item: WorkItem;
      mode: WorkItems["mode"];
      pending: boolean;
      node: HTMLLIElement;
    }
  >();
  const search = $<HTMLInputElement>("#work-search");
  const repository = $<HTMLSelectElement>("#work-repository");
  const assignee = $<HTMLSelectElement>("#work-assignee");
  const review = $<HTMLSelectElement>("#work-status");
  const sort = $<HTMLSelectElement>("#work-sort");
  const noun = () => (kind === "issues" ? "issue" : "pull request");

  function resetFilters() {
    search.value = "";
    repository.value = "";
    assignee.value = "all";
    review.value = "all";
    sort.value = "updated";
    visibleCount = 50;
  }

  function preferenceKey() {
    return context
      ? `${preferenceScope(context.viewer.login, context.owner.login)}/work/${kind}`
      : "";
  }
  function saveFilters() {
    const key = preferenceKey();
    if (key)
      savePreferences(key, {
        search: search.value.slice(0, 500),
        repository: repository.value,
        assignee: assignee.value,
        review: review.value,
        sort: sort.value,
        visibleCount,
      });
  }
  function restoreFilters() {
    resetFilters();
    const prefs = readPreferences(preferenceKey());
    search.value = savedText(prefs.search);
    updateRepositories(savedText(prefs.repository));
    assignee.value = savedChoice(
      prefs.assignee,
      ["all", "me", "unassigned"],
      "all",
    );
    review.value = savedChoice(
      prefs.review,
      ["all", "draft", "review", "approved", "changes"],
      "all",
    );
    sort.value = savedChoice(
      prefs.sort,
      ["updated", "oldest", "created"],
      "updated",
    );
    if (
      typeof prefs.visibleCount === "number" &&
      prefs.visibleCount >= 50 &&
      prefs.visibleCount <= 10_000
    )
      visibleCount = Math.floor(prefs.visibleCount / 50) * 50;
  }

  function row(item: WorkItem, mode: WorkItems["mode"], pending: boolean) {
    const article = document.createElement("li");
    article.className = "work-item";
    article.dataset.key = `${kind}:${item.id}`;
    const symbol = text("span", "", "work-symbol");
    symbol.innerHTML = icon(kind === "issues" ? "issue" : "pr");
    const body = document.createElement("div");
    body.className = "work-body";
    const heading = document.createElement("h3");
    const title =
      mode === "demo"
        ? text("span", item.title, "work-title")
        : text("a", item.title, "work-title");
    if (title instanceof HTMLAnchorElement) {
      const repo = item.repository.nameWithOwner
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      title.href = `https://github.com/${repo}/${kind === "issues" ? "issues" : "pull"}/${encodeURIComponent(item.number)}`;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
      title.setAttribute(
        "aria-label",
        `${item.title} · ${item.repository.nameWithOwner} #${item.number} · Open on GitHub`,
      );
    }
    heading.append(title);
    body.append(heading);
    const meta = text("div", "", "work-meta");
    meta.append(
      text(
        "span",
        `${item.repository.nameWithOwner} #${item.number}`,
        "work-repository",
      ),
    );
    meta.append(
      text("span", `by ${item.author?.login || "a deleted account"}`),
    );
    const updated = text("time", `Updated ${age(item.updatedAt)}`);
    updated.dateTime = item.updatedAt;
    updated.title = new Date(item.updatedAt).toLocaleString("en-US");
    meta.append(updated, text("span", countLabel(item.comments, "comment")));
    body.append(meta);
    const details = text("div", "", "work-details");
    if (kind === "prs") {
      const decision = status(item);
      details.append(
        text("span", decision.label, `work-status ${decision.style}`),
      );
    }
    if (pending)
      details.append(text("span", "Not yet refreshed", "work-label"));
    for (const label of item.labels)
      details.append(text("span", label.name, "work-label"));
    details.append(
      text(
        "span",
        item.assignees.length
          ? `Assigned to ${item.assignees.map((user) => user.login).join(", ")}`
          : "Unassigned",
        "work-assignment",
      ),
    );
    body.append(details);
    article.append(symbol, body);
    return article;
  }

  function updateRepositories(selection = repository.value) {
    if (!snapshot) return;
    const names = new Set(
      (snapshot.work[kind]?.items || []).map((item) => item.repository.name),
    );
    // Keep an explicit drill-down selected, even if its last conversation closed.
    if (selection) names.add(selection);
    const sorted = [...names].sort();
    if (
      repository.options.length !== sorted.length + 1 ||
      sorted.some(
        (name, index) => repository.options[index + 1]?.value !== name,
      )
    )
      repository.replaceChildren(
        new Option("All repositories", ""),
        ...sorted.map((name) => new Option(name, name)),
      );
    repository.value = selection;
  }

  function render() {
    if (!active || !snapshot || !context) return;
    updateRepositories();
    const section = snapshot.sections[kind];
    const complete = section.status === "complete";
    const data = snapshot.work[kind];
    const pending = snapshot.phase === "syncing" && !complete;
    $("#work-loading").hidden = !pending;
    $("#work-error").hidden = snapshot.phase !== "error" || complete;
    $("#work-error-message").textContent =
      snapshot.error || "Some conversations could not be loaded.";
    $("#work-login").hidden = snapshot.errorStatus !== 401 || !hostedLogin;
    $("#work-loading-label").textContent = section.stale
      ? "Updating conversations. Previous results remain available."
      : `Loading ${noun()}s… ${fmt(section.received)} received`;
    if (!data) {
      $("#work-content").hidden = true;
      $("#work-count").textContent = pending ? "Loading…" : "Incomplete";
      return;
    }
    const query = search.value.trim().toLocaleLowerCase();
    const selectedRepo = repository.value;
    const loadedScope = data.owner;
    const rows = data.items.filter((item) => {
      if (selectedRepo && item.repository.name !== selectedRepo) return false;
      if (
        assignee.value === "me" &&
        !item.assignees.some(
          (user) =>
            user.login.toLowerCase() === context?.viewer.login.toLowerCase(),
        )
      )
        return false;
      if (assignee.value === "unassigned" && item.assignees.length)
        return false;
      if (kind === "prs" && review.value !== "all") {
        if (
          review.value === "draft"
            ? !item.isDraft
            : item.isDraft || status(item).style !== review.value
        )
          return false;
      }
      return (
        !query ||
        [
          item.title,
          `#${item.number}`,
          item.repository.nameWithOwner,
          item.author?.login,
          ...item.labels.map((label) => label.name),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)
      );
    });
    if (complete)
      rows.sort((a, b) =>
        sort.value === "oldest"
          ? a.updatedAt.localeCompare(b.updatedAt)
          : sort.value === "created"
            ? b.createdAt.localeCompare(a.createdAt)
            : b.updatedAt.localeCompare(a.updatedAt),
      );
    const list = $("#work-list");
    const focused =
      document.activeElement?.closest<HTMLElement>(".work-item")?.dataset.key;
    const visible = new Set<string>();
    let previous: ChildNode | null = null;
    for (const item of rows.slice(0, visibleCount)) {
      const key = `${kind}:${item.id}`;
      visible.add(key);
      let entry = rendered.get(key);
      const unconfirmed = section.pending.has(item.id);
      if (
        !entry ||
        entry.item !== item ||
        entry.mode !== data.mode ||
        entry.pending !== unconfirmed
      ) {
        entry = {
          item,
          mode: data.mode,
          pending: unconfirmed,
          node: row(item, data.mode, unconfirmed),
        };
        rendered.set(key, entry);
      }
      const next: ChildNode | null = previous
        ? previous.nextSibling
        : list.firstChild;
      if (next !== entry.node) list.insertBefore(entry.node, next);
      previous = entry.node;
    }
    while (previous ? previous.nextSibling : list.firstChild) {
      (previous ? previous.nextSibling : list.firstChild)?.remove();
    }
    for (const key of rendered.keys())
      if (!visible.has(key)) rendered.delete(key);
    if (focused && document.activeElement === document.body) {
      rendered
        .get(focused)
        ?.node.querySelector<HTMLElement>(".work-title")
        ?.focus({ preventScroll: true });
    }
    $("#work-count").textContent = complete
      ? (rows.length !== data.items.length ? `${fmt(rows.length)} of ` : "") +
        countLabel(data.items.length, `open ${noun()}`)
      : `${fmt(rows.length)} matches · ${fmt(section.received)} received · ${snapshot.phase === "error" ? "Incomplete" : "Updating"}`;
    $("#work-summary").textContent = complete
      ? `${fmt(Math.min(visibleCount, rows.length))} of ${countLabel(rows.length, `matching ${noun()}`)} · ${fmt(data.items.length)} open in ${loadedScope}`
      : `${fmt(Math.min(visibleCount, rows.length))} matching ${noun()}s shown · ${section.stale ? "Previous results" : "Partial results"}`;
    $("#work-sync").textContent =
      snapshot.phase === "ready"
        ? `Synced at ${new Date(data.fetchedAt * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
        : snapshot.phase === "error"
          ? "Synchronization incomplete"
          : "Updating account…";
    $("#work-empty").hidden = !complete || rows.length > 0;
    $("#work-empty-title").textContent = data.items.length
      ? `No matching ${noun()}s`
      : `No open ${noun()}s`;
    $("#work-empty-message").textContent = data.items.length
      ? "Try another search or clear your filters."
      : repository.value
        ? `There are no open ${noun()}s in ${repository.value}. Choose another repository or clear your filters.`
        : `There are no open ${noun()}s in this account's active repositories.`;
    $("#work-reset").hidden = !data.items.length && !repository.value;
    $("#work-more").hidden = rows.length <= visibleCount;
    $("#work-more").textContent =
      `Show ${fmt(Math.min(50, rows.length - visibleCount))} more`;
    $("#work-content").hidden = false;
  }

  for (const field of [search, assignee, review, sort]) {
    field.addEventListener(field === search ? "input" : "change", () => {
      visibleCount = 50;
      saveFilters();
      render();
    });
  }
  repository.addEventListener("change", () => {
    visibleCount = 50;
    saveFilters();
    render();
  });
  $("#work-reset").addEventListener("click", () => {
    resetFilters();
    saveFilters();
    render();
    search.focus();
  });
  $("#work-retry").addEventListener("click", retry);
  $("#work-more").addEventListener("click", () => {
    visibleCount += 50;
    saveFilters();
    render();
  });

  return {
    update(next: SyncState) {
      snapshot = next;
      const data = next.dashboard;
      if (!data) {
        context = null;
        rendered.clear();
        return;
      }
      const sameOwner =
        context?.owner.login === data.owner.login &&
        context?.viewer.login === data.viewer.login;
      context = data;
      if (!sameOwner) {
        restoreFilters();
        rendered.clear();
      }
      render();
    },
    show(nextKind: WorkKind, selectedRepository?: string) {
      active = true;
      const changed = kind !== nextKind;
      kind = nextKind;
      if (changed) restoreFilters();
      if (selectedRepository !== undefined) {
        resetFilters();
        updateRepositories(selectedRepository);
        saveFilters();
      }
      $("#work-section-title").textContent =
        kind === "issues" ? "Open issues" : "Open pull requests";
      $("#work-status-control").hidden = kind !== "prs";
      search.placeholder = `Search ${noun()}s…`;
      $("#work-scope").textContent =
        `Active repositories owned by ${context?.owner.login || "your account"}. Archives are excluded.`;
      render();
    },
    hide() {
      active = false;
    },
  };
}
