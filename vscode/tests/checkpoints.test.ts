import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restartChangedScan } from '../src/checkpoints.ts'
import { SourceError } from '../src/sources.ts'

test('a reordered source page restarts continuation without skipping its original lookback', () => {
  const since = '2026-10-31T00:00:00.000Z'
  const reviews = { since, reviews: { prPage: 2, prOffset: 4, reviewPage: 3 } }
  const channel = { since, started: '2026-11-01T00:00:00.000Z', cursor: { offset: 25 } }
  assert.deepEqual(restartChangedScan(new SourceError('GitHub review scan changed; restart the scan'), reviews, 'reviews'), { since })
  assert.deepEqual(restartChangedScan(new SourceError('Source page changed; restart the channel scan'), channel, 'cursor'), { since, started: channel.started })
  assert.equal(reviews.reviews.prPage, 2)
  assert.equal(restartChangedScan(new SourceError('Source request rejected'), reviews, 'reviews'), undefined)
})
