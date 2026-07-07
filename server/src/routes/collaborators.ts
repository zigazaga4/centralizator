/**
 * CRUD for USER-CREATED collaborators (Constanța-only today).
 *
 *   GET    /collaborators        → list the operator's custom collaborators
 *   POST   /collaborators        → create one { label, city?, bonusPct? }
 *   DELETE /collaborators/:key   → remove one
 *
 * The built-in roster (tariffs.ts COLLABORATORS) is NOT served here — the
 * client already knows it statically. This endpoint only carries the runtime
 * additions, which the app merges into the Constanța collaborator dropdown.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createCollaborator,
  customCollaborators,
  removeCollaborator,
  CUSTOM_COLLABORATOR_CITIES,
} from "../collaborators.js";

const CreateSchema = z.object({
  label: z.string().trim().min(1, "Numele colaboratorului nu poate fi gol.").max(80),
  // Constanța-only for now; default it so the client can omit it.
  city: z.enum(CUSTOM_COLLABORATOR_CITIES).default("Constanta"),
  // Reserved for future non-Constanța series; defaults to 0 (no bonus).
  bonusPct: z.number().min(0).max(1).default(0),
});

export default async function collaboratorRoutes(app: FastifyInstance) {
  app.get("/collaborators", async (_req, reply) => {
    return reply.send({ collaborators: customCollaborators() });
  });

  app.post("/collaborators", async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    try {
      const created = createCollaborator(parsed.data);
      return reply.code(201).send({ collaborator: created });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { key: string } }>("/collaborators/:key", async (req, reply) => {
    const removed = removeCollaborator(req.params.key);
    if (!removed) {
      return reply.code(404).send({ error: `Colaboratorul '${req.params.key}' nu există.` });
    }
    return reply.send({ removed: req.params.key });
  });
}
