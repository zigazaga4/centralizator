/**
 * CRUD for collaborators + commission-bonus editing, for EVERY city.
 *
 *   GET    /collaborators        → { collaborators: custom[], bonuses: {key:pct} }
 *   POST   /collaborators        → create one { label, city, bonusPct? }
 *   PATCH  /collaborators/:key    → set its bonus { bonusPct, label, city }
 *   DELETE /collaborators/:key   → remove a custom one / revert a built-in
 *
 * The built-in roster itself is NOT listed here (the client knows it
 * statically); this endpoint carries the runtime ADDITIONS plus the effective
 * bonus for every collaborator (built-in defaults + operator overrides). Any
 * mutation re-prices the whole ready queue so payouts reflect it immediately.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createCollaborator,
  customCollaborators,
  effectiveBonuses,
  extraCollaboratorInputs,
  removeCollaborator,
  setCollaboratorBonusPct,
  CUSTOM_COLLABORATOR_CITIES,
} from "../collaborators.js";
import { buildPricingInput } from "../pipeline.js";
import { calculatePrice } from "../pricing.js";
import { readyPairPricingRows, updatePairBreakdownJson } from "../db.js";
import type { Extracted } from "../schema.js";

const CreateSchema = z.object({
  label: z.string().trim().min(1, "Numele colaboratorului nu poate fi gol.").max(80),
  city: z.enum(CUSTOM_COLLABORATOR_CITIES).default("Constanta"),
  // Bonus is a FRACTION (0.25 = 25%); default 0.
  bonusPct: z.number().min(0).max(5).default(0),
});

const SetBonusSchema = z.object({
  bonusPct: z.number().min(0).max(5),
  // Needed only when a built-in is overridden for the first time (so the stored
  // row is complete); ignored for an existing row.
  label: z.string().trim().min(1).max(80),
  city: z.enum(CUSTOM_COLLABORATOR_CITIES),
});

/**
 * Re-price every ready pair against the current collaborator registry, so a
 * new collaborator's payout column (or a changed bonus) lands on all existing
 * breakdowns at once. Pure math over the stored edits — no OCR, no image load
 * — and preserves each pair's own overrides. Returns how many were re-priced.
 */
function repriceAllReady(): number {
  const extras = extraCollaboratorInputs();
  let n = 0;
  for (const row of readyPairPricingRows()) {
    if (!row.edits_json || !row.service) continue;
    try {
      const edits = JSON.parse(row.edits_json) as Extracted;
      const prev = row.breakdown_json ? JSON.parse(row.breakdown_json) : {};
      const routing = row.routing_json ? JSON.parse(row.routing_json) : null;
      const macaraStore = row.store ?? routing?.store ?? null;
      const breakdown = calculatePrice({
        ...buildPricingInput(edits, row.service, {
          distanceKm: edits.awb.distance_extra_km,
          weekendBasis: row.day,
          macaraStore,
          forceWeekend: prev.weekendForced ?? false,
          extraCollaborators: extras,
        }),
        macaraForceNormal: prev.macara?.forcedNormal ?? false,
        macaraForceOn: prev.macara?.forcedOn ?? false,
        unloadingManualExtra: prev.unloadingManualExtra ?? 0,
      });
      updatePairBreakdownJson(row.id, JSON.stringify(breakdown));
      n += 1;
    } catch {
      /* skip a malformed pair — never let one bad row abort the sweep */
    }
  }
  return n;
}

export default async function collaboratorRoutes(app: FastifyInstance) {
  app.get("/collaborators", async (_req, reply) => {
    return reply.send({
      collaborators: customCollaborators(),
      bonuses: effectiveBonuses(),
    });
  });

  app.post("/collaborators", async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    try {
      const created = createCollaborator(parsed.data);
      const repriced = repriceAllReady();
      return reply.code(201).send({ collaborator: created, repriced });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.patch<{ Params: { key: string } }>("/collaborators/:key", async (req, reply) => {
    const parsed = SetBonusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    try {
      setCollaboratorBonusPct({ key: req.params.key, ...parsed.data });
      const repriced = repriceAllReady();
      return reply.send({ key: req.params.key, bonusPct: parsed.data.bonusPct, repriced });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { key: string } }>("/collaborators/:key", async (req, reply) => {
    const removed = removeCollaborator(req.params.key);
    if (!removed) {
      return reply.code(404).send({ error: `Colaboratorul '${req.params.key}' nu există.` });
    }
    const repriced = repriceAllReady();
    return reply.send({ removed: req.params.key, repriced });
  });
}
