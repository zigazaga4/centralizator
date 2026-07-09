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
  setCollaboratorBonus,
  deleteCollaborator,
  type CustomCollaborator,
} from "./db.js";
import { COLLABORATORS, COLLABORATOR_BONUS_BY_NAME } from "./tariffs.js";

/** The built-in roster keys (bonus defaults live in tariffs.ts). */
const BUILTIN_KEYS = new Set<string>(COLLABORATORS as readonly string[]);

/** Cities a collaborator may belong to — the app's four dispatch series.
 *  Collaborators (and bonus edits) are allowed in ALL of them now. */
export const CUSTOM_COLLABORATOR_CITIES = ["Ploiesti", "Iasi", "Iasi2", "Constanta"] as const;
export type CustomCollaboratorCity = (typeof CUSTOM_COLLABORATOR_CITIES)[number];

/** Sanity cap on a stored bonus fraction (0..5 = 0..500%). */
function clampPct(p: number): number {
  return Number.isFinite(p) ? Math.min(5, Math.max(0, p)) : 0;
}

// Every stored row: user-created collaborators AND bonus-override rows for
// built-ins (a row whose key is a built-in overrides that built-in's bonus).
let cache: CustomCollaborator[] = [];

/** (Re)load the stored collaborators/overrides from SQLite into memory. Call
 *  at startup and after every mutation. */
export function loadCollaborators(): void {
  cache = listCollaborators();
}

/** The rows the operator ADDED — a key that is NOT in the built-in roster.
 *  Bonus-override rows (built-in keys) are excluded; they aren't new partners,
 *  just a changed percentage on an existing one. */
export function customCollaborators(): CustomCollaborator[] {
  return cache.filter((c) => !BUILTIN_KEYS.has(c.key));
}

/** Every stored row as `{ key, pct }`, fed to calculatePrice as
 *  `extraCollaborators`. It is spread AFTER the built-in roster and de-duped
 *  last-wins, so a row for a BUILT-IN key overrides that built-in's bonus and
 *  a row for a NEW key adds a custom collaborator — one mechanism, both jobs. */
export function extraCollaboratorInputs(): { key: string; pct: number }[] {
  return cache.map((c) => ({ key: c.key, pct: c.bonusPct }));
}

/** Effective bonus for EVERY collaborator (built-in defaults, then overrides,
 *  then customs) as key → fraction. The client shows and edits these. */
export function effectiveBonuses(): Record<string, number> {
  const out: Record<string, number> = { ...COLLABORATOR_BONUS_BY_NAME };
  for (const c of cache) out[c.key] = c.bonusPct;
  return out;
}

/** Is this a known collaborator key — a built-in OR a user-created one?
 *  Replaces the old static `.enum(COLLABORATORS)` validation now that the
 *  roster is dynamic. */
export function isKnownCollaborator(key: string): boolean {
  return BUILTIN_KEYS.has(key) || cache.some((c) => c.key === key);
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
    bonusPct: clampPct(input.bonusPct ?? 0),
  });
  loadCollaborators();
  return created;
}

/** Set a collaborator's commission bonus (fraction). Works for a custom
 *  collaborator (updates its row) OR a built-in (stored as an override row —
 *  `label`/`city` are used only when a built-in is overridden the first time;
 *  the client supplies them so the row is complete). */
export function setCollaboratorBonusPct(input: {
  key: string;
  bonusPct: number;
  label: string;
  city: string;
}): void {
  if (!isKnownCollaborator(input.key)) {
    throw new Error(`Colaborator necunoscut: ${input.key}`);
  }
  setCollaboratorBonus({
    key: input.key,
    label: input.label,
    city: input.city,
    bonusPct: clampPct(input.bonusPct),
  });
  loadCollaborators();
}

/** Delete a collaborator by key. For a custom collaborator this removes it; for
 *  a built-in this drops its override row, reverting the bonus to the tariffs.ts
 *  default. Refreshes the cache. False if the key had no stored row. */
export function removeCollaborator(key: string): boolean {
  const ok = deleteCollaborator(key);
  if (ok) loadCollaborators();
  return ok;
}
