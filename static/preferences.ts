// Persist interface choices only: GitHub responses and credentials stay out of storage.
const storageKey = "forge.preferences";
const limit = 64;
type Fields = Record<string, string | boolean | number>;
let records: Record<string, Fields> = Object.create(null) as Record<
  string,
  Fields
>;
try {
  const raw = localStorage.getItem(storageKey);
  const parsed: unknown = raw && raw.length <= 100_000 ? JSON.parse(raw) : null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed).slice(-limit)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      records[key] = Object.fromEntries(
        Object.entries(value).filter(
          ([field, item]) =>
            field.length <= 64 &&
            (typeof item === "boolean" ||
              (typeof item === "string" && item.length <= 500) ||
              (typeof item === "number" && Number.isFinite(item))),
        ),
      ) as Fields;
    }
  }
} catch {
  /* Storage may be disabled or contain obsolete preferences. */
}

export function preferenceScope(viewer: string, owner: string) {
  return `${viewer.toLowerCase()}/${owner.toLowerCase()}`;
}
export function readPreferences(key: string): Fields {
  return Object.hasOwn(records, key) ? { ...records[key] } : {};
}
export function savePreferences(key: string, values: Fields) {
  delete records[key];
  records = Object.fromEntries(
    [...Object.entries(records), [key, values]].slice(-limit),
  );
  try {
    localStorage.setItem(storageKey, JSON.stringify(records));
  } catch {
    /* In-memory preferences still work when storage is unavailable. */
  }
}
export function savedText(value: unknown) {
  return typeof value === "string" ? value : "";
}
export function savedChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return choices.find((choice) => choice === value) ?? fallback;
}
