// Apply the saved preference before CSS paints; CSS follows the system by default.
export {};

(() => {
  "use strict";
  const key = "forge.theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  type Theme = "system" | "light" | "dark";
  const valid = (value: string | null): Theme =>
    value === "light" || value === "dark" ? value : "system";
  let preference: Theme = "system";
  try {
    preference = valid(localStorage.getItem(key));
  } catch {
    // A blocked storage area must not prevent the dashboard from loading.
  }

  function apply() {
    root.dataset.theme = preference;
    const dark =
      preference === "dark" || (preference === "system" && system.matches);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#10121b" : "#f8f9fc");
    for (const radio of document.querySelectorAll<HTMLInputElement>(
      'input[name="theme"]',
    )) {
      radio.checked = radio.value === preference;
    }
  }

  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue);
      apply();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document
      .querySelector(".theme-options")
      ?.addEventListener("change", (event) => {
        if (
          !(event.target instanceof HTMLInputElement) ||
          event.target.name !== "theme"
        )
          return;
        preference = valid(event.target.value);
        try {
          if (preference === "system") localStorage.removeItem(key);
          else localStorage.setItem(key, preference);
        } catch {
          // The selected theme still works for this page when persistence is unavailable.
        }
        apply();
      });
  });
})();
