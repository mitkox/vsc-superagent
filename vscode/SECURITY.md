# Security and deployment boundaries

Superagent uses the shared ticket engine and the official Copilot SDK through an installed Copilot CLI over stdio. It polls configured GitHub/Teams sources, launches authorized coding sessions and sends replies when explicitly enabled. It has no extension telemetry exporter, HTTP listener or automatic updater. Copilot inference and provider operational logging remain governed by their services and organization policies.

## Authorization and execution

Workspace Trust, one file-backed repository, privacy checks and application-scoped source configuration are required. Provider/model text cannot change settings or credentials. Continuous execution and source sending start after native operator setup. Allowed explicit requests grant immutable bounded mandates; proactive work additionally requires an enabled acceptance mode and matching rules. Bots/CI provide context, never explicit authority.

Operators choose confirmation for each worker permission or execution within approved ticket mandates. Unattended shell commands run as the operator and can invoke programs, Git and network clients. Worktrees isolate changes, not privileges; use an OS/container sandbox and network policy for actual isolation. Managed approvals and sandbox bypasses remain interactive. Late approvals are rejected after cancellation. Pause/stop/revocation withdraw future custom-tool authority and request native worker abort.

Ready means human review requested, not CI, independent approval, merge, deployment or acceptance. PR binding verifies the source PR or configured agent's exact ticket branch. Auto-merge requires a separately configured merge CLI and delivery conditions. Server-side branch protection, independent review and protected deployment environments remain authoritative.

## Source boundaries

GitHub credentials use SecretStorage bound to exact origin/repository. Graph credentials come from tenant-pinned Microsoft authentication. Tokens are supplied afresh and not persisted in ticket state. HTTPS, locally constructed fixed/configured paths, no redirects, exact-path pagination, cancellation and response/page limits constrain provider requests.

Teams sends require delegated Graph scopes and target the original message. `/me` identifies the authenticated sender so its messages are excluded. Full context retains native IDs, URLs, review roots, file/line positions and quote references. External text is rendered as plaintext and passed as untrusted model context. Core gates restrict replies to reached conversations; context subscriptions grant no writing authority. Review resolution verifies the exact repository/PR thread. Source sending and CLI publishing have separate permission/credential boundaries.

Messages are persisted before dispatch. Authenticated receipt markers reconcile uncertain sends. Missing receipts do not prove non-delivery; the service keeps an actionable failure rather than repeating the POST. This is safe reconciliation, not a universal exactly-once provider guarantee.

## State and recovery

State is namespaced by canonical Git common directory. POSIX files/directories use private modes. Checksums, fsync, atomic replacement and exclusive writer ownership protect durable records. Events and cursor advancement share a transaction. Assignments, sessions, inputs, policy/prompt revisions and operations survive restart; workers retain their worktrees and conversation identities.

State includes provider text and local session transcripts. It is not encrypted or an immutable compliance ledger, and does not protect against the same OS user or a compromised extension host. Use encrypted storage, OS ACLs, retention controls and backups. Do not place secrets in ticket text. Copilot's own persistent session store is separate. Windows mode bits do not establish ACL isolation.

Closing the workspace extension host stops its service; an enabled service resumes on reopening. Corruption and uncertain lock ownership fail closed. Preserve state and verify owner processes before manual recovery; never reset unrelated checkouts or delete worktrees to recover a ticket.

Automatic lock recovery requires a confirmed dead PID on the same host and serializes reclamation with acquisition. A leftover `state.lock.acquire` guard is deliberately not reclaimed without inspection. PID reuse or inaccessible owner state preserves the lock.

## Privacy and rollout qualification

Local checks cover product telemetry, known Copilot/Agent Host exporters and debug logging. Apply Local Privacy Settings changes user settings only after native confirmation; startup-active exporters require reload after disabling. The SDK child disables known exporter variables. Other extensions, Microsoft sign-in, Copilot, GitHub, Graph and native tools remain separate logging boundaries. Cloud model execution includes data egress.

Before rollout, build from the lockfile, run checks/audits, inspect the VSIX/hash, and sign/distribute through the approved extension process. Validate exact editor/CLI/OS versions, allowed/denied tenants and senders, replies, revoked credentials, conditional access, pagination, cancellation and crash recovery in a test repository/tenant. Inspect traffic and classify source/model data. Fixtures and registration smoke tests do not qualify tenant access, scale or release readiness.

Report security findings privately to deployment maintainers; never post tokens or confidential source/ticket content publicly.
