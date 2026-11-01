import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as vscode from 'vscode'
import { threadKey } from '../../src/core/index.ts'
import type { OutboundMessage, ThreadRef, Ticket, Trigger } from '../../src/core/index.ts'
import { CopilotBackend } from './copilot.ts'
import { AutomationService } from './orchestration.ts'
import { SuperagentPanel } from './panel.ts'
import { ticketPermission } from './permissions.ts'
import type { TicketRuntime } from './runtime.ts'
import type { Worktrees } from './worktree.ts'
import type { GitHubSourceConfig, GitHubReviewCursor, SourceContext, TeamsBatchCursor, TeamsSourceConfig } from './sources.ts'
import { discoverOwnPullRequests, githubThreadRef, pollDefaultBranchChecks, pollGitHub, pollGitHubChecks, pollGitHubReviewsBatch, pollTeamsBatch, readPullRequest, sourceRequest, sourceSubscription, sourceTrigger } from './sources.ts'
import { resolveGitHubReviewThread } from './delivery.ts'
import type { GitHubDeliveryCredential, TeamsDeliveryCredential } from './delivery.ts'
import { readTeamsMembers } from './membership.ts'
import { restartChangedScan } from './checkpoints.ts'
import { SourceResources } from './source-resources.ts'
import { sendDurableReply } from './outbound.ts'

export interface AutomationHost { runtime: TicketRuntime; trees: Worktrees; root: string; identity: string }
export interface AutomationHooks {
  host(): Promise<AutomationHost>
  guard(): string
  github(): Promise<GitHubSourceConfig>
  changed(): void
}
export interface AutomationLifecycle extends vscode.Disposable { shutdown(): Promise<void>; readonly active: boolean }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Owns the native authorization surface. Provider text and worker tools cannot call these commands. */
export function activateAutomation(context: vscode.ExtensionContext, hooks: AutomationHooks): AutomationLifecycle {
  const config = () => vscode.workspace.getConfiguration('superagent')
  let service: AutomationService | undefined, backend: CopilotBackend | undefined, owner: AutomationHost | undefined
  let initializing: Promise<AutomationService> | undefined, closing = false
  let shutdownPromise: Promise<void> | undefined
  const panel = new SuperagentPanel({ snapshot: () => service?.snapshot() ?? { tickets: [], settings: {}, health: { service: 'Start the service to load its configuration.' } }, action })
  const resources = new SourceResources()
  const notify = () => { hooks.changed(); panel.refresh() }
  const assertCurrent = () => { hooks.guard(); if (closing) throw new Error('Superagent is closing') }

  function sourcePolicy() {
    const c = config()
    return { github: { enabled: !!c.get<string>('github.repository'), allowedActors: c.get<string[]>('github.allowedActors', []),
      allowedBots: c.get<string[]>('github.allowedBots', []), allowUnaddressed: c.get('github.observe', false) },
    teams: { enabled: !!c.get<string>('teams.tenantId'), allowedActors: c.get<string[]>('teams.allowedActors', []),
      allowedBots: c.get<string[]>('teams.allowedBots', []), allowUnaddressed: true } }
  }

  async function teams(writing = false, interactive = false): Promise<TeamsDeliveryCredential> {
    assertCurrent()
    const c = config(), tenantId = c.get<string>('teams.tenantId', ''), chatIds = c.get<string[]>('teams.chatIds', []),
      channels = c.get<TeamsSourceConfig['channels']>('teams.channels', [])
    const scope = fingerprint({ tenantId, chatIds, channels, actors: c.get('teams.allowedActors'), writing })
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tenantId)) throw new Error('Configure a valid Teams tenant')
    const scopes = [`VSCODE_TENANT:${tenantId}`, 'https://graph.microsoft.com/User.Read', ...(chatIds.length ? ['https://graph.microsoft.com/Chat.Read'] : []),
      ...(channels.length ? ['https://graph.microsoft.com/ChannelMessage.Read.All'] : []),
      ...(writing && chatIds.length ? ['https://graph.microsoft.com/ChatMessage.Send'] : []),
      ...(writing && channels.length ? ['https://graph.microsoft.com/ChannelMessage.Send'] : []),
      ...(c.get<string>('teams.syncChatId', '') ? ['https://graph.microsoft.com/ChatMember.Read'] : [])]
    const session = await vscode.authentication.getSession('microsoft', scopes, interactive ? { createIfNone: true } : { silent: true })
    assertCurrent()
    const current = config()
    if (scope !== fingerprint({ tenantId: current.get('teams.tenantId', ''), chatIds: current.get('teams.chatIds', []),
      channels: current.get('teams.channels', []), actors: current.get('teams.allowedActors'), writing })) throw new Error('Teams configuration changed during sign-in')
    if (!session) throw new Error('Sign in to Microsoft Teams with Superagent: Start Service')
    const identity = await sourceRequest(new URL('https://graph.microsoft.com/v1.0/me?$select=id'), session.accessToken, undefined, fetch)
    assertCurrent()
    if (scope !== fingerprint({ tenantId: config().get('teams.tenantId', ''), chatIds: config().get('teams.chatIds', []),
      channels: config().get('teams.channels', []), actors: config().get('teams.allowedActors'), writing })) throw new Error('Teams configuration changed while reading account identity')
    const accountId = record(identity.value) && typeof identity.value.id === 'string' ? identity.value.id : ''
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(accountId)) throw new Error('Microsoft sign-in did not identify the sender')
    return { provider: 'teams', mode: 'delegated', tenantId, chatIds, channels, allowedActors: c.get('teams.allowedActors', []),
      allowedBots: c.get('teams.allowedBots', []), accountId, token: session.accessToken, scopes: scopes.map(scope => scope.slice(scope.lastIndexOf('/') + 1)) }
  }
  async function github(writing = false): Promise<GitHubDeliveryCredential> {
    assertCurrent()
    return { ...(await hooks.github()), provider: 'github', allowedBots: config().get('github.allowedBots', []),
      scopes: writing ? ['issues:write', 'pull_requests:write'] : [] }
  }

  async function poll(signal: AbortSignal): Promise<Trigger[]> {
    const h = owner!
    const sourceSettings = sourcePolicy()
    const policyKey = 'source-configuration-fingerprint', policyFingerprint = fingerprint(sourceSettings)
    if (h.runtime.readData<string>(policyKey) !== policyFingerprint) {
      service!.saveSettings({ ...service!.settings.value, sources: sourceSettings }, service!.settings.revision)
      h.runtime.writeData(policyKey, policyFingerprint)
    }
    // Each source commits received events and its cursor together, before acknowledging progress.
    const commit = (key: string, events: ReturnType<typeof sourceTrigger>[], cursor: unknown) => {
      assertCurrent(); signal.throwIfAborted()
      h.runtime.repositories.atomic(() => { events.forEach(event => h.runtime.engine.receive(event)); h.runtime.writeData(key, cursor) })
    }
    const errors: string[] = []
    if (sourceSettings.github.enabled) {
      try {
        const base = await github(), ref = githubThreadRef(base, 1), key = `source:github:${ref.source}`
        const previous = h.runtime.readData<{ since: string; reviews?: GitHubReviewCursor }>(key)
        const started = new Date(Date.now() - 2000).toISOString()
        const subscribedNumbers = h.runtime.repositories.threads.list().filter(thread => thread.ref.source === ref.source && thread.subscriptions.length)
          .map(thread => Number(thread.ref.id)).filter(Number.isSafeInteger)
        const subscribed = new Set(subscribedNumbers)
        const prNumbers = [...new Set([...h.runtime.repositories.snapshot().triggers.flatMap(trigger => {
          const provider = trigger.meta.provider as SourceContext | undefined
          return provider?.provider === 'github' && provider.isPullRequest && trigger.source === ref.source && subscribed.has(provider.number) ? [provider.number] : []
        }), ...h.runtime.list().flatMap(ticket => (ticket.follows ?? []).filter(follow => follow.thread.startsWith(`${ref.source}:`)).map(follow => Number(follow.thread.slice(ref.source.length + 1))))])]
        const cfg = { ...base, since: previous?.since ?? new Date(Date.now() - 86400000).toISOString(), subscribedNumbers,
          observeIssues: sourceSettings.github.allowUnaddressed, observePullRequests: sourceSettings.github.allowUnaddressed,
          observeComments: sourceSettings.github.allowUnaddressed, observeReviews: sourceSettings.github.allowUnaddressed }
        const items = await pollGitHub(cfg, signal)
        let reviews: Awaited<ReturnType<typeof pollGitHubReviewsBatch>>
        try { reviews = await pollGitHubReviewsBatch(cfg, previous?.reviews, signal) }
        catch (error) {
          const reset = restartChangedScan(error, previous, 'reviews')
          if (reset) h.runtime.writeData(key, reset)
          throw error
        }
        commit(key, [...items, ...reviews.items].map(sourceTrigger), { since: started, ...(reviews.next ? { reviews: reviews.next } : {}) })
        if (cfg.observeIssues) {
          try { h.runtime.engine.receive(await pollDefaultBranchChecks(cfg, signal)) }
          catch { signal.throwIfAborted(); errors.push('Default-branch CI could not be read.') }
        }
        for (const pull of await discoverOwnPullRequests(base, signal)) {
          const id = /^superagent\/([a-f0-9]{32})$/.exec(pull.branch)?.[1]
          const ticket = id ? h.runtime.list().find(ticket => ticket.id === id && !ticket.ended) : undefined
          if (ticket) {
            const ref = githubThreadRef(base, pull.number)
            if (pull.state === 'open' || !ticket.follows?.some(follow => follow.thread === threadKey(ref))) h.runtime.engine.bindThread(ticket.id, ref, true)
            if (!prNumbers.includes(pull.number)) prNumbers.push(pull.number)
          }
        }
        for (const number of prNumbers) {
          try {
            const checks = await pollGitHubChecks(cfg, [number], signal)
            h.runtime.repositories.atomic(() => checks.map(sourceTrigger).forEach(event => h.runtime.engine.receive(event)))
            const pr = await readPullRequest(base, number, signal)
            if (pr.state === 'closed') h.runtime.engine.threadClosed(githubThreadRef(base, number), pr.merged ? 'merged' : 'closed', pr.mergedAt ?? pr.closedAt ?? new Date().toISOString())
          } catch { signal.throwIfAborted(); errors.push(`PR #${number} CI or lifecycle could not be read.`) }
        }
      } catch { signal.throwIfAborted(); errors.push('GitHub source failed; check source scope, permissions and pagination.') }
    }
    if (sourceSettings.teams.enabled) {
      try {
        let base = await teams(config().get('delivery.enabled', false))
        if (config().get('teams.syncMembership', false)) {
          await syncMembers(false, base, signal)
          base = { ...base, allowedActors: config().get('teams.allowedActors', []) }
        }
        const scopes = [...base.chatIds.map(chat => ({ chatIds: [chat], channels: [] as TeamsSourceConfig['channels'] })),
          ...base.channels.map(channel => ({ chatIds: [] as string[], channels: [channel] }))]
        for (const scope of scopes) {
          const key = `source:teams:${fingerprint({ tenant: base.tenantId, ...scope })}`
          const previous = h.runtime.readData<{ since: string; started: string; cursor?: TeamsBatchCursor }>(key)
          try {
            const started = previous?.cursor ? previous.started : new Date(Date.now() - 2000).toISOString()
            const since = previous?.since ?? new Date(Date.now() - 86400000).toISOString()
            const activeThreads = new Set(h.runtime.repositories.threads.list().filter(thread => thread.ref.source.startsWith('teams:') && thread.subscriptions.length).map(thread => thread.key))
            const subscribedThreads = [...new Set(h.runtime.repositories.snapshot().triggers.flatMap(trigger => {
              const provider = trigger.meta.provider as SourceContext | undefined
              return provider?.provider === 'teams' && trigger.threads.some(ref => activeThreads.has(threadKey(ref))) ? [String(sourceSubscription(provider))] : []
            }))]
            const batch = await pollTeamsBatch({ ...base, ...scope, since, subscribedThreads }, previous?.cursor, signal)
            commit(key, batch.items.map(sourceTrigger), { since: batch.next ? since : started, started, ...(batch.next ? { cursor: batch.next } : {}) })
          } catch (error) {
            signal.throwIfAborted()
            const reset = restartChangedScan(error, previous, 'cursor')
            if (reset) h.runtime.writeData(key, reset)
            errors.push('A Teams scope failed; check sign-in, scope and pagination.')
          }
        }
      } catch { signal.throwIfAborted(); errors.push('Teams source failed; sign in or check tenant consent.') }
    }
    if (errors.length) throw new Error(errors.join(' '))
    return []
  }

  async function syncMembers(interactive: boolean, supplied?: TeamsDeliveryCredential, signal?: AbortSignal): Promise<void> {
    assertCurrent()
    const chatId = config().get<string>('teams.syncChatId', '')
    const credential = supplied ?? await teams(false, interactive)
    const expected = fingerprint({ tenantId: credential.tenantId, chatIds: credential.chatIds, channels: credential.channels, chatId })
    const unchanged = () => {
      assertCurrent()
      if (expected !== fingerprint({ tenantId: config().get('teams.tenantId', ''), chatIds: config().get('teams.chatIds', []), channels: config().get('teams.channels', []), chatId: config().get('teams.syncChatId', '') })) throw new Error('Membership source changed')
    }
    const members = await readTeamsMembers(credential, chatId, signal)
    unchanged()
    if (interactive) {
      const answer = await vscode.window.showWarningMessage(`Authorize the ${members.length} current members of this Teams chat?`,
        { modal: true, detail: 'Replaces the Teams requester allowlist with this exact membership snapshot. This does not change which conversations are read.' }, 'Replace allowlist')
      if (answer !== 'Replace allowlist') return
      unchanged()
    }
    const next = members.map(member => member.id)
    if (fingerprint(config().get<string[]>('teams.allowedActors', []).slice().sort()) !== fingerprint(next))
      await config().update('teams.allowedActors', next, vscode.ConfigurationTarget.Global)
    if (service && fingerprint(service.settings.value.sources.teams.allowedActors.slice().sort()) !== fingerprint(next)) {
      service.saveSettings({ sources: { teams: { allowedActors: next } } }, service.settings.revision)
      owner!.runtime.writeData('source-configuration-fingerprint', fingerprint(sourcePolicy()))
    }
  }

  async function send(message: OutboundMessage, signal: AbortSignal): Promise<void> {
    assertCurrent()
    if (!config().get('delivery.enabled', false)) throw new Error('Source replies are disabled in application settings')
    const family = message.channel.source.split(':')[0]
    const credential = family === 'github' ? await github(true) : family === 'teams' ? await teams(true) : undefined
    if (!credential) throw new Error('Unsupported reply source')
    await sendDurableReply(owner!.runtime, message, credential, { signal })
  }

  async function claimPullRequest(ticket: Ticket, number: number, signal: AbortSignal): Promise<ThreadRef> {
    const cfg = await github(), thread = githubThreadRef(cfg, number), pr = await readPullRequest(cfg, number, signal)
    const original = owner!.runtime.repositories.triggers.get(ticket.origin.triggerId)
    const sourcePull = original?.threads.some(ref => ref.source === thread.source && ref.id === thread.id)
    if (!sourcePull && (pr.author?.toLowerCase() !== cfg.account.toLowerCase() || pr.branch !== `superagent/${ticket.id}`))
      throw new Error('PR is neither this ticket’s source PR nor its own agent branch')
    return thread
  }

  async function get(): Promise<AutomationService> {
    assertCurrent()
    if (service) return service
    if (initializing) return initializing
    initializing = (async () => {
      const h = owner = await hooks.host()
      backend = new CopilotBackend({ cliPath: config().get<string>('copilot.cliPath', 'copilot'), onPermissionRequest: async (request, invocation) => {
        assertCurrent()
        const ticket = h.runtime.get(invocation.ticketId)
        if (ticket.ended || h.runtime.paused) return { kind: 'reject', feedback: 'The ticket is stopped or paused.' }
        if (ticketPermission(request, invocation.directory, config().get<string>('execution.permissionMode', 'ask') === 'ticket') === 'allow') return { kind: 'approve-once' }
        const answer = await vscode.window.showWarningMessage(`Allow ${request.kind} for ${ticket.title}?`,
          { modal: true, detail: JSON.stringify(request, null, 2).slice(0, 18000) }, 'Allow once')
        assertCurrent()
        if (h.runtime.get(ticket.id).ended || h.runtime.paused) return { kind: 'reject', feedback: 'Authorization was withdrawn.' }
        return answer === 'Allow once' ? { kind: 'approve-once', approvedInteractively: true } : { kind: 'reject', feedback: 'Declined by the operator.' }
      } })
      const prompt = await readFile(vscode.Uri.joinPath(context.extensionUri, 'dist', 'prompts', 'worker.md').fsPath, 'utf8').catch(() => '')
      const promptParts: Record<string, string> = JSON.parse(await readFile(vscode.Uri.joinPath(context.extensionUri, 'dist', 'prompts', 'defaults.json').fsPath, 'utf8').catch(() => '{}'))
      service = new AutomationService(h.runtime, { backend, prepare: ticket => h.trees.prepare(ticket.id), poll, send, changed: notify,
        systemPrompt: prompt, promptParts, claimPullRequest,
        resolveThread: async (family, id, signal) => {
          if (family !== 'github' || !/^[1-9]\d*$/.test(id)) throw new Error('Use a complete scoped Teams thread identity')
          const credential = await github(); signal.throwIfAborted()
          return githubThreadRef(credential, Number(id))
        },
        readSource: async (ticketId, request, signal) => {
          const ticket = h.runtime.get(ticketId)
          const input = record(request) ? request : {}
          const trigger = typeof input.triggerId === 'string' ? h.runtime.repositories.triggers.get(input.triggerId) : undefined
          const family = typeof input.resource === 'string' && input.resource.startsWith('github/') ? 'github' : undefined
          const channel = trigger?.channel ?? ticket.channels.find(channel => family ? channel.source.startsWith(family) : true)
          const credential = family === 'github' || channel?.source.startsWith('github:') ? await github(input.action === 'resolve') : await teams()
          if (input.action === 'resolve') {
            if (!channel || credential.provider !== 'github' || !config().get('delivery.enabled', false)) throw new Error('Review writes are not enabled')
            return resolveGitHubReviewThread(channel, credential, { signal })
          }
          return resources.read(ticketId, channel, credential, input, signal)
        } })
      return service
    })().finally(() => { initializing = undefined })
    return initializing
  }

  async function start(): Promise<void> {
    assertCurrent()
    const answer = await vscode.window.showWarningMessage('Start continuous Superagent work for this repository?', { modal: true,
      detail: 'Configured sources will be polled and authorized requests will start persistent Copilot workers in separate worktrees. Policy and source allowlists stay under your control. Choose whether ticket authorization also covers worker commands.' }, 'Confirm each tool', 'Run within approved tickets')
    if (!answer) return
    await config().update('execution.permissionMode', answer === 'Run within approved tickets' ? 'ticket' : 'ask', vscode.ConfigurationTarget.Global)
    const writes = await vscode.window.showWarningMessage('Enable replies to the configured source conversations?', { modal: true,
      detail: 'The service can acknowledge requests, ask questions and deliver results to their original GitHub or Teams conversation. This requires write scopes for those sources.' }, 'Enable replies', 'Keep replies local')
    await config().update('delivery.enabled', writes === 'Enable replies', vscode.ConfigurationTarget.Global)
    if (sourcePolicy().teams.enabled) await teams(writes === 'Enable replies', true)
    const s = await get()
    const health = await backend!.check()
    if (!health.authenticated) throw new Error('Sign in to the configured Copilot CLI before starting Superagent')
    s.saveSettings({ ...s.settings.value, enabled: true, sources: sourcePolicy() }, s.settings.revision)
    await config().update('service.enabled', true, vscode.ConfigurationTarget.Global)
    s.start(); panel.show(); notify()
  }

  async function action(message: Record<string, unknown>): Promise<void> {
    assertCurrent()
    const action = message.action, id = typeof message.id === 'string' ? message.id : ''
    if (action === 'refresh') { panel.refresh(); return }
    if (action === 'start') { await start(); return }
    if (action === 'configureSources') { await vscode.commands.executeCommand('workbench.action.openSettings', 'superagent'); return }
    const s = await get(), h = owner!
    switch (action) {
      case 'poll': await s.pollNow(); break
      case 'stopService':
        s.saveSettings({ ...s.settings.value, enabled: false }, s.settings.revision)
        await config().update('service.enabled', false, vscode.ConfigurationTarget.Global); await s.stop(); break
      case 'pause': h.runtime.setPaused(!h.runtime.paused); s.kick(); break
      case 'new': await vscode.commands.executeCommand('superagent.new'); s.kick(); break
      case 'openTicket': {
        h.runtime.get(id); const directory = await h.trees.prepare(id)
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), { forceNewWindow: true }); break
      }
      case 'followup': {
        h.runtime.get(id); const text = await vscode.window.showInputBox({ prompt: 'Continue this ticket with an in-scope request', ignoreFocusOut: true })
        assertCurrent(); if (text?.trim()) { h.runtime.followup(id, text); s.kick() } break
      }
      case 'stopTicket': h.runtime.stop(id); s.kick(); break
      case 'retry': h.runtime.retry(id); s.kick(); break
      case 'retryEffect': s.retryEffect(id); break
      case 'unsubscribe': h.runtime.engine.unsubscribe(id); s.kick(); break
      case 'reevaluate': h.runtime.engine.reevaluate(id); s.kick(); break
      case 'conversation': {
        const ticket = h.runtime.get(id)
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(h.runtime.context(ticket.id), null, 2) })
        await vscode.window.showTextDocument(doc); break
      }
      case 'saveSettings':
        if (!Number.isSafeInteger(message.revision)) throw new Error('Invalid settings revision')
        s.saveSettings(message.value, message.revision as number); s.kick(); break
      case 'restoreSettings':
        if (!Number.isSafeInteger(message.revision) || !Number.isSafeInteger(message.baseRevision)) throw new Error('Invalid settings revision')
        s.restoreSettings(message.revision as number, message.baseRevision as number); break
      case 'previewWorker': case 'previewAssessor': {
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: s.previewPrompt(action === 'previewWorker' ? 'worker' : 'assessor') })
        await vscode.window.showTextDocument(doc); break
      }
      default: throw new Error('Unknown supervision action')
    }
    notify()
  }

  const register = (name: string, callback: () => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(`superagent.${name}`, () =>
    callback().catch(() => vscode.window.showErrorMessage('Superagent could not complete the operation. Check configured credentials, Copilot CLI sign-in and service policy.'))))
  register('dashboard', async () => { await get(); panel.show() })
  register('startService', start)
  register('stopService', () => action({ action: 'stopService' }))
  register('checkService', async () => { await get(); const status = await backend!.check(); await vscode.window.showInformationMessage(`Copilot ${status.cliVersion}: ${status.authenticated ? 'signed in' : 'sign-in required'}. No model request was sent.`) })
  register('syncTeamsMembers', () => syncMembers(true))

  if (vscode.chat?.createChatParticipant) {
    const participant = vscode.chat.createChatParticipant('superagent.router', async (request, _chat, response, token) => {
      try {
        const s = await get()
        if (request.command === 'status') { response.markdown(JSON.stringify(s.snapshot(), null, 2)); return }
        if (request.command === 'panel') { panel.show(); response.markdown('Superagent supervision is open.'); return }
        if (token.isCancellationRequested) return
        const h = owner!, ticket = h.runtime.create(request.prompt)
        s.kick(); response.markdown(`Ticket **${ticket.title.replace(/[\\`*_{}[\]()<>]/g, '')}** is ${s.settings.value.enabled ? 'queued for Copilot' : 'recorded. Start the service to execute it'}.`)
        response.button({ command: 'superagent.dashboard', title: 'Open Superagent' })
      } catch { response.markdown('Superagent could not accept this request. Check service settings and Copilot sign-in.') }
    })
    context.subscriptions.push(participant)
  }
  context.subscriptions.push(vscode.lm.registerTool<{ request?: string; ticketId?: string; status?: boolean }>('superagent_route', {
    async invoke(options, token) {
      const s = await get()
      if (options.input.status === true) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(s.snapshot()))])
      const request = options.input.request
      if (typeof request !== 'string' || !request.trim() || request.length > 50000) throw new Error('Provide the original approved request')
      if (token.isCancellationRequested) throw new Error('Cancelled')
      const ticket = options.input.ticketId ? owner!.runtime.followup(options.input.ticketId, request) : owner!.runtime.create(request); s.kick()
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ ticketId: ticket.id, title: ticket.title, automated: s.settings.value.enabled }))])
    }
  }))
  if (config().get('service.enabled', false)) void get().then(s => { if (s.settings.value.enabled) s.start() }).catch(() => {})
  const disposable: AutomationLifecycle = {
    get active() { return !!service },
    shutdown() {
      closing = true; panel.dispose()
      return shutdownPromise ??= (async () => {
        if (initializing) await initializing.catch(() => {})
        if (service) await service.dispose()
        else if (backend) await backend.dispose()
      })()
    },
    dispose() { void this.shutdown().catch(() => {}) },
  }
  context.subscriptions.push(disposable)
  return disposable
}
