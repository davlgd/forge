export const hostedLogin =
  document.documentElement.dataset.authMode === "proxy";

export function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing interface element: ${selector}`);
  return element;
}

export const $$ = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(selector),
];
const number = new Intl.NumberFormat("en-US");
const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
export const fmt = (value: number) => number.format(value);
export const countLabel = (count: number, noun: string, plural = noun + "s") =>
  `${fmt(count)} ${count === 1 ? noun : plural}`;
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
export const icon = (name: string, cls = "") =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const safeColor = (color: string | null | undefined) =>
  color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#b5abc8";

export function age(value: string | null) {
  if (!value) return "No pushes";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "—";
  const days = Math.trunc((time - Date.now()) / 86400000);
  if (Math.abs(days) < 1) return "today";
  if (Math.abs(days) < 30) return relative.format(days, "day");
  if (Math.abs(days) < 365)
    return relative.format(Math.trunc(days / 30), "month");
  return relative.format(Math.trunc(days / 365), "year");
}
