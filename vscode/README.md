# Superagent for Copilot

Continuous repository agents inside VS Code, using the original dsh-superagent ticket engine, the official GitHub Copilot SDK, GitHub and **Microsoft Teams**.

An authorized request is assessed, assigned a persistent Copilot session and isolated Git worktree, and worked through implementation and verification. Source follow-ups, reviews and CI reach the same ticket. Acknowledgements, questions and results return to the original conversation when delivery is enabled. Supervision shows work needing attention, sources, triggers, decisions, execution, transcripts and versioned settings.

The service requires a running VS Code workspace extension host. Closing that host stops its workers; reopening resumes an enabled service and recovers durable assignments. It does not install an operating-system daemon.

## Install

Requirements: VS Code **1.144+**, Git, Node **22.19+**, and an installed, authenticated **GitHub Copilot CLI** compatible with SDK **1.0.28** (connection validated with CLI **1.0.105**, protocol **3**). The SDK uses existing Copilot sign-in; no OpenAI or DeepSeek key is required. Organization policies and subscription permissions apply.

From this directory:

```sh
npm ci --ignore-scripts
npm run package
code-insiders --install-extension dist/vsc-superagent.vsix
```

Use `code` instead for a supported stable build. The publisher `superagent-local` is a local package identity. SDK JavaScript and adapted original prompts are bundled; the installed CLI runs through stdio. There is no extension HTTP listener or runtime download. Set `superagent.copilot.cliPath` when the executable is not on the extension host's PATH.

## Start work

1. Open one trusted, file-backed Git repository. Multi-root and virtual workspaces are unsupported.
2. Run **Superagent: Apply Local Privacy Settings**, then reload. Known VS Code/Copilot exporters must be disabled before work tools become available. The debug file logging setting `github.copilot.chat.agentDebugLog.fileLogging.enabled` must be explicitly `false`, including when set by policy or a language-specific override. Values that disable exporters, such as `COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null`, are accepted; active exporter errors name the setting or variable without exposing its value.
3. Configure the source scopes and allowed requester identities below.
4. Run **Superagent: Check Copilot Connection** to check CLI protocol and login without a model request.
5. Run **Superagent: Start Service**. Choose per-tool confirmation or execution within approved ticket mandates, and whether source replies are enabled. Complete Microsoft sign-in for Teams.
6. Select **Superagent** in the Copilot agent picker and state the work, use **@superagent**, or submit a request in an enabled source conversation.
7. Use **Superagent: Open Supervision** to answer questions, add follow-ups, inspect transcripts, pause, stop, retry or change policy.

The native agent delegates the unchanged request rather than implementing a duplicate task in the routing chat. `@superagent /status` reads state and `/panel` opens supervision. Dispatch supports an explicit ticket ID for an in-scope follow-up. The previous manual New Ticket / Review / Continue workflow remains available.

Workers start from the primary checkout's committed HEAD, preserving dirty files. Each ticket retains its worktree, branch and Copilot session. Inspection opens a separate window when the service is active. Ticket authorization covers unattended shell commands only when the operator chooses that mode. These commands run as the operator; a worktree is not an OS sandbox. Managed approvals, sandbox bypasses, unknown tools and direct SDK file requests outside the ticket still require native confirmation. Shell path/URL metadata is advisory and does not confine programs: commands may read environment variables, access files beyond the worktree and use the network as the operator. The built-in source reply switch does not restrict arbitrary CLI commands; use an OS/container sandbox and network policy for isolation.

## GitHub

Configure application/user settings, never repository settings:

```json
{
  "superagent.github.origin": "https://api.github.com",
  "superagent.github.repository": "your-org/your-repo",
  "superagent.github.account": "your-agent-account",
  "superagent.github.allowedActors": ["approved-requester"],
  "superagent.github.allowedBots": ["github-actions[bot]"],
  "superagent.github.observe": false
}
```

GitHub Enterprise Server supports an explicitly configured HTTPS `/api/v3` base. **Configure Source Credential** stores a fine-grained token in VS Code SecretStorage, bound to the exact origin/repository. Intake needs Issues, Pull requests and Metadata read; CI needs Checks and Commit statuses read. Replies/review resolution need the corresponding write permissions. Worker Git/gh publishing uses its CLI identity and ticket delivery instructions independently.

Allowed people can mention the agent to request work. With `github.observe` enabled, unaddressed activity can be assessed under proactive rules. Subscribed threads deliver human/bot context without repeated mentions. Bots never grant explicit authority. Reviews have an independent resumable scan because edits lack a reliable PR-update cursor. Reported PRs are verified against the actual source PR or the configured agent's `superagent/<ticket-id>` branch. Own PR discovery and actual provider close/merge readback update completion.

## Microsoft Teams

Teams replaces Feishu. Use Entra tenant/user **object UUIDs**, not display names:

```json
{
  "superagent.teams.tenantId": "11111111-1111-1111-1111-111111111111",
  "superagent.teams.chatIds": ["19:your-chat-id@thread.v2"],
  "superagent.teams.channels": [
    { "teamId": "22222222-2222-2222-2222-222222222222", "channelId": "19:your-channel-id@thread.tacv2" }
  ],
  "superagent.teams.allowedActors": ["33333333-3333-3333-3333-333333333333"]
}
```

The built-in Microsoft provider selects the configured tenant. Delegated scopes are `User.Read` for sender identity, `Chat.Read` and/or `ChannelMessage.Read.All` for intake. Replies add `ChatMessage.Send` and/or `ChannelMessage.Send`. Membership sync adds `ChatMember.Read`. Administrator consent and conditional-access policy may apply. No app secret, bot registration, webhook or token pasted into settings is required. Only public-cloud `https://graph.microsoft.com/v1.0` is supported.

To synchronize requesters from a chat's members, set `superagent.teams.syncChatId` to one of the approved `chatIds`, then run **Superagent: Sync Teams Members** and review the replacement allowlist. Enable `superagent.teams.syncMembership` only when that chat's ongoing membership should authorize future requests.

Channel replies target the original root; chat replies use `replyWithQuote`. Context retains tenant, chat/team/channel, root, message, quote references, sender, edit time and URL. Sender identity is resolved through `/me` to exclude the service's own messages. HTML is reduced to text; attachments are not automatically downloaded or sent to a model.

## Policy, prompts and delivery

Supervision Settings contains the versioned policy. Unlisted senders are ignored by default. Explicit allowed requests work in every proactive mode. Setting `admission.unlistedAddressed` to `explicit` deliberately lets anyone who addresses the agent originate work in that provider's configured scopes, including in `off` and `observe`. Removing a person from `allowedActors` does not deny new requests while another admission grant permits them. `off` ignores inferred candidates; `observe` assesses without starting proactive work; `auto` starts work only with enabled matching rules. Bots and unaddressed messages cannot receive explicit authority.

The existing `sources.<provider>.admission` table remains a family-wide fallback, including future configured scopes. Optional `admissionByScope` rows override individual cells; omitted cells inherit the family fallback. Copy exact keys from **Configured receiving scope keys** in Settings. GitHub keys are `<repository source namespace>:issues`, `:pulls`, `:comments` (including reviews) and `:ci`. Teams keys bind the tenant and exact chat or team/channel: `tenant:<tenant UUID>:chat:<chat ID>` or `tenant:<tenant UUID>:team:<team UUID>:channel:<channel ID>`. These rows only apply to native configured receiving scopes; they do not add conversations or credentials. A dedicated support chat can use an explicit row while other chats retain the default ignore behavior. Removing a narrowing row can reveal a broader family fallback.

Save and Restore ask for native approval when unlisted sender grants broaden, including dormant-source/reception activation and restoring a broader policy. The dialog names affected scopes and the possible operator-identity command grant. Unchanged and narrowing policies do not prompt. The exact validated candidate and base revision are rechecked after consent. Settings always displays committed grants; Start also summarizes persisted policy. Previously saved family grants retain their meaning on reopen, with no background or per-request consent dialogs. Weakening a current cell or disabling its source withdraws future authority; native-approved local imports retain their separate local grant.

Native requester, bot, enabled and observation changes apply immediately to the corresponding policy field; unchanged native fields preserve dashboard overrides. Per-field applied fingerprints survive reopen, and native configuration events, setup and polling share the same partial reconciliation. Permission checks project pending native changes without writing state. Legacy global fingerprints seed the new baseline unchanged when they match, or recover it from hash-proved settings history. If no baseline can be proved, one conservative migration narrows lists/switches against current native values; review old overrides before restoring them. Admission tables, scoped rows, rules and source history are preserved.

Changing the native GitHub origin/repository or removing a Teams tenant/conversation withdraws source-derived execution, including active tool and permission requests. Equivalent canonical identities and added scopes retain existing grants. Unprovable historical provider scope fails closed; retained source history is preserved. Native-approved local imports retain their separate execution grant, but provider writes still require their original exact destination to be currently configured.

The scoped `ci` row accepts only `unlistedUnaddressed: "inferred"` or `"ignore"`. Its inferred path requires authenticated default-branch readback, unaddressed reception, an active inferred mode and enabled matched rules before execution. It does not promote bot prose or replace PR receipt checks. With no scoped CI opt-in, the existing bot-list behavior remains. Start with observe and inspect decisions before enabling proactive acceptance. Actors/bots, worker concurrency, human priority, models, poll interval and retry limits remain configurable; saves use revision checks and retained history.

Automatic assessments combine only requests with the same sender and receiving-row grant. An older ticket whose accepted scope combined different grants keeps its history, but cannot execute that mixed scope, even if every sender is allowlisted again. Stop the old ticket, then submit fresh requests separately under each grant; normal same-grant batches continue unchanged.

Original worker, communication, scope, delivery and GitHub instructions are packaged with Teams guidance. Team sections, built-in part overrides and team skills are editable. Overrides retain their original default; upgrades identify changed defaults. Worker/assessment previews are separate. Assessments receive source facts and a structured outcome tool without repository execution tools. Policy changes revalidate pending/running authority.

Useful acknowledgements, questions and ready results are relayed; routine progress stays internal. Core reply gates enforce source-thread ownership. Replies are queued durably before sending. Messages beyond the source delivery ceiling use one shortened representation with the beginning, ending and an explicit notice; full reports and queued text remain available in local supervision. Uncertain HTTP outcomes reconcile authenticated receipt markers instead of blindly repeating POSTs. A missing receipt leaves an actionable failed operation; Retry operation checks it again. Publishing and merging follow worker permissions, the immutable mandate, delivery requirements and server-side protections. Original default auto-merge conditions require a separately named merge CLI; none is configured by default.

## Storage and verification

Private state is keyed by canonical Git common directory, with checksums, atomic commits and an exclusive writer lock. Events and source cursors commit together. State retains source context, tickets, assignments, settings/prompts history, transcripts and pending operations, without credentials. Back up state and worktrees together. Corrupt/incompatible state fails closed; preserve it during lock recovery. Branches/worktrees are retained.

Confirmed dead owners on the same host can be recovered automatically. Active or unverifiable owners stay protected. A crash during the short acquisition guard can leave `state.lock.acquire`; inspect owner processes before recovering that guard. State is bounded at 16 MiB. Supervision transcripts are diagnostic tails: at most 500 events per session share a 2 MiB serialized UTF-8 budget, which shrinks further when business records need space. Streamed diagnostics are buffered for up to a short timer interval and drained on worker termination or service stop. Pending diagnostics share a 2 MiB/2,000-event buffer with at most 500 per session; pressure may trim older pending entries. An abrupt process crash can lose the recent unflushed diagnostic tail. Source messages, mandates, reports and effects still commit durably without this delay. Older transcript events can be pruned; source history, tickets, mandates, settings and operations are not evicted. Business records alone exceeding the state limit fail closed. Copilot maintains its own persistent conversation separately.

Requests have ten-second deadlines and one-MiB response caps. Most lists/context reads have five-page bounds. Reviews and channel-root scans retain continuation checkpoints. Large histories take multiple cycles; oversized individual threads need operator attention. Successful independent sources can commit despite another source failing. Chat quotes use scoped ancestor reads bounded to 20 edges per chain and 50 missing ancestors per batch. Unavailable, conflicting or cyclic ancestry preserves that chat's progress and reports the affected message for inspection and retry.

`npm run check` runs typechecking, behavioral tests, shared core tests, bundling and package checks. `npm run audit:production` checks runtime advisories. Fixtures establish adapter/scheduler behavior; tenant permissions, deployment-scale pagination, Copilot policy and OS/remote-host combinations need live acceptance. See [SECURITY.md](SECURITY.md).
