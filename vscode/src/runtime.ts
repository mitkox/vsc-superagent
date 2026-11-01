import { createHash, randomUUID } from 'node:crypto'
import { Engine, latestAssignment, runningAssignment } from '../../src/core/index.ts'
import type { Policy, ReportState, Ticket, Trigger } from '../../src/core/index.ts'
import { DurableRepositories } from './state.ts'

export interface ExternalOrigin { source: string; id: string; actor: string }

const REPORT_STATES = new Set<ReportState>(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
const POLICY_VERSION = 'vscode-local-approval-v1'

function boundedText(value: unknown, label = 'text'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 50_000 || value.includes('\0')) throw new Error(`Invalid ${label}: expected 1-50000 non-NUL characters`)
  return value.trim()
}

function validateOrigin(origin: ExternalOrigin | undefined): void {
  if (origin && (!origin.source || !origin.id || !origin.actor || Object.values(origin).some(value => typeof value !== 'string' || value.length > 1_000 || value.includes('\0')))) throw new Error('Invalid external origin')
}

/**
 * The native UI grants authority; models and remote messages cannot grant it.
 * The executor port records pending work only. Copilot's native approved tools perform actual work.
 */
export class TicketRuntime {
  private readonly repo: DurableRepositories
  private readonly engine: Engine
  constructor(storageDir: string) {
    this.repo = new DurableRepositories(storageDir)
    const policy: Policy = {
      version: POLICY_VERSION,
      get paused() { return false },
      evalTimeoutMs: 60_000,
      gate: trigger => trigger.source === 'vscode' && trigger.human && trigger.actor.source === 'vscode' && trigger.actor.id === 'local-operator'
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: 'local-operator' } }
        : { admissible: false, reason: 'localApprovalRequired' },
      revalidate: mandate => mandate.policyVersion === POLICY_VERSION && mandate.actor.source === 'vscode' && mandate.actor.id === 'local-operator',
      admitsInferred: () => false,
    }
    this.engine = new Engine({
      repo: this.repo,
      policy: () => ({ ...policy, paused: this.repo.paused }),
      scope: { scope: input => input.source === 'vscode' ? { listened: true, observed: false } : { listened: false, reason: 'localApprovalRequired' } },
      assessor: { request: () => { throw new Error('Autonomous assessments are disabled') } },
      executor: { start: () => {}, deliver: () => {}, stop: () => {} },
      outbox: {
        send: () => { throw new Error('External delivery requires separate operator approval') },
        status: () => undefined,
        withdraw: () => {},
      },
      emit: event => this.repo.audit(event.type, 'ticketId' in event.data ? event.data.ticketId : undefined),
    })
    try {
      this.repo.atomic(() => {
        for (const ticket of this.repo.tickets.open()) {
          const assignment = runningAssignment(ticket)
          if (!assignment || ['ready', 'waiting', 'blocked', 'failed'].includes(assignment.report?.state ?? '')) continue
          this.engine.report(ticket.id, { state: 'blocked', summary: 'The extension host stopped during work. Inspect the worktree and external state, then explicitly retry before continuing.' })
        }
      })
    } catch (error) { this.repo.dispose(); throw error }
  }

  get paused(): boolean { return this.repo.paused }
  list(): Ticket[] { this.repo.assertOpen(); return this.repo.tickets.list() }
  get(id: string): Ticket {
    this.repo.assertOpen()
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid ticket identifier')
    const ticket = this.repo.tickets.get(id)
    if (!ticket) throw new Error('Unknown ticket')
    return ticket
  }

  context(id: string): { ticket: Ticket; messages: { id: string; text: string; at: string }[] } {
    const ticket = this.get(id)
    const triggerIds = new Set([ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])
    const messages = [...triggerIds].flatMap(triggerId => {
      const trigger = this.repo.triggers.get(triggerId)
      return trigger ? [{ id: trigger.id, text: trigger.text, at: trigger.at }] : []
    })
    return { ticket, messages }
  }

  create(text: string, origin?: ExternalOrigin): Ticket {
    this.requireUnpaused()
    const request = boundedText(text)
    validateOrigin(origin)
    if (origin) {
      const existing = this.imported(origin)
      if (existing) return existing
    }
    return this.repo.atomic(() => {
      const trigger = this.trigger(request, `task-${randomUUID()}`, origin)
      this.engine.receive(trigger)
      const decision = this.engine.decide(trigger.id, { kind: 'accept', title: request.split('\n')[0]!.slice(0, 160), scope: request, reason: 'Approved locally by the operator' })
      if (!decision.ticketId) throw new Error('The approved request did not create a ticket')
      return this.get(decision.ticketId)
    })
  }

  followup(id: string, text: string, externalOrigin?: ExternalOrigin): Ticket {
    this.requireUnpaused()
    const request = boundedText(text)
    const ticket = this.get(id)
    validateOrigin(externalOrigin)
    if (externalOrigin) {
      const existing = this.imported(externalOrigin)
      if (existing && existing.id !== id) throw new Error('This external message already belongs to another ticket')
      if (existing) return existing
    }
    if (ticket.ended?.by === 'human') throw new Error('A stopped ticket cannot resume; create a new approved request')
    const origin = this.repo.triggers.get(ticket.origin.triggerId)
    if (!origin?.threads[0]) throw new Error('Ticket origin is missing')
    return this.repo.atomic(() => {
      this.engine.receive(this.trigger(request, origin.threads[0]!.id, externalOrigin))
      return this.get(id)
    })
  }

  begin(id: string): Ticket {
    this.requireUnpaused()
    const ticket = this.get(id)
    if (ticket.ended) throw new Error('Ticket has ended')
    const assignment = latestAssignment(ticket)
    if (!assignment || assignment.state === 'ended') throw new Error('Ticket has no pending assignment')
    if (['blocked', 'failed'].includes(assignment.report?.state ?? '')) throw new Error('Explicitly retry this ticket before beginning work')
    const competing = this.repo.tickets.open().some(other => other.id !== id && other.assignments.some(item => item.state === 'running'
      && !['ready', 'waiting', 'blocked', 'failed'].includes(item.report?.state ?? '')))
    if (competing) throw new Error('Another ticket is working; concurrency is limited to one active assignment')
    return this.repo.atomic(() => {
      this.engine.assignmentStarted(id, assignment.id)
      const waiting = this.get(id).undelivered
      this.engine.inputsDelivered(id, assignment.id, waiting)
      this.engine.inputsRead(id, waiting)
      this.engine.report(id, { state: 'progress', summary: 'The operator started work in Copilot.' })
      return this.get(id)
    })
  }

  report(id: string, state: ReportState, summary: string, question?: string): Ticket {
    this.get(id)
    if (!REPORT_STATES.has(state)) throw new Error('Invalid report state')
    const report = boundedText(summary, 'report summary')
    const attention = question === undefined ? undefined : boundedText(question, 'question')
    return this.repo.atomic(() => this.engine.report(id, { state, summary: report, ...(attention ? { question: attention } : {}) }))
  }

  reportWithPullRequest(id: string, state: ReportState, summary: string, question: string | undefined, number: number, source: string): Ticket {
    this.get(id)
    this.pullRequestNumber(number)
    if (!REPORT_STATES.has(state)) throw new Error('Invalid report state')
    const report = boundedText(summary, 'report summary')
    const attention = question === undefined ? undefined : boundedText(question, 'question')
    const ref = this.pullRequestRef(number, source)
    if (!this.matchesPullRequestSource(id, source)) throw new Error('Ticket follows another GitHub source')
    return this.repo.atomic(() => {
      this.engine.bindThread(id, ref, true)
      return this.engine.report(id, { state, summary: report, ...(attention ? { question: attention } : {}) })
    })
  }

  matchesPullRequestSource(id: string, source: string): boolean {
    const prefix = `github:${createHash('sha256').update(boundedText(source, 'pull request source')).digest('hex')}:pr-`
    return (this.get(id).follows ?? []).every(follow => !follow.thread.startsWith('github:') || follow.thread.startsWith(prefix))
  }

  stop(id: string): Ticket { this.get(id); return this.repo.atomic(() => this.engine.stopTicket(id, 'Stopped locally by the operator')) }
  retry(id: string): Ticket { this.requireUnpaused(); this.get(id); return this.repo.atomic(() => this.engine.retryTicket(id)) }
  setPaused(value: boolean): void {
    this.repo.assertOpen()
    if (typeof value !== 'boolean') throw new Error('Invalid pause state')
    this.repo.atomic(() => { this.repo.setPaused(value); this.repo.audit(value ? 'processing.paused' : 'processing.resumed') })
  }

  bindPullRequest(id: string, number: number, own: boolean, source: string): Ticket {
    this.get(id)
    this.pullRequestNumber(number)
    if (typeof own !== 'boolean') throw new Error('Invalid pull request ownership')
    return this.repo.atomic(() => this.engine.bindThread(id, this.pullRequestRef(number, source), own))
  }

  closePullRequest(number: number, outcome: 'merged' | 'closed', source: string): void {
    this.repo.assertOpen()
    this.pullRequestNumber(number)
    if (outcome !== 'merged' && outcome !== 'closed') throw new Error('Invalid pull request outcome')
    this.repo.atomic(() => this.engine.threadClosed(this.pullRequestRef(number, source), outcome, new Date().toISOString()))
  }

  dispose(): void { this.repo.dispose() }

  private trigger(text: string, thread: string, origin?: ExternalOrigin): Trigger {
    return {
      id: randomUUID(), source: 'vscode', threads: [{ source: 'vscode', id: thread }],
      actor: { source: 'vscode', id: 'local-operator' }, human: true, addressed: 'direct',
      at: new Date().toISOString(), text, meta: origin ? { externalOrigin: { ...origin }, locallyApproved: true } : { locallyApproved: true },
    }
  }
  private requireUnpaused(): void { if (this.repo.paused) throw new Error('Superagent processing is paused') }
  private imported(origin: ExternalOrigin): Ticket | undefined {
    return this.repo.tickets.list().find(ticket => [ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])].some(id => {
      const prior = this.repo.triggers.get(id)?.meta.externalOrigin as ExternalOrigin | undefined
      return prior?.source === origin.source && prior.id === origin.id
    }))
  }
  private pullRequestRef(number: number, source: string): { source: string; id: string } {
    const identity = boundedText(source, 'pull request source')
    return { source: 'github', id: `${createHash('sha256').update(identity).digest('hex')}:pr-${number}` }
  }
  private pullRequestNumber(number: number): void { if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid pull request number') }
}
