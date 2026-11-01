import type { AssessmentOutcome } from '../../src/core/index.ts'

export interface AgentTool {
  name: string
  description: string
  schema: Record<string, unknown>
  invoke(args: unknown): Promise<unknown>
}

export interface AgentEvent { type: string; text: string; at: string }

export interface AgentRun {
  ticketId: string
  sessionId: string
  directory: string
  prompt: string
  systemPrompt: string
  model?: string
  tools: AgentTool[]
  signal: AbortSignal
  onEvent(event: AgentEvent): void
}

export interface AgentBackend {
  run(input: AgentRun): Promise<void>
  assess(prompt: string, signal: AbortSignal, model?: string): Promise<AssessmentOutcome>
  abort(ticketId: string): Promise<void>
  dispose(): Promise<void>
}
