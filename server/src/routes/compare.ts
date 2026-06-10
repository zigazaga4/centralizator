/**
 * POST /compare-excel — upload the courier's master export ("Main" .xlsx)
 * and get back a field-by-field comparison against this app's ready pairs.
 *
 * Stateless: the upload is parsed in memory, compared against the live pair
 * queue (db.listAllPairsLight — comparison never needs image bytes), and the
 * report is returned. Nothing is persisted —
 * it's a read-only cross-check the operator runs on demand.
 *
 * The heavy lifting (xlsx parse + join + per-field tolerance) lives in
 * compare.ts / xlsx.ts; this handler is just transport: pull the single file
 * part, hand its bytes over, surface a clean 4xx on bad input.
 */

import type { FastifyInstance } from "fastify";
import { compareExcelBuffer } from "../compare.js";
import { listAllPairsLight } from "../db.js";

/** Accepted upload types for the .xlsx (browsers vary on what they tag). */
const ACCEPTED_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "application/zip",
]);

export default async function compareRoutes(app: FastifyInstance) {
  app.post("/compare-excel", async (req, reply) => {
    let buf: Buffer | null = null;
    let fileName: string | null = null;

    // Pull the first file part. Field name doesn't matter; we take the
    // first file and ignore any extra parts.
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const mime = part.mimetype.toLowerCase();
      const looksXlsx =
        ACCEPTED_MIME.has(mime) || /\.xlsx$/i.test(part.filename ?? "");
      if (!looksXlsx) {
        return reply.code(415).send({
          error: `Fișier neacceptat (${mime}). Încarcă exportul .xlsx „Main”.`,
        });
      }
      buf = await part.toBuffer();
      fileName = part.filename ?? null;
      break;
    }

    if (!buf) {
      return reply.code(400).send({ error: "Niciun fișier .xlsx încărcat." });
    }

    try {
      const report = compareExcelBuffer(buf, listAllPairsLight(), fileName);
      return reply.send({ report });
    } catch (err) {
      req.log.error({ err }, "Excel comparison failed");
      return reply.code(422).send({
        error: `Nu am putut citi fișierul Excel: ${(err as Error).message}`,
      });
    }
  });
}
