import { createHash, randomUUID } from 'node:crypto'
import { Engine, latestAssignment, runningAssignment } from '../../src/core/index.ts'
import type { Policy, ReportState, SourceScope, Ticket, Trigger } from '../../src/core/index.ts'
import { DurableRepositories } from './state.ts'
import type { SourceContext } from './sources.ts'
import { sourceTrigger } from './sources.ts'

export interface ExternalOrigin { source: string; id: string; actor: string; context?: SourceContext; url?: string; thread?: string }

const REPORT_STATES = new Set<ReportState>(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
const POLICY_VERSION = 'vscode-local-approval-v1'

function boundedText(value: unknown, label = 'text'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 50_000 || value.includes('\0')) throw new Error(`Invalid ${label}: expected 1-50000 non-NUL characters`)
  return value.trim()
}

function validateOrigin(origin: ExternalOrigin | undefined): void {
  if (!origin) return
  if (!origin.source || !origin.id || !origin.actor || [origin.source, origin.id, origin.actor, origin.url ?? '', origin.thread ?? ''].some(value => typeof value !== 'string' || value.length > 4_000 || value.includes('\0'))) throw new Error('Invalid external origin')
  if (origin.context !== undefined && (!origin.context || typeof origin.context !== 'object' || origin.context.provider !== origin.source || JSON.stringify(origin.context).length > 100_000 || JSON.stringify(origin.context).includes('\\u0000'))) throw new Error('Invalid external provider context')
}

/**
 * The native UI grants authority; models and remote messages cannot grant it.
 * The executor port records pending work only. Copilot's native approved tools perform actual work.
 */
export class TicketRuntime {
  private readonly repo: DurableRepositories
  /** Native integration boundary; never hand the complete engine to a model. */
  readonly engine: Engine
  private automation = false
  private automatedPolicy?: () => Policy
  private automatedScope?: SourceScope
  constructor(storageDir: string, options: { automation?: boolean } = {}) {
    this.repo = new DurableRepositories(storageDir)
    this.automation = options.automation === true || this.repo.automation().activated
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
      policy: () => this.automatedPolicy ? this.automatedPolicy() : { ...policy, paused: this.repo.paused },
      scope: { scope: input => this.automatedScope ? this.automatedScope.scope(input) : input.source === 'vscode' ? { listened: true, observed: false } : { listened: false, reason: 'localApprovalRequired' } },
      assessor: {
        request: candidate => {
          if (!this.automation) throw new Error('Autonomous assessments are disabled')
          this.repo.enqueue({ id: `assessment:${candidate.evalId}`, kind: 'assessment', candidate })
        },
        release: evalId => {
          if (!this.automation) return
          this.repo.mutateAutomation(data => {
            const effect = data.effects.find(row => row.id === `assessment:${evalId}`)
            if (effect && effect.status === 'pending') effect.status = 'cancelled'
          })
        },
      },
      executor: {
        start: (ticket, assignment) => { if (this.automation) this.repo.enqueue({ id: `start:${assignment.id}`, kind: 'start', ticketId: ticket.id, assignmentId: assignment.id }) },
        deliver: (ticket, assignment) => {
          if (!this.automation || !ticket.undelivered.length) return
          const identity = createHash('sha256').update(JSON.stringify(ticket.undelivered)).digest('hex')
          this.repo.enqueue({ id: `deliver:${assignment.id}:${identity}`, kind: 'deliver', ticketId: ticket.id, assignmentId: assignment.id, inputIds: [...ticket.undelivered] })
        },
        stop: (ticket, assignment, reason) => { if (this.automation) this.repo.enqueue({ id: `stop:${assignment.id}`, kind: 'stop', ticketId: ticket.id, assignmentId: assignment.id, reason }) },
      },
      outbox: {
        send: message => {
          if (!this.automation) throw new Error('External delivery requires separate operator approval')
          this.repo.enqueue({ id: `outbound:${message.id}`, kind: 'outbound', ticketId: message.ticketId, message })
        },
        status: id => {
          const effect = this.repo.automation().effects.find(row => row.id === `outbound:${id}`)
          return !effect ? undefined : effect.status === 'completed' ? 'sent' : effect.status === 'cancelled' ? 'dropped' : 'pending'
        },
        withdraw: id => {
          if (this.automation) this.repo.mutateAutomation(data => {
            const effect = data.effects.find(row => row.id === `outbound:${id}`)
            if (effect && ['pending', 'running', 'failed'].includes(effect.status)) effect.status = 'cancelled'
          })
        },
      },
      emit: event => this.repo.audit(event.type, 'ticketId' in event.data ? event.data.ticketId : undefined),
    })
    try {
      this.repo.atomic(() => {
        for (const ticket of this.automation ? [] : this.repo.tickets.open()) {
          const assignment = runningAssignment(ticket)
          if (!assignment || ['ready', 'waiting', 'blocked', 'failed'].includes(assignment.report?.state ?? '')) continue
          this.engine.report(ticket.id, { state: 'blocked', summary: 'The extension host stopped during work. Inspect the worktree and external state, then explicitly retry before continuing.' })
        }
      })
    } catch (error) { this.repo.dispose(); throw error }
  }

  get paused(): boolean { return this.repo.paused }
  get repositories(): DurableRepositories { this.repo.assertOpen(); return this.repo }
  configureAutomation(policy: () => Policy, scope: SourceScope): void {
    this.repo.assertOpen(); this.automation = true; this.automatedPolicy = policy; this.automatedScope = scope
  }
  readData<T = unknown>(key: string): T | undefined { this.repo.assertOpen(); return this.repo.automation().metadata[key] as T | undefined }
  writeData(key: string, value: unknown): void {
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid metadata key')
    let encoded: string | undefined
    try { encoded = JSON.stringify(value) } catch { throw new Error('Metadata must be JSON data') }
    if (value !== undefined && (encoded === undefined || Buffer.byteLength(encoded) > 1_000_000)) throw new Error('Metadata exceeds the size limit')
    this.repo.mutateAutomation(data => { if (value === undefined) delete data.metadata[key]; else data.metadata[key] = JSON.parse(encoded!) })
  }
  list(): Ticket[] { this.repo.assertOpen(); return this.repo.tickets.list() }
  get(id: string): Ticket {
    this.repo.assertOpen()
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid ticket identifier')
    const ticket = this.repo.tickets.get(id)
    if (!ticket) throw new Error('Unknown ticket')
    return ticket
  }

  context(id: string): { ticket: Ticket; messages: Trigger[] } {
    const ticket = this.get(id)
    const triggerIds = new Set([ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])
    const messages = [...triggerIds].flatMap(triggerId => {
      const trigger = this.repo.triggers.get(triggerId)
      return trigger ? [trigger] : []
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
      const primary = origin.threads[0]!
      const trigger = this.trigger(request, primary.source === 'vscode' ? primary.id : `followup-${randomUUID()}`, externalOrigin)
      this.engine.receive(trigger)
      // A named native follow-up belongs to its chosen ticket, including a ticket whose origin is a provider thread.
      if (!this.get(id).inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)) this.engine.attach(id, trigger.id)
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
    const provider = origin?.context ? sourceTrigger({ id: origin.id, source: origin.context.provider, actor: origin.actor, text, thread: origin.thread ?? origin.context.nativeThreadId, context: origin.context, ...(origin.url ? { url: origin.url } : {}) }) : undefined
    return {
      id: randomUUID(), source: 'vscode', threads: [{ source: 'vscode', id: thread }, ...(provider?.threads ?? [])],
      actor: { source: 'vscode', id: 'local-operator' }, human: true, addressed: 'direct',
      at: new Date().toISOString(), text, ...(origin?.url ? { url: origin.url } : {}),
      ...(provider?.channel ? { channel: provider.channel } : {}),
      meta: origin ? { externalOrigin: structuredClone(origin), ...(origin.context ? { provider: structuredClone(origin.context) } : {}), locallyApproved: true } : { locallyApproved: true },
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
