/**
 * The commercial pipeline.
 *
 * One list, in the order a deal actually moves, so the Kanban columns, the
 * status filter, the CSV export and the stage counters can never disagree
 * about what a stage is called.
 *
 * `Perdu` sits at the end and is deliberately outside the linear flow: a
 * prospect can be lost from any stage, and counting it as "progress" would
 * distort every funnel that follows.
 */

export const STAGES = [
  { id: 'nouveau', label: 'Nouveau prospect', tone: 'blue' },
  { id: 'contact', label: 'Premier contact', tone: 'sky' },
  { id: 'relance', label: 'Relance', tone: 'amber' },
  { id: 'rdv', label: 'Rendez-vous planifié', tone: 'violet' },
  { id: 'negociation', label: 'Négociation', tone: 'orange' },
  { id: 'signe', label: 'Contrat signé', tone: 'green' },
  { id: 'lance', label: 'Projet lancé', tone: 'teal' },
  { id: 'livre', label: 'Projet livré', tone: 'emerald' },
  { id: 'perdu', label: 'Perdu', tone: 'grey' },
];

export const STAGE_IDS = STAGES.map((s) => s.id);

const BY_ID = new Map(STAGES.map((s) => [s.id, s]));

export const isStage = (id) => BY_ID.has(id);
export const stageLabel = (id) => BY_ID.get(id)?.label ?? id ?? '';

/** Where a new lead lands. */
export const FIRST_STAGE = STAGES[0].id;

/** Stages that mean the deal is over, either way. Excluded from "en cours". */
export const CLOSED_STAGES = new Set(['livre', 'perdu']);

/** Stages that count as a won deal, for the funnel and the conversion figures. */
export const WON_STAGES = new Set(['signe', 'lance', 'livre']);

/**
 * The five statuses this project shipped with, mapped onto the new stages.
 *
 * Records written before the pipeline existed carry `status: 'Nouveau'` and
 * friends. Rather than rewriting the log — it is append-only on purpose — the
 * mapping is applied on read, so an old record and a new one are comparable
 * without touching a single byte on disk.
 */
const LEGACY = {
  Nouveau: 'nouveau',
  'Contacté': 'contact',
  'En cours': 'negociation',
  Converti: 'signe',
  Perdu: 'perdu',
};

/**
 * The stage of a stored lead, whichever vocabulary it was written with.
 * Anything unrecognisable falls back to the first stage rather than vanishing
 * from the board.
 */
export function stageOf(lead) {
  const raw = lead?.stage ?? lead?.status ?? '';
  if (isStage(raw)) return raw;
  return LEGACY[raw] ?? FIRST_STAGE;
}
