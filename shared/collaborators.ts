/**
 * Collaborator roster shared by the upload surfaces (phone scanner +
 * any future thin client). The five canonical keys MIRROR:
 *   • server/src/tariffs.ts  → `Collaborator` / `COLLABORATORS`
 *     (the server validates every uploaded key against that list), and
 *   • app/src/types.ts       → `CollaboratorKey` / `COLLABORATOR_LABEL`
 *     (the desktop app's full city-aware model).
 * Keep all three in sync — the key is the machine-friendly company
 * name; the label adds the contact person for recognisability.
 */

export type CollaboratorKey =
  | "Stalexone"
  | "EMV"
  | "Bitlo"
  | "VicDinamicExpert"
  | "Tiberiu";

export const COLLABORATOR_KEYS: readonly CollaboratorKey[] = [
  "Stalexone",
  "EMV",
  "Bitlo",
  "VicDinamicExpert",
  "Tiberiu",
];

export const COLLABORATOR_LABEL: Record<CollaboratorKey, string> = {
  Stalexone: "Stalexone (Ștefan)",
  EMV: "EMV (Escariu)",
  Bitlo: "Bitlo (George)",
  VicDinamicExpert: "Vic Dinamic Expert (Bogdan)",
  Tiberiu: "Tiberiu (Dube)",
};
