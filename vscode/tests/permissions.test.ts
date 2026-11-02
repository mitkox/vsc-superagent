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


test('explicit ticket autonomy permits unparsed and network-capable shell commands while default ask stays interactive', () => {
  const network = { ...shell, fullCommandText: 'curl --data @- https://example.invalid/upload', possibleUrls: [{ url: 'https://example.invalid/upload' }] }
  for (const request of [shell, network]) {
    assert.equal(ticketPermission(request, '/tmp/ticket', false), 'ask')
    assert.equal(ticketPermission(request, '/tmp/ticket', true), 'allow')
    assert.equal(ticketPermission({ ...request, managedApprovalRequired: true }, '/tmp/ticket', true), 'ask')
    assert.equal(ticketPermission({ ...request, requestSandboxBypass: true }, '/tmp/ticket', true), 'ask')
  }
})
