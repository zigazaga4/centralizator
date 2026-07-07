/**
 * Registry for USER-CREATED collaborators (Constanța-only today). The
 * built-in roster is the static COLLABORATORS in tariffs.ts; this module
 * layers the operator's runtime additions on top.
 *
 * The list is cached in memory (loaded from SQLite at startup and after every
 * mutation) so the hot paths — pricing every pair, validating an uploaded
 * collaborator key — never hit the DB per call. calculatePrice stays PURE:
 * the server injects `extraCollaboratorInputs()` into the PricingInput; the
 * engine itself never reads this module.
 */
import {
  listCollaborators,
  insertCollaborator,
  deleteCollaborator,
  type CustomCollaborator,
} from "./db.js";
import { COLLABORATORS } from "./tariffs.js";

/** Cities a custom collaborator may belong to. Constanța-only for now — the
 *  other series carry fixed, negotiated collaborator rosters. */
export const CUSTOM_COLLABORATOR_CITIES = ["Constanta"] as const;
export type CustomCollaboratorCity = (typeof CUSTOM_COLLABORATOR_CITIES)[number];

let cache: CustomCollaborator[] = [];

/** (Re)load the user-created collaborators from the DB into memory. Call at
 *  startup and after every create/delete. */
export function loadCollaborators(): void {
  cache = listCollaborators();
}

/** The cached user-created collaborators (oldest first). */
export function customCollaborators(): readonly CustomCollaborator[] {
  return cache;
}

/** The {key, pct} rows to feed calculatePrice so each custom collaborator gets
 *  its own payout row. Constanța customs are 0% → their total equals the pure
 *  carrier total, exactly like the built-in Constanța five. */
export function extraCollaboratorInputs(): { key: string; pct: number }[] {
  return cache.map((c) => ({ key: c.key, pct: c.bonusPct }));
}

/** Is this a known collaborator key — a built-in OR a user-created one?
 *  Replaces the old static `.enum(COLLABORATORS)` validation now that the
 *  roster is dynamic. */
export function isKnownCollaborator(key: string): boolean {
  return (
    (COLLABORATORS as readonly string[]).includes(key) ||
    cache.some((c) => c.key === key)
  );
}

/** Turn a free-text display name into a stable machine key: ASCII-folded,
 *  PascalCase, alphanumerics only. */
export function slugifyCollaboratorKey(label: string): string {
  const base = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return base || "Colaborator";
}

/** A key for `label` that collides with neither a built-in nor an existing
 *  custom collaborator (numeric suffix on clash). */
function uniqueKey(label: string): string {
  const base = slugifyCollaboratorKey(label);
  const taken = new Set<string>([
    ...(COLLABORATORS as readonly string[]),
    ...cache.map((c) => c.key),
  ]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Create a custom collaborator from an operator-typed name: trims + validates
 *  the label, generates a unique key, persists, refreshes the cache, returns
 *  the row. Throws on an empty label. Duplicate LABELS are allowed (two people
 *  with the same name get distinct keys). */
export function createCollaborator(input: {
  label: string;
  city: CustomCollaboratorCity;
  bonusPct?: number;
}): CustomCollaborator {
  const label = input.label.trim();
  if (!label) throw new Error("Numele colaboratorului nu poate fi gol.");
  const created = insertCollaborator({
    key: uniqueKey(label),
    label,
    city: input.city,
    bonusPct: input.bonusPct ?? 0,
  });
  loadCollaborators();
  return created;
}

/** Delete a custom collaborator (built-ins aren't in this table, so they can't
 *  be deleted here). Refreshes the cache. False if the key didn't exist. */
export function removeCollaborator(key: string): boolean {
  const ok = deleteCollaborator(key);
  if (ok) loadCollaborators();
  return ok;
}
