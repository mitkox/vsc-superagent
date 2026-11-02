import type { MandateBasis, Strength, Trigger } from './model.ts'

/** Requests may share an assessment only when one immutable grant can authorize every request in it. */
export function assessmentCohort(trigger: Trigger, strength: Strength, basis: MandateBasis): string {
  return JSON.stringify([trigger.source, trigger.actor.source, trigger.actor.id, trigger.human, strength,
    basis.source ?? trigger.source, basis.row ?? null, basis.via,
    'cell' in basis ? basis.cell : null, 'addressed' in basis ? basis.addressed ?? null : null])
}
