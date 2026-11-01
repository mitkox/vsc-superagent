import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { hostname } from 'node:os'
import type { Candidate, Decision, OutboundMessage, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from '../../src/core/index.ts'
import type { AutomationSettings, SettingsVersion } from './settings.ts'

export interface PendingEffect {
  id: string
  kind: 'assessment' | 'start' | 'deliver' | 'stop' | 'outbound'
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed'
  createdAt: string
  updatedAt: string
  attempts: number
  nextAttemptAt: number
  ticketId?: string
  assignmentId?: string
  inputIds?: string[]
  candidate?: Candidate
  /** A human message owned by these workers; only a stop may be decided on this path. */
  followup?: { triggerId: string; ticketIds: string[] }
  message?: OutboundMessage
  reason?: string
  error?: string
}
export interface SessionRecord {
  ticketId: string
  sessionId: string
  directory?: string
  assignmentId?: string
  status: 'idle' | 'working' | 'interrupted' | 'stopped'
  revisions: number[]
  transcript: { type: string; text: string; at: string }[]
}
export interface AutomationData {
  version: 1
  activated: boolean
  settings?: { revision: number; value: AutomationSettings }
  history: SettingsVersion[]
  effects: PendingEffect[]
  sessions: SessionRecord[]
  metadata: Record<string, unknown>
  health: { at: string; component: string; error: string }[]
}

interface AuditEntry { at: string; action: string; ticketId?: string }
interface StateData {
  paused: boolean
  triggers: Trigger[]
  dispositions: [string, TriggerDisposition][]
  threads: Thread[]
  tickets: Ticket[]
  decisions: Decision[]
  audit: AuditEntry[]
  extension?: AutomationData
}

const MAX_STATE_BYTES = 16 * 1024 * 1024
const clone = <T>(value: T): T => structuredClone(value)
const digest = (data: StateData): string => createHash('sha256').update(JSON.stringify(data)).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 100_000
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const ref = (value: unknown): boolean => record(value) && text(value.source) && text(value.id)
const optional = (value: unknown, check: (input: unknown) => boolean): boolean => value === undefined || check(value)
const reportStates = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']
const report = (value: unknown): boolean => record(value) && reportStates.includes(String(value.state)) && text(value.summary) && text(value.at)
const assignment = (value: unknown): boolean => record(value) && text(value.id) && ['pending', 'running', 'ended'].includes(String(value.state))
  && text(value.createdAt) && optional(value.report, report) && optional(value.startedAt, text) && optional(value.endedAt, text)
const input = (value: unknown): boolean => {
  if (!record(value) || !text(value.id) || !text(value.at)) return false
  switch (value.kind) {
    case 'trigger': return text(value.triggerId) && optional(value.note, text) && (value.readAt === null || optional(value.readAt, text)) && optional(value.deliveredTo, text)
    case 'text': case 'note': return text(value.text)
    case 'policy-changed': return text(value.from) && text(value.to) && optional(value.effect, record)
    case 'reopen': return text(value.decisionId)
    case 'resumed': return text(value.triggerId)
    default: return false
  }
}
const closed = (value: unknown): boolean => record(value) && text(value.at) && ['merged', 'closed'].includes(String(value.outcome))
const ended = (value: unknown): boolean => record(value) && text(value.at) && ['executor', 'human'].includes(String(value.by))
  && ['completed', 'merged', 'closed', 'dropped', 'stopped'].includes(String(value.outcome)) && optional(value.reason, text)
class CommitDurabilityError extends Error {}
const automationData = (): AutomationData => ({ version: 1, activated: false, history: [], effects: [], sessions: [], metadata: {}, health: [] })
const validAutomation = (value: unknown): boolean => record(value) && value.version === 1 && typeof value.activated === 'boolean'
  && record(value.metadata) && Array.isArray(value.history) && value.history.every(row => record(row) && Number.isSafeInteger(row.revision) && record(row.value))
  && optional(value.settings, row => record(row) && Number.isSafeInteger(row.revision) && record(row.value))
  && Array.isArray(value.effects) && value.effects.every(row => record(row) && text(row.id) && ['assessment', 'start', 'deliver', 'stop', 'outbound'].includes(String(row.kind))
    && ['pending', 'running', 'completed', 'cancelled', 'failed'].includes(String(row.status)) && Number.isSafeInteger(row.attempts) && typeof row.nextAttemptAt === 'number'
    && text(row.createdAt) && text(row.updatedAt) && optional(row.ticketId, text) && optional(row.assignmentId, text) && optional(row.inputIds, strings)
    && optional(row.followup, value => record(value) && text(value.triggerId) && strings(value.ticketIds))
    && (row.kind !== 'assessment' || record(row.candidate) || record(row.followup)) && (row.kind !== 'outbound' || (record(row.message) && text(row.message.id) && text(row.message.text) && record(row.message.channel))))
  && Array.isArray(value.sessions) && value.sessions.every(row => record(row) && text(row.ticketId) && text(row.sessionId) && Array.isArray(row.revisions)
    && ['idle', 'working', 'interrupted', 'stopped'].includes(String(row.status)) && Array.isArray(row.transcript) && row.transcript.every(event => record(event) && text(event.type) && text(event.text) && text(event.at)))
  && Array.isArray(value.health) && value.health.every(row => record(row) && text(row.at) && text(row.component) && text(row.error))

/** The persisted envelope is versioned and checksummed; malformed state is never silently reset. */
function validate(value: unknown): StateData {
  if (!record(value) || value.version !== 1 || !record(value.data) || typeof value.checksum !== 'string') throw new Error('Corrupt or unsupported Superagent state')
  const data = value.data
  if (typeof data.paused !== 'boolean' || !['triggers', 'dispositions', 'threads', 'tickets', 'decisions', 'audit'].every(key => Array.isArray(data[key]))) throw new Error('Corrupt Superagent state structure')
  const rows = (key: string, valid: (row: Record<string, unknown>) => boolean) => (data[key] as unknown[]).every(row => record(row) && valid(row))
  const valid = rows('triggers', row => text(row.id) && text(row.source) && Array.isArray(row.threads) && row.threads.length > 0 && row.threads.every(ref)
    && ref(row.actor) && typeof row.human === 'boolean' && text(row.at) && text(row.text) && record(row.meta))
    && (data.dispositions as unknown[]).every(row => Array.isArray(row) && row.length === 2 && text(row[0]) && record(row[1]) && strings(row[1].fanout) && text(row[1].at))
    && rows('threads', row => text(row.key) && ref(row.ref) && text(row.createdAt) && strings(row.subscriptions) && strings(row.correlated) && strings(row.pending) && record(row.meta))
    && rows('tickets', row => text(row.id) && text(row.title) && text(row.decisionId) && record(row.mandate) && ref(row.mandate.actor)
      && text(row.mandate.policyVersion) && ['explicit', 'inferred'].includes(String(row.mandate.strength)) && record(row.mandate.basis) && text(row.mandate.scope)
      && Array.isArray(row.channels) && row.channels.every(item => record(item) && text(item.source) && text(item.thread) && record(item.address) && Object.values(item.address).every(text))
      && Array.isArray(row.assignments) && row.assignments.every(assignment) && Array.isArray(row.inputs) && row.inputs.every(input)
      && strings(row.undelivered) && text(row.createdAt) && text(row.updatedAt) && record(row.origin) && text(row.origin.triggerId) && strings(row.origin.triggerIds)
      && optional(row.ended, ended) && optional(row.follows, value => Array.isArray(value) && value.every(item => record(item) && text(item.thread) && typeof item.own === 'boolean' && optional(item.closed, closed)))
      && optional(row.attention, value => record(value) && text(value.id) && text(value.question)) && optional(row.delivery, value => record(value) && text(value.error) && text(value.at)))
    && rows('decisions', row => text(row.id) && text(row.evalId) && text(row.threadKey) && strings(row.triggerIds) && text(row.policyVersion) && text(row.at) && Array.isArray(row.reason))
    && rows('audit', row => text(row.at) && text(row.action) && (row.ticketId === undefined || text(row.ticketId)))
  if (!valid || !optional(data.extension, validAutomation) || digest(data as unknown as StateData) !== value.checksum) throw new Error('Corrupt Superagent state checksum or records')
  return data as unknown as StateData
}

/** All new owners serialize acquisition and stale-owner removal; no check/unlink race can remove a newer live lock. */
function acquireLock(lockPath: string, token: string): void {
  const guardPath = `${lockPath}.acquire`
  let guard: number
  try { guard = openSync(guardPath, 'wx', 0o600) }
  catch { throw new Error('Superagent lock acquisition is in progress or was interrupted. Verify all hosts have stopped before removing state.lock.acquire.') }
  try {
    writeFileSync(guard, JSON.stringify({ pid: process.pid, host: hostname(), token }))
    fsyncSync(guard)
    let lock: number
    try { lock = openSync(lockPath, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let dead = false
      try {
        const stat = lstatSync(lockPath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unsafe lock')
        const owner: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (!record(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || owner.host !== hostname() || typeof owner.token !== 'string' || !owner.token) throw new Error('Unidentifiable lock owner')
        try { process.kill(owner.pid as number, 0) }
        catch (signalError) { dead = (signalError as NodeJS.ErrnoException).code === 'ESRCH' }
      } catch { /* A malformed, remote, permission-denied or otherwise unidentifiable owner is preserved. */ }
      if (!dead) throw new Error('Superagent state lock is held by another host or its owner cannot be verified. Verify the host has stopped before removing state.lock.')
      // The acquisition guard excludes every other new owner throughout stale removal and replacement.
      unlinkSync(lockPath)
      lock = openSync(lockPath, 'wx', 0o600)
    }
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token })); fsyncSync(lock) }
    catch (error) { unlinkSync(lockPath); throw error }
    finally { closeSync(lock) }
  } finally {
    closeSync(guard)
    unlinkSync(guardPath)
  }
}

/** Synchronous transactions commit an atomic file replacement before returning to any caller. */
export class DurableRepositories implements Repositories {
  private data: StateData = { paused: false, triggers: [], dispositions: [], threads: [], tickets: [], decisions: [], audit: [] }
  private depth = 0
  private disposed = false
  private readonly lockPath: string
  private readonly statePath: string
  private readonly lockToken = randomUUID()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error('Superagent storage directory must be absolute')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = lstatSync(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Unsafe Superagent storage directory')
    if (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) throw new Error('Superagent storage directory must have private 0700 permissions')
    this.lockPath = join(directory, 'state.lock')
    this.statePath = join(directory, 'state.json')
    acquireLock(this.lockPath, this.lockToken)
    try {
      let stat
      try { stat = lstatSync(this.statePath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unsafe Superagent state file')
        this.data = validate(JSON.parse(readFileSync(this.statePath, 'utf8')))
      }
    } catch (error) {
      this.dispose()
      throw new Error('Unable to load Superagent state; the original state was preserved', { cause: error })
    }
  }

  get paused(): boolean { this.assertOpen(); return this.data.paused }
  setPaused(value: boolean): void { this.data.paused = value }
  audit(action: string, ticketId?: string): void {
    this.data.audit.push({ at: new Date().toISOString(), action, ...(ticketId ? { ticketId } : {}) })
    this.data.audit = this.data.audit.slice(-2_000)
  }
  assertOpen(): void { if (this.disposed) throw new Error('Superagent runtime is disposed') }
  onCommit(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  automation(): AutomationData { this.assertOpen(); return clone(this.data.extension ?? automationData()) }
  mutateAutomation<T>(work: (data: AutomationData) => T): T {
    return this.atomic(() => { this.data.extension ??= automationData(); return work(this.data.extension) })
  }
  snapshot(): { triggers: Trigger[]; dispositions: [string, TriggerDisposition][]; threads: Thread[]; tickets: Ticket[]; decisions: Decision[]; audit: AuditEntry[] } {
    this.assertOpen()
    const { extension: _, paused: __, ...records } = this.data
    return clone(records)
  }
  enqueue(effect: Omit<PendingEffect, 'status' | 'createdAt' | 'updatedAt' | 'attempts' | 'nextAttemptAt'>): void {
    this.mutateAutomation(data => {
      if (data.effects.some(row => row.id === effect.id)) return
      const at = new Date().toISOString()
      data.effects.push({ ...clone(effect), status: 'pending', createdAt: at, updatedAt: at, attempts: 0, nextAttemptAt: 0 })
    })
  }

  atomic<T>(work: () => T): T {
    this.assertOpen()
    const before = clone(this.data)
    this.depth++
    let committed = false
    try {
      const result = work()
      if (this.depth === 1) { this.persist(); committed = true }
      return result
    } catch (error) { if (!(error instanceof CommitDurabilityError)) this.data = before; throw error }
    finally {
      this.depth--
      if (committed) for (const listener of this.listeners) {
        try { listener() } catch { /* Observers cannot undo an already durable commit. */ }
      }
    }
  }

  private persist(): void {
    const body = JSON.stringify({ version: 1, checksum: digest(this.data), data: this.data })
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error('Superagent state capacity reached; archive reviewed work before continuing')
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`)
    let file: number | undefined
    let directoryFile: number | undefined
    try {
      // Windows does not support opening a directory handle through this API.
      if (process.platform !== 'win32') directoryFile = openSync(this.directory, constants.O_RDONLY)
      file = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      writeFileSync(file, body)
      fsyncSync(file)
      closeSync(file); file = undefined
      renameSync(temporary, this.statePath)
      if (directoryFile !== undefined) {
        try { fsyncSync(directoryFile) }
        catch (error) {
          // The replacement already committed. Keep memory consistent and stop further writes.
          this.dispose()
          throw new CommitDurabilityError('Superagent state was replaced but directory durability could not be confirmed; reopen and inspect state before continuing', { cause: error })
        }
      }
    } finally {
      if (file !== undefined) closeSync(file)
      if (directoryFile !== undefined) closeSync(directoryFile)
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string }
      if (lock.token === this.lockToken) unlinkSync(this.lockPath)
    } catch { /* Never remove a lock whose ownership cannot be established. */ }
  }

  readonly triggers = {
    get: (id: string) => clone(this.data.triggers.find(row => row.id === id)),
    save: (trigger: Trigger) => { this.replace(this.data.triggers, trigger.id, trigger) },
    disposition: (id: string) => clone(this.data.dispositions.find(([key]) => key === id)?.[1]),
    saveDisposition: (id: string, value: TriggerDisposition) => {
      const index = this.data.dispositions.findIndex(([key]) => key === id)
      const row: [string, TriggerDisposition] = [id, clone(value)]
      if (index < 0) this.data.dispositions.push(row); else this.data.dispositions[index] = row
    },
  }
  readonly threads = {
    get: (key: string) => clone(this.data.threads.find(row => row.key === key)),
    save: (thread: Thread) => { this.replace(this.data.threads, thread.key, thread, row => row.key) },
    list: () => clone(this.data.threads),
    active: () => this.threads.list().filter(row => row.pending.length > 0 || row.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => clone(this.data.tickets.find(row => row.id === id)),
    save: (ticket: Ticket) => { this.replace(this.data.tickets, ticket.id, ticket) },
    list: () => clone(this.data.tickets).reverse(),
    open: () => this.tickets.list().filter(row => !row.ended),
    active: () => this.tickets.list().filter(row => row.undelivered.length > 0 || ['pending', 'running'].includes(row.assignments.at(-1)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => clone(this.data.decisions.find(row => row.id === id)),
    save: (decision: Decision) => { this.replace(this.data.decisions, decision.id, decision) },
    byThread: (key: string) => clone(this.data.decisions.filter(row => row.threadKey === key)),
  }
  private replace<T>(rows: T[], id: string, row: T, identify: (value: T) => string = value => (value as { id: string }).id): void {
    const index = rows.findIndex(value => identify(value) === id)
    if (index < 0) rows.push(clone(row)); else rows[index] = clone(row)
  }
}
