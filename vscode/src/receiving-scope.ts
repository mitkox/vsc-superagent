import type { ChannelRef, Trigger } from '../../src/core/index.ts'
import { admissionReceivingScopes, type AdmissionReceivingConfig } from './admission-consent.ts'
import { sourceAdmissionRow } from './settings.ts'

/** A native receiving configuration grants only producer-proved scopes; display text and body URLs grant nothing. */
export function receivesNativeSource(input: Pick<Trigger, 'source' | 'meta'>, config: AdmissionReceivingConfig): boolean {
  if (input.source === 'vscode') return true
  try {
    const row = sourceAdmissionRow(input)
    return row !== undefined && admissionReceivingScopes(config).some(scope => scope.key === row)
  } catch { return false }
}

/** Local operator mandates remain valid, but provider delivery still needs its original exact configured destination. */
export function receivesNativeChannel(channel: ChannelRef, config: AdmissionReceivingConfig): boolean {
  const address = channel.address
  if (channel.source.startsWith('github:')) {
    if (channel.thread !== `${channel.source}:${address.number}`) return false
    return receivesNativeSource({ source: channel.source, meta: { provider: { ...address, provider: 'github', kind: 'comment',
      number: Number(address.number), nativeThreadId: address.number } } }, config)
  }
  if (channel.source.startsWith('teams:')) {
    if (channel.thread !== `${channel.source}:${address.rootMessageId}`) return false
    return receivesNativeSource({ source: channel.source, meta: { provider: { ...address, provider: 'teams', nativeThreadId: address.rootMessageId } } }, config)
  }
  return false
}
