import type { OutboundMessage } from '../../src/core/index.ts'
import { DeliveryError, deliverSourceReply, type DeliveryOptions, type SourceDeliveryCredential } from './delivery.ts'
import type { TicketRuntime } from './runtime.ts'

/** The attempted marker survives a crash between the provider commit and the local receipt commit. */
export async function sendDurableReply(journal: Pick<TicketRuntime, 'readData' | 'writeData'>, message: OutboundMessage,
  credential: SourceDeliveryCredential, options: Omit<DeliveryOptions, 'retry'> = {}): Promise<void> {
  const key = `delivery:${message.id}`, prior = journal.readData<{ attempted: boolean; receipt?: unknown }>(key)
  if (prior?.receipt) return
  journal.writeData(key, { attempted: true })
  try {
    const receipt = await deliverSourceReply(message.channel, message, credential,
      { ...options, ...(prior?.attempted ? { retry: 'reconcile' as const } : {}) })
    journal.writeData(key, { attempted: true, receipt })
  } catch (error) {
    if (error instanceof DeliveryError && error.outcome === 'not-sent') journal.writeData(key, { attempted: false })
    throw error
  }
}
