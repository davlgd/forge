import type { Account, Dashboard } from "./types";
import { $ } from "./ui";

function avatar(node: HTMLElement, account: Account) {
  const signature = `${account.login}:${account.avatarUrl}`;
  if (node.dataset.avatar === signature) return;
  node.dataset.avatar = signature;
  const initial = account.login.slice(0, 1).toUpperCase();
  node.textContent = initial;
  try {
    const url = new URL(account.avatarUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "avatars.githubusercontent.com"
    )
      return;
    const image = document.createElement("img");
    image.src = url.href;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener(
      "error",
      () => {
        if (node.dataset.avatar === signature) node.textContent = initial;
      },
      { once: true },
    );
    node.replaceChildren(image);
  } catch {
    // Accounts without an avatar use their initial.
  }
}

export function createMenus(onOwnerChange: (owner: string) => void) {
  const ownerToggle = $<HTMLButtonElement>("#owner-toggle");
  const ownerPanel = $("#owner-panel");
  const profileToggle = $<HTMLButtonElement>("#profile-toggle");
  const profilePanel = $("#profile-panel");
  const options = $("#owner-options");
  const panels = [
    { toggle: ownerToggle, panel: ownerPanel },
    { toggle: profileToggle, panel: profilePanel },
  ];
  let pointerInside = false;
  let hasContext = false;
  let accountSignature = "";

  function close(returnFocus = false) {
    for (const { toggle, panel } of panels) {
      if (panel.hidden) continue;
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (returnFocus) toggle.focus();
    }
  }

  function position(toggle: HTMLElement, panel: HTMLElement) {
    const rect = toggle.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const top = Math.max(
      12,
      Math.min(rect.bottom + 8, window.innerHeight - 80),
    );
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(toggle === profileToggle ? rect.right - width : rect.left, window.innerWidth - width - 12))}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(64, window.innerHeight - top - 12)}px`;
  }

  for (const { toggle, panel } of panels) {
    toggle.addEventListener("click", () => {
      const opening = panel.hidden;
      close();
      if (opening) {
        panel.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        position(toggle, panel);
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panels.some(({ panel }) => !panel.hidden)) {
      event.preventDefault();
      close(true);
    }
  });
  for (const type of ["pointerdown", "mousedown"]) {
    document.addEventListener(type, (event) => {
      const target = event.target;
      pointerInside =
        target instanceof Node &&
        panels.some(
          ({ toggle, panel }) =>
            toggle.contains(target) || panel.contains(target),
        );
      if (!pointerInside) close();
    });
  }
  for (const type of ["pointerup", "mouseup", "pointercancel"]) {
    document.addEventListener(type, () => {
      pointerInside = false;
    });
  }
  document.addEventListener("focusin", (event) => {
    // Clicking a label can focus the main landmark before activating its radio.
    if (pointerInside) return;
    if (!(event.target instanceof Node)) return;
    const target = event.target;
    if (
      !panels.some(
        ({ toggle, panel }) =>
          toggle.contains(target) || panel.contains(target),
      )
    )
      close();
  });
  window.addEventListener("resize", () => {
    for (const { toggle, panel } of panels)
      if (!panel.hidden) position(toggle, panel);
  });
  window.addEventListener(
    "scroll",
    () => {
      for (const { toggle, panel } of panels)
        if (!panel.hidden) position(toggle, panel);
    },
    { passive: true },
  );

  options.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-owner]")
        : null;
    if (!button?.dataset.owner) return;
    close(true);
    onOwnerChange(button.dataset.owner);
  });

  return {
    update(data: Dashboard) {
      hasContext = true;
      ownerToggle.disabled = false;
      const { viewer, owner, mode } = data;
      const accounts: Account[] = [viewer, ...viewer.organizations];
      if (
        !accounts.some(
          (account) =>
            account.login.toLowerCase() === owner.login.toLowerCase(),
        )
      )
        accounts.push(owner);
      const signature = JSON.stringify(
        accounts.map((account) => [account.login, account.avatarUrl]),
      );
      if (signature !== accountSignature) {
        accountSignature = signature;
        options.replaceChildren(
          ...accounts.map((account) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.owner = account.login;
            const photo = document.createElement("span");
            photo.className = "avatar small";
            photo.setAttribute("aria-hidden", "true");
            avatar(photo, account);
            const label = document.createElement("span");
            label.textContent = account.login;
            if (account.login === viewer.login) {
              const note = document.createElement("small");
              note.textContent = "Personal account";
              label.append(note);
            }
            button.append(photo, label);
            item.append(button);
            return item;
          }),
        );
      }
      for (const button of options.querySelectorAll<HTMLButtonElement>(
        "button[data-owner]",
      )) {
        button.setAttribute(
          "aria-pressed",
          String(
            button.dataset.owner?.toLowerCase() === owner.login.toLowerCase(),
          ),
        );
      }
      $("#owner-label").textContent = owner.login;
      ownerToggle.setAttribute(
        "aria-label",
        `Workspace: ${owner.login}. Switch account or organization`,
      );
      avatar($("#owner-avatar"), owner);
      avatar($("#profile-avatar"), viewer);
      avatar($("#user-avatar"), viewer);
      $("#user-name").textContent = viewer.name || viewer.login;
      $("#user-login").textContent = `@${viewer.login}`;
      profileToggle.setAttribute(
        "aria-label",
        `Account and appearance for ${viewer.login}`,
      );
      $("#logout").hidden = mode !== "proxy";
    },
    setLoading(loading: boolean, owner?: string) {
      ownerToggle.disabled = !hasContext;
      ownerToggle.setAttribute("aria-busy", String(loading));
      if (owner) {
        $("#owner-label").textContent = owner;
        ownerToggle.setAttribute(
          "aria-label",
          `Workspace: ${owner}. Switch account or organization`,
        );
      }
    },
    close() {
      close();
    },
  };
}
