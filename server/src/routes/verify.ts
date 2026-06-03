/**
 * POST /verify — cross-check a pair's invoice products against
 * leroymerlin.ro and return the verification report (size + weight,
 * with the `hasWarning` flag that drives the client's warning icon).
 *
 * Stateless like /extract-and-price: the caller owns persistence. The
 * client runs this right after a pair goes "ready", then merges the
 * returned `verification` into that pair's status and persists it via
 * PUT /pairs/:id/status — so the cross-check survives a reload.
 *
 * Heavy lifting (search + scrape + compare) lives in verify.ts; the
 * persistent product cache (db.ts) keeps repeat codes free.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ExtractedSchema, type Verification } from "../schema.js";
import { verifyShipment } from "../verify.js";
import { scrapingdogConfigured } from "../scrapingdog.js";

const VerifyRequestSchema = z.object({ extracted: ExtractedSchema });

export default async function verifyRoutes(app: FastifyInstance) {
  app.post("/verify", async (req, reply) => {
    const parsed = VerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }

    if (!scrapingdogConfigured()) {
      // No key → return a benign report so the client simply shows
      // "neverificat" instead of an error. Never blocks the workflow.
      const verification: Verification = {
        checkedAt: Date.now(),
        items: [],
        awbWeightKg: parsed.data.extracted.awb.weight_kg,
        estimatedWeightKg: null,
        weightCoverage: "none",
        weightStatus: "unknown",
        hasWarning: false,
        note: "Verificarea produselor este dezactivată (SCRAPINGDOG_API_KEY lipsește).",
      };
      return reply.send({ verification });
    }

    try {
      const verification = await verifyShipment(parsed.data.extracted);
      return reply.send({ verification });
    } catch (err) {
      req.log.error({ err }, "Product verification failed");
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
