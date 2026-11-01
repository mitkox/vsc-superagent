import assert from 'node:assert/strict'
import type { PermissionRequest } from '@github/copilot-sdk'
import { test } from 'node:test'
import { ticketPermission } from '../src/permissions.ts'

const shell: PermissionRequest = { kind: 'shell', fullCommandText: 'npm test', commands: [], intention: 'Run tests',
  hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [], canOfferSessionApproval: false }
test('ticket autonomy keeps managed and sandbox escalation requests interactive', () => {
  assert.equal(ticketPermission(shell, '/tmp/ticket', true), 'allow')
  assert.equal(ticketPermission(shell, '/tmp/ticket', false), 'ask')
  assert.equal(ticketPermission({ ...shell, managedApprovalRequired: true }, '/tmp/ticket', true), 'ask')
  assert.equal(ticketPermission({ ...shell, requestSandboxBypass: true }, '/tmp/ticket', true), 'ask')
  assert.equal(ticketPermission({ ...shell, possiblePaths: ['/home/another-user'] }, '/tmp/ticket', true), 'ask')
})
