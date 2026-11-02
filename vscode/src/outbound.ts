import type { OutboundMessage } from '../../src/core/index.ts'
import { DeliveryError, deliverSourceReply, MAX_SOURCE_REPLY_LENGTH, type DeliveryOptions, type SourceDeliveryCredential } from './delivery.ts'
import type { TicketRuntime } from './runtime.ts'

/** Keep the full durable message; only its external representation is shortened. */
function sourceMessage(message: OutboundMessage): OutboundMessage {
  const text = message.text
  if (typeof text !== 'string' || text.length <= MAX_SOURCE_REPLY_LENGTH || !text.trim()) return message
  const notice = '\n\n[Message shortened for source delivery. Full text is available in Superagent supervision.]\n\n'
  const available = MAX_SOURCE_REPLY_LENGTH - notice.length
  let headEnd = Math.ceil(available / 2), tailStart = text.length - Math.floor(available / 2)
  const splitsPair = (offset: number) => text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
  if (splitsPair(headEnd)) headEnd--
  if (splitsPair(tailStart)) tailStart++
  return { ...message, text: text.slice(0, headEnd) + notice + text.slice(tailStart) }
}

/** The attempted marker survives a crash between the provider commit and the local receipt commit. */
export async function sendDurableReply(journal: Pick<TicketRuntime, 'readData' | 'writeData'>, message: OutboundMessage,
  credential: SourceDeliveryCredential, options: Omit<DeliveryOptions, 'retry'> = {}): Promise<void> {
  const key = `delivery:${message.id}`, prior = journal.readData<{ attempted: boolean; receipt?: unknown }>(key)
  if (prior?.receipt) return
  let attempted = false
  try {
    const receipt = await deliverSourceReply(message.channel, sourceMessage(message), credential,
      { ...options, beforeSubmit: () => {
        options.beforeSubmit?.()
        if (options.signal?.aborted) throw new DeliveryError('Source request cancelled', 'not-sent')
        journal.writeData(key, { attempted: true })
        attempted = true
      }, ...(prior?.attempted ? { retry: 'reconcile' as const } : {}) })
    journal.writeData(key, { attempted: true, receipt })
  } catch (error) {
    if (!prior?.attempted && attempted && error instanceof DeliveryError && error.outcome === 'not-sent') journal.writeData(key, { attempted: false })
    throw error
  }
}
