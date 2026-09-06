import type { Dashboard, Repository, WorkKind } from "./types";
import {
  $,
  $$,
  age,
  countLabel,
  escapeHtml,
  fmt,
  hostedLogin,
  icon,
  safeColor,
} from "./ui";
import { createWorkInbox } from "./work-items";
import { createAccountSync, type SyncState, type Section } from "./sync";

import { createMenus } from "./menus";
import {
  preferenceScope,
  readPreferences,
  savePreferences,
  savedText,
  savedChoice,
} from "./preferences";

type View = "overview" | "repositories" | "issues" | "prs" | "popular";
const views: View[] = ["overview", "repositories", "issues", "prs", "popular"];

const navigation = readPreferences("navigation");
const params = new URLSearchParams(location.search);
const initialOwner = params.get("owner") || savedText(navigation.owner) || null;
let checkSavedIdentity = !params.has("owner") && Boolean(initialOwner);
let recoveringOwner: string | null = null;
let scope = "";
const sortKeys = [
  "name",
  "language",
  "stars",
  "issues",
  "prs",
  "activity",
] as const;
type SortKey = (typeof sortKeys)[number];
let sortKey: SortKey = "activity";
let sortDirection: "ascending" | "descending" = "descending";
const state: {
  data: Dashboard | null;
  view: View;
} = {
  data: null,
  view:
    views.find((view) => view === (params.get("view") || navigation.view)) ||
    "overview",
};
const priority = (): Section =>
  state.view === "issues" || state.view === "prs" ? state.view : "repositories";
const inbox = createWorkInbox(() => void load(sync.state.owner, true));
const sync = createAccountSync(updateSync);
const menus = createMenus((owner) => void load(owner));
const repoUrl = (repo: Repository, path = "") =>
  `https://github.com/${repo.nameWithOwner.split("/").map(encodeURIComponent).join("/")}${path}`;
const external = 'target="_blank" rel="noopener noreferrer"';

function load(owner: string | null, force = false) {
  return sync.ensure(owner, priority(), force);
}

function updateSync(snapshot: SyncState) {
  const data = snapshot.dashboard;
  if (recoveringOwner && data) {
    if (data.owner.login.toLowerCase() !== recoveringOwner.toLowerCase())
      return;
    recoveringOwner = null;
  }
  const syncing = snapshot.phase === "syncing";
  const failed = snapshot.phase === "error";
  $("#sync-status").hidden = !syncing && !failed;
  $("#sync-status").classList.toggle("sync-error", failed);
  $("#sync-retry").hidden = !failed;
  $("#sync-progress").hidden = !syncing;
  const done = Object.values(snapshot.sections).filter(
    (section) => section.status === "complete",
  ).length;
  $<HTMLProgressElement>("#sync-progress").value = done;
  const counts = `${fmt(snapshot.sections.repositories.received)}${snapshot.repositoryTotal === null ? "" : `/${fmt(snapshot.repositoryTotal)}`} repositories · ${countLabel(snapshot.sections.issues.received, "issue")} · ${countLabel(snapshot.sections.prs.received, "pull request")}`;
  const last = snapshot.lastSuccess
    ? new Date(snapshot.lastSuccess * 1000).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  $("#sync-message").textContent = failed
    ? `Synchronization incomplete. ${snapshot.error} ${last ? `Last successful sync: ${last}.` : "Received results may be partial."}`
    : syncing
      ? `${last ? `Updating · last successful sync ${last}` : "Loading your account"} · ${counts}`
      : `All sections up to date · Synced at ${last}`;
  $<HTMLButtonElement>("#refresh").disabled = syncing;
  menus.setLoading(syncing, snapshot.owner || undefined);
  $("#loading").hidden = Boolean(data) || !syncing;
  $("#dashboard").hidden = !data;
  $("#error").hidden = !failed || Boolean(data);
  $("#error-message").textContent = snapshot.error || "";
  $("#login").hidden = snapshot.errorStatus !== 401 || !hostedLogin;
  $("#sync-login").hidden = snapshot.errorStatus !== 401 || !hostedLogin;
  if (data && checkSavedIdentity) {
    checkSavedIdentity = false;
    if (
      savedText(navigation.viewer).toLowerCase() !==
      data.viewer.login.toLowerCase()
    ) {
      recoveringOwner = data.viewer.login;
      queueMicrotask(() => void load(data.viewer.login));
      return;
    }
  }
  inbox.update(snapshot);
  if (!data) {
    state.data = null;
    $("#breadcrumb-owner").textContent = snapshot.owner || "Your account";
    $("#connection-label").textContent = failed
      ? "Sync interrupted"
      : "Connecting to GitHub";
    return;
  }
  const newData = state.data !== data;
  state.data = data;
  if (newData) render(data);
  const repoState = snapshot.sections.repositories;
  $("#repo-loading").hidden = repoState.status === "complete" || !syncing;
  $("#repo-loading").textContent = repoState.stale
    ? "Updating repositories. Previous results remain available."
    : `Loading repositories… ${counts.split(" · ")[0]} received`;
  if (repoState.status !== "complete") {
    $("#empty").hidden = true;
    $("#table-summary").textContent =
      `${fmt(repoState.received)} repositories received · ${repoState.stale ? "Previous results" : "Partial results"}`;
    if (!repoState.stale)
      for (const name of ["repos", "stars", "issues", "prs"])
        $("#stat-" + name).textContent = "…";
  }
  if (repoState.status !== "complete") $("#nav-repos").textContent = "…";
  for (const kind of ["issues", "prs"] as const) {
    const section = snapshot.sections[kind];
    const items = snapshot.work[kind];
    if (section.status === "complete" && items) {
      $("#nav-" + kind).textContent = fmt(items.items.length);
      $("#stat-" + kind).textContent = fmt(items.items.length);
    } else {
      $("#nav-" + kind).textContent = "…";
      $("#stat-" + kind).textContent = "…";
    }
  }
  $("#sync-time").textContent =
    snapshot.phase === "ready"
      ? `Synced at ${last}`
      : failed
        ? "Synchronization incomplete"
        : "Updating account…";
  const url = new URL(location.href);
  url.searchParams.set("owner", data.owner.login);
  url.searchParams.set("view", state.view);
  if (url.href !== location.href) history.replaceState(null, "", url);
}

function render(data: Dashboard) {
  const { viewer, owner, totals, mode, fetchedAt } = data;
  menus.update(data);
  const nextScope = preferenceScope(viewer.login, owner.login);
  if (scope !== nextScope) {
    scope = nextScope;
    restoreRepositoryPreferences();
    restoreSort();
  }
  savePreferences("navigation", {
    viewer: viewer.login,
    owner: owner.login,
    view: state.view,
  });
  $("#breadcrumb-owner").textContent = owner.login;
  $("#connection-label").textContent =
    mode === "demo"
      ? "Demo data"
      : mode === "gh"
        ? "Connected via GitHub CLI"
        : "Connected to GitHub";
  if (mode === "demo") {
    $("#notice").textContent =
      "Demo mode · These projects and conversations are fictional. GitHub links are disabled.";
    $("#notice").hidden = false;
  }
  for (const [key, value] of Object.entries({
    repos: totals.repositories,
    stars: totals.stars,
    issues: totals.issues,
    prs: totals.pullRequests,
  })) {
    $("#stat-" + key).textContent = fmt(value);
    const nav = document.querySelector("#nav-" + key);
    if (nav) nav.textContent = fmt(value);
  }
  $("#stat-repos-note").textContent =
    `${fmt(totals.repositories - totals.archived)} active · ${fmt(totals.archived)} archived`;
  $("#stat-stars-note").textContent = `${fmt(totals.forks)} total forks`;
  $("#sync-time").textContent =
    "Synced at " +
    new Date(fetchedAt * 1000).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  $("#sync-time").title = new Date(fetchedAt * 1000).toLocaleString("en-US");
  const languages = [
    ...new Set(
      owner.repositories
        .map((r) => r.primaryLanguage?.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
  const oldLanguage = $<HTMLSelectElement>("#language").value;
  if (
    oldLanguage &&
    sync.state.sections.repositories.status !== "complete" &&
    !languages.includes(oldLanguage)
  )
    languages.push(oldLanguage);
  $<HTMLSelectElement>("#language").replaceChildren(
    new Option("All languages", ""),
    ...languages.map((name) => new Option(name, name)),
  );
  if (languages.includes(oldLanguage))
    $<HTMLSelectElement>("#language").value = oldLanguage;
  renderOverview(owner.repositories);
  renderLanguages(owner.repositories);
  renderView();
}

function link(
  repo: Repository,
  content: string,
  path = "",
  cls = "",
  label = "",
) {
  if (state.data?.mode === "demo")
    return `<span class="${cls}">${content}</span>`;
  return `<a class="${cls}" href="${repoUrl(repo, path)}" ${external}${label ? ` aria-label="${escapeHtml(label)}"` : ""}>${content}</a>`;
}

function workButton(
  repo: Repository,
  kind: WorkKind,
  content: string,
  cls: string,
) {
  const label = `View ${kind === "issues" ? "open issues" : "open pull requests"} in ${repo.name}`;
  if (repo.isArchived)
    return link(
      repo,
      content,
      kind === "issues" ? "/issues" : "/pulls",
      cls,
      label + " on GitHub",
    );
  return `<button class="${cls}" data-work-kind="${kind}" data-repository="${escapeHtml(repo.name)}" aria-label="${escapeHtml(label)}">${content}</button>`;
}

function renderOverview(repos: Repository[]) {
  const attention = repos
    .filter(
      (r) =>
        !r.isArchived && r.issues.totalCount + r.pullRequests.totalCount > 0,
    )
    .sort(
      (a, b) =>
        b.pullRequests.totalCount - a.pullRequests.totalCount ||
        b.issues.totalCount - a.issues.totalCount,
    )
    .slice(0, 4);
  $("#attention-list").innerHTML =
    attention
      .map(
        (repo) =>
          `<div class="attention-row"><span class="repo-icon">${icon("repo")}</span><div class="attention-name">${link(repo, escapeHtml(repo.name))}<small>${escapeHtml(repo.primaryLanguage?.name || "No primary language")} · ${escapeHtml(age(repo.pushedAt))}</small></div>${repo.issues.totalCount ? workButton(repo, "issues", icon("issue") + countLabel(repo.issues.totalCount, "issue"), "issue-badge") : ""}${repo.pullRequests.totalCount ? workButton(repo, "prs", icon("pr") + fmt(repo.pullRequests.totalCount) + " PR", "pr-badge") : ""}</div>`,
      )
      .join("") ||
    `<div class="panel-empty">${sync.state.sections.repositories.status === "complete" ? "All clear. No open issues or pull requests on active repositories." : "Loading repository activity…"}</div>`;
  const popular = [...repos]
    .sort(
      (a, b) =>
        b.stargazerCount - a.stargazerCount || a.name.localeCompare(b.name),
    )
    .slice(0, 4);
  const max = Math.max(1, ...popular.map((r) => r.stargazerCount));
  $("#popular-list").innerHTML =
    popular
      .map(
        (repo, i) =>
          `<div class="popular-row"><span class="rank">0${i + 1}</span><div class="popular-detail">${link(repo, escapeHtml(repo.name), "", "popular-name")}<div class="popularity-track"><span class="popularity-bar" data-width="${(repo.stargazerCount / max) * 100}"></span></div></div><span class="star-count">${icon("star")}${fmt(repo.stargazerCount)}</span></div>`,
      )
      .join("") ||
    `<div class="panel-empty">${sync.state.sections.repositories.status === "complete" ? "Your next projects will appear here." : "Loading repositories…"}</div>`;
  $$(".popularity-bar").forEach((bar) => {
    bar.style.width = bar.dataset.width + "%";
  });
}

function renderLanguages(repos: Repository[]) {
  const counts = new Map<string, { count: number; color: string }>();
  for (const repo of repos) {
    const name = repo.primaryLanguage?.name || "Other";
    const previous = counts.get(name);
    counts.set(name, {
      count: (previous?.count || 0) + 1,
      color: safeColor(repo.primaryLanguage?.color),
    });
  }
  const sorted = [...counts].sort((a, b) => b[1].count - a[1].count);
  $("#language-chart").replaceChildren();
  $("#language-legend").replaceChildren();
  for (const [index, [name, { count, color }]] of sorted.entries()) {
    const segment = document.createElement("span");
    segment.style.flexGrow = String(count);
    segment.style.backgroundColor = color;
    segment.title = `${name}: ${count} repositories`;
    $("#language-chart").append(segment);
    const label = document.createElement("span");
    label.className = "lang";
    label.hidden =
      index >= 6 &&
      $("#language-toggle").getAttribute("aria-expanded") !== "true";
    label.innerHTML = `<span class="lang-dot"></span>${escapeHtml(name)} <span>${fmt(count)}</span>`;
    label.querySelector<HTMLElement>(".lang-dot")!.style.backgroundColor =
      color;
    $("#language-legend").append(label);
  }
  $("#language-toggle").hidden = sorted.length <= 6;
  $("#language-toggle").textContent =
    $("#language-toggle").getAttribute("aria-expanded") === "true"
      ? "Show fewer languages"
      : `Show all ${sorted.length} languages`;
}

function restoreRepositoryPreferences() {
  const prefs = readPreferences(`${scope}/repositories`);
  $<HTMLInputElement>("#search").value = savedText(prefs.search);
  const language = savedText(prefs.language);
  $<HTMLSelectElement>("#language").replaceChildren(
    new Option("All languages", ""),
    ...(language ? [new Option(language, language)] : []),
  );
  $<HTMLSelectElement>("#language").value = language;
  $<HTMLSelectElement>("#repository-type").value = savedChoice(
    prefs.type,
    ["all", "original", "forks"],
    "all",
  );
  $<HTMLInputElement>("#archived").checked = prefs.archived === true;
  $("#language-toggle").setAttribute(
    "aria-expanded",
    String(prefs.languagesExpanded === true),
  );
}
function saveRepositoryPreferences() {
  if (!scope) return;
  savePreferences(`${scope}/repositories`, {
    search: $<HTMLInputElement>("#search").value.slice(0, 500),
    language: $<HTMLSelectElement>("#language").value,
    type: $<HTMLSelectElement>("#repository-type").value,
    archived: $<HTMLInputElement>("#archived").checked,
    languagesExpanded:
      $("#language-toggle").getAttribute("aria-expanded") === "true",
  });
}
function restoreSort() {
  const prefs = readPreferences(`${scope}/sort/${state.view}`);
  sortKey = savedChoice(
    prefs.key,
    sortKeys,
    state.view === "popular" ? "stars" : "activity",
  );
  sortDirection = savedChoice(
    prefs.direction,
    ["ascending", "descending"],
    "descending",
  );
  updateSortHeaders();
}
function updateSortHeaders() {
  $$("[data-sort]").forEach((button) => {
    const th = button.closest("th")!;
    const active = button.dataset.sort === sortKey;
    if (active) th.setAttribute("aria-sort", sortDirection);
    else th.removeAttribute("aria-sort");
    const next =
      active && sortDirection === "ascending"
        ? "descending"
        : active
          ? "ascending"
          : button.dataset.sort === "name" || button.dataset.sort === "language"
            ? "ascending"
            : "descending";
    button.setAttribute(
      "aria-label",
      `${button.textContent?.trim()}. Sort ${next}`,
    );
  });
}

function setView(view: View, scroll = true, repository?: string) {
  state.view = view;
  restoreSort();
  if (state.data)
    savePreferences("navigation", {
      viewer: state.data.viewer.login,
      owner: state.data.owner.login,
      view,
    });
  renderView(repository);
  const url = new URL(location.href);
  url.searchParams.set("view", view);
  if (url.href !== location.href) history.replaceState(null, "", url);
  void load(sync.state.owner);
  if (scroll) {
    $("#page-title").focus({ preventScroll: true });
    window.scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
}

// Refresh data without resetting the user's filters or sorting choices.
function renderView(repository?: string) {
  const view = state.view;
  $("#repositories-section").dataset.currentView = view;
  const titles = {
    overview: "Overview",
    repositories: "Repositories",
    issues: "Open issues",
    prs: "Pull requests",
    popular: "Most popular",
  };
  $("#page-title").textContent = titles[view];
  const isWorkView = view === "issues" || view === "prs";
  $("#repo-section-title").textContent =
    view === "popular" ? "Most popular" : "Repositories";
  $("#page-subtitle").textContent = isWorkView
    ? "Find a conversation, then select its title to work on it on GitHub."
    : view === "overview"
      ? "Your projects, their activity, and what needs your attention."
      : `Repositories owned by ${state.data?.owner.login || "your account"}.`;
  $("#repositories-section").hidden = isWorkView;
  $("#work-section").hidden = !isWorkView;
  $("#sync-time").hidden = isWorkView;
  if (isWorkView) inbox.show(view, repository);
  else inbox.hide();
  $("#overview-panels").hidden = view !== "overview";
  $(".stats").hidden = view !== "overview";
  $(".language-strip").hidden = view !== "overview";
  $$("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (button.classList.contains("nav-item")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  renderTable();
}

function renderTable() {
  if (!state.data) return;
  const query = $<HTMLInputElement>("#search").value.trim().toLocaleLowerCase();
  const language = $<HTMLSelectElement>("#language").value;
  const type = $<HTMLSelectElement>("#repository-type").value;
  const showArchives = $<HTMLInputElement>("#archived").checked;
  const all = state.data.owner.repositories;
  const rows = all.filter((repo) => {
    if (!showArchives && repo.isArchived) return false;
    if (language && repo.primaryLanguage?.name !== language) return false;
    if (
      query &&
      ![repo.name, repo.description || ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query)
    )
      return false;
    if (type === "original" && repo.isFork) return false;
    if (type === "forks" && !repo.isFork) return false;
    return true;
  });
  rows.sort((a, b) => {
    const score =
      sortKey === "name"
        ? a.name.localeCompare(b.name)
        : sortKey === "language"
          ? (a.primaryLanguage?.name || "").localeCompare(
              b.primaryLanguage?.name || "",
            )
          : sortKey === "stars"
            ? a.stargazerCount - b.stargazerCount
            : sortKey === "issues"
              ? a.issues.totalCount - b.issues.totalCount
              : sortKey === "prs"
                ? a.pullRequests.totalCount - b.pullRequests.totalCount
                : (a.pushedAt || "").localeCompare(b.pushedAt || "");
    return (
      score * (sortDirection === "ascending" ? 1 : -1) ||
      a.name.localeCompare(b.name)
    );
  });
  updateSortHeaders();
  const focused =
    document.activeElement instanceof HTMLElement &&
    $("#repo-rows").contains(document.activeElement)
      ? document.activeElement
      : null;
  const focusedRow = focused?.closest<HTMLElement>("tr")?.dataset.repository;
  const focusedAction = focused?.dataset.workKind || focused?.className;
  $("#repo-rows").innerHTML = rows
    .map(
      (repo) =>
        `<tr data-repository="${escapeHtml(repo.nameWithOwner)}"><td><div class="repo-name-line">${link(repo, escapeHtml(repo.name), "", "repo-name")}${repo.isPrivate ? icon("lock") + '<span class="sr-only">Private</span>' : ""}${repo.isFork ? '<span class="repo-tag">Fork</span>' : ""}${repo.isArchived ? '<span class="repo-tag">Archived</span>' : ""}${sync.state.sections.repositories.pending.has(repo.nameWithOwner) ? '<span class="repo-tag">Not yet refreshed</span>' : ""}</div><div class="repo-description" title="${escapeHtml(repo.description)}">${escapeHtml(repo.description || "No description")}</div></td><td><span class="lang"><span class="lang-dot" data-color="${safeColor(repo.primaryLanguage?.color)}"></span>${escapeHtml(repo.primaryLanguage?.name || "—")}</span></td><td class="number">${fmt(repo.stargazerCount)}</td><td class="number">${workButton(repo, "issues", icon("issue") + fmt(repo.issues.totalCount), "numeric-link" + (repo.issues.totalCount ? " issue-active" : ""))}</td><td class="number">${workButton(repo, "prs", icon("pr") + fmt(repo.pullRequests.totalCount), "numeric-link" + (repo.pullRequests.totalCount ? " pr-active" : ""))}</td><td class="date-col" title="${escapeHtml(repo.pushedAt || "")}">${escapeHtml(age(repo.pushedAt))}</td><td>${link(repo, icon("external"), "", "external-link", "Open " + repo.name + " on GitHub")}</td></tr>`,
    )
    .join("");
  if (focusedRow && document.activeElement === document.body) {
    const row = Array.from(
      $("#repo-rows").querySelectorAll<HTMLTableRowElement>("tr"),
    ).find((row) => row.dataset.repository === focusedRow);
    const action =
      row &&
      Array.from(row.querySelectorAll<HTMLElement>("a, button")).find(
        (node) => (node.dataset.workKind || node.className) === focusedAction,
      );
    (action || $("#page-title")).focus({ preventScroll: true });
  }
  $$(".lang-dot[data-color]").forEach((dot) => {
    dot.style.backgroundColor = safeColor(dot.dataset.color);
  });
  $("#result-count").textContent = countLabel(
    rows.length,
    "repository",
    "repositories",
  );
  $("#table-summary").textContent =
    `${fmt(rows.length)} of ${fmt(all.length)} repositories shown`;
  $("#empty").hidden =
    rows.length > 0 || sync.state.sections.repositories.status !== "complete";
}

$$("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    const view = views.find((view) => view === button.dataset.view);
    if (state.data && view) setView(view);
  }),
);
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>("[data-work-kind]");
  const kind = button?.dataset.workKind;
  if (state.data && (kind === "issues" || kind === "prs"))
    setView(kind, true, button?.dataset.repository);
});
$("#language-toggle").addEventListener("click", () => {
  const expanded =
    $("#language-toggle").getAttribute("aria-expanded") !== "true";
  $("#language-toggle").setAttribute("aria-expanded", String(expanded));
  saveRepositoryPreferences();
  if (state.data) renderLanguages(state.data.owner.repositories);
});
$<HTMLInputElement>("#search").addEventListener("input", () => {
  saveRepositoryPreferences();
  renderTable();
});
["#language", "#archived", "#repository-type"].forEach((selector) =>
  $(selector).addEventListener("change", () => {
    saveRepositoryPreferences();
    renderTable();
  }),
);
$$("[data-sort]").forEach((button) =>
  button.addEventListener("click", () => {
    const next = savedChoice(button.dataset.sort, sortKeys, "name");
    sortDirection =
      next === sortKey
        ? sortDirection === "ascending"
          ? "descending"
          : "ascending"
        : next === "name" || next === "language"
          ? "ascending"
          : "descending";
    sortKey = next;
    if (scope)
      savePreferences(`${scope}/sort/${state.view}`, {
        key: sortKey,
        direction: sortDirection,
      });
    renderTable();
  }),
);
$<HTMLButtonElement>("#refresh").addEventListener("click", () =>
  load(sync.state.owner, true),
);
$("#reset-filters").addEventListener("click", () => {
  $<HTMLInputElement>("#search").value = "";
  $<HTMLSelectElement>("#language").value = "";
  $<HTMLInputElement>("#archived").checked = false;
  $<HTMLSelectElement>("#repository-type").value = "all";
  saveRepositoryPreferences();
  setView("repositories", false);
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(
      document.activeElement?.tagName || "",
    ) &&
    !$("#dashboard").hidden
  ) {
    event.preventDefault();
    $(
      state.view === "issues" || state.view === "prs"
        ? "#work-search"
        : "#search",
    ).focus();
  }
});
$("#sync-retry").addEventListener(
  "click",
  () => void load(sync.state.owner, true),
);
function revalidate() {
  if (!document.hidden && sync.state.phase !== "error")
    void load(sync.state.owner);
}
window.addEventListener("focus", revalidate);
document.addEventListener("visibilitychange", revalidate);
setInterval(revalidate, 30_000);
renderView();
void load(initialOwner);
