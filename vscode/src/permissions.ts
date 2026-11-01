import { isAbsolute, relative, resolve } from 'node:path'
import type { PermissionRequest } from '@github/copilot-sdk'

/** Ticket autonomy is an operator grant, not a grant derived from provider or model text. */
export function ticketPermission(request: PermissionRequest, directory: string, autonomous: boolean): 'allow' | 'ask' | 'deny' {
  if (request.managedApprovalRequired || !autonomous) return 'ask'
  if (request.kind === 'shell' && request.requestSandboxBypass) return 'ask'
  const within = (file: string) => {
    const path = resolve(directory, file)
    const offset = relative(directory, path)
    return offset === '' || offset !== '..' && !offset.startsWith('../') && !offset.startsWith('..\\') && !isAbsolute(offset)
  }
  switch (request.kind) {
    case 'read': return request.path && within(request.path) ? 'allow' : 'ask'
    case 'write': return within(request.fileName) ? 'allow' : 'ask'
    // As in DSH, shell access runs as the operator and is not a filesystem sandbox.
    // The service's explicit native grant covers commands within the ticket mandate.
    case 'shell': return request.possiblePaths.every(within) ? 'allow' : 'ask'
    case 'custom-tool': return request.toolName.startsWith('orchestrator_') || request.toolName.startsWith('superagent_') ? 'allow' : 'ask'
    default: return 'ask'
  }
}
