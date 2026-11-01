import { SourceError } from './sources.ts'

/** A provider page reorder invalidates its continuation, never the retained lookback. */
export function restartChangedScan<T extends object>(error: unknown, progress: T | undefined, field: keyof T): T | undefined {
  if (!progress || !(error instanceof SourceError) || ![
    'Source page changed; restart the channel scan', 'GitHub review scan changed; restart the scan',
  ].includes(error.message)) return undefined
  const restarted = { ...progress }
  delete restarted[field]
  return restarted
}
