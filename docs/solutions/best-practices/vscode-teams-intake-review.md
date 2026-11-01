---
title: Review VS Code ticket and Teams intake boundaries
module: VS Code extension and Teams intake
date: 2026-11-01
problem_type: best_practice
component: messaging
severity: high
category: best-practices
tags: [vscode, teams, microsoft-graph, github, intake, worktrees]
applies_when:
  - Reviewing or changing approved inbox ingestion and ticket workflows
---

# Review VS Code ticket and Teams intake boundaries

## Context

The initial extension review found gaps in bounded source scans, deduplication, and ticket state transitions. These were reproduced with local fixtures; provider behavior and permissions still require live qualification.

## Verified guidance

1. **Bound work per invocation, not total channel history.** `pollTeamsBatch` in `vscode/src/sources.ts` processes up to 25 roots, including replies to old roots, and returns continuation state. `vscode/src/extension.ts` preserves the original lookback until the source completes, advances each source independently, and restarts a partially processed page if its root IDs change. The tests cover a 26th old root with a new reply, continuation after reload, page reordering, and a failed channel alongside a successful GitHub source. A single root's replies still have a five-page limit; cross-page Graph continuation behavior has not been qualified live.
2. **Do not treat reaction activity as a text edit.** Teams IDs combine scope, sender, message, text, and `lastEditedDateTime`; `lastModifiedDateTime` changes for reactions. Tests distinguish a reaction from an edit. Existing receipts from the previous ID format can cause a one-time reappearance. See [Graph chatMessage properties](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0).
3. **Scan review bodies independently of PR update time.** The [GitHub review API](https://docs.github.com/en/rest/pulls/reviews) supplies submission time but no reliable body-edit cursor. `pollGitHubReviewsBatch` in `vscode/src/sources.ts` walks all open and closed PRs in creation order and pages through every review; it derives the candidate ID from the review body and retains independent source progress only after a batch is decided. It checks the previous PR/review page before continuing so changed pagination restarts the cycle. The initial cycle can surface old mentions; edits made after a PR's turn appear in a subsequent cycle. Regression tests cover an unchanged old PR, repeat deduplication, continuation beyond 25 PRs and 25 review pages, changed pagination, and a decision deferred across reload. This is explicit foreground polling: users must repeat inbox checks until the cycle completes, and live GitHub/GHES behavior remains to be qualified.
4. **Commit a PR binding and its report together.** `TicketRuntime.reportWithPullRequest` writes both in one durable transaction, and checks the source from the bound thread rather than separate global state. A rejected ready report with a question rolls back the binding; the regression checks the later ready report can complete.
5. **Check the active branch at tool access.** `Worktrees.ticketAt` requires the expected ticket branch as well as the worktree path and common repository. A regression detaches HEAD and verifies access is refused. The snapshot rechecks the worktree after consent.
6. **Make resumed ready work active before exposing it.** The snapshot tool requests consent for a ready PR-following ticket and calls `begin`, which records progress. The test covers declined consent and the subsequent approved transition. Snapshot and report operations share the extension's exclusive-operation guard.

## Validation and boundaries

The extension's check runs typechecking, Node regression tests, shared core-engine tests, bundling and package checks. Test fixtures simulate provider responses and a VS Code host; they do not prove live Teams, GitHub or Copilot integration. See `vscode/README.md` for the current bounds and migration caveat.
