import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Decision, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from '../../src/core/index.ts'

interface AuditEntry { at: string; action: string; ticketId?: string }
interface StateData {
  paused: boolean
  triggers: Trigger[]
  dispositions: [string, TriggerDisposition][]
  threads: Thread[]
  tickets: Ticket[]
  decisions: Decision[]
  audit: AuditEntry[]
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
  if (!valid || digest(data as unknown as StateData) !== value.checksum) throw new Error('Corrupt Superagent state checksum or records')
  return data as unknown as StateData
}

/** Synchronous transactions commit an atomic file replacement before returning to any caller. */
export class DurableRepositories implements Repositories {
  private data: StateData = { paused: false, triggers: [], dispositions: [], threads: [], tickets: [], decisions: [], audit: [] }
  private depth = 0
  private disposed = false
  private readonly lockPath: string
  private readonly statePath: string
  private readonly lockToken = randomUUID()

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error('Superagent storage directory must be absolute')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = lstatSync(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Unsafe Superagent storage directory')
    if (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) throw new Error('Superagent storage directory must have private 0700 permissions')
    this.lockPath = join(directory, 'state.lock')
    this.statePath = join(directory, 'state.json')
    let lock: number
    try { lock = openSync(this.lockPath, 'wx', 0o600) }
    catch { throw new Error('Superagent state lock is held by another host. If the host crashed, verify it has stopped before removing state.lock.') }
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: this.lockToken }))
      fsyncSync(lock)
    } finally { closeSync(lock) }
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

  atomic<T>(work: () => T): T {
    this.assertOpen()
    const before = clone(this.data)
    this.depth++
    try {
      const result = work()
      if (this.depth === 1) this.persist()
      return result
    } catch (error) { if (!(error instanceof CommitDurabilityError)) this.data = before; throw error }
    finally { this.depth-- }
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
