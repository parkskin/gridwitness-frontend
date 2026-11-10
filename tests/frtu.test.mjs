import test from 'node:test'
import assert from 'node:assert/strict'
import { frtuHistory } from '../src/lib/frtu.ts'
import { getVillage } from '../src/lib/village.ts'

function serialSnapshot() {
  const snap = structuredClone(getVillage())
  snap.source = 'SERIAL'
  snap.connected = true
  snap.status = 'NORMAL'
  snap.v = 3.7
  snap.i = 0.034
  snap.expected = 0.055
  snap.score = 0.1
  snap.zones = null
  snap.history = [
    { t: 1000, p: 0, v: 3.7, i: 0.034, expected: 0.055, score: 0.1 },
    { t: 1500, p: 0, v: 3.7, i: 0.034, expected: 0.055, score: 0.1 },
  ]
  return snap
}

test('does not fabricate branch waveforms when Arduino reports only one INA219', () => {
  const snap = serialSnapshot()
  const result = frtuHistory(snap, 'house')
  assert.equal(result.available, false)
  assert.match(result.reason, /분기|구간/)
  assert.deepEqual(result.points, [])
})

test('returns branch history only from recorded branch sensor samples', () => {
  const snap = serialSnapshot()
  snap.zones = {
    HOUSE: { v: 3.7, i: 0.02, expected: 0.033, score: 0.1, estLit: 2 },
    LAMP: { v: 3.7, i: 0.014, expected: 0.022, score: 0.1, estLit: 1 },
  }
  snap.history = [
    { t: 1000, p: 0, v: 3.7, i: 0.034, expected: 0.055, score: 0.1, ih: 0.02, il: 0.014 },
  ]
  const result = frtuHistory(snap, 'house')
  assert.equal(result.available, true)
  assert.deepEqual(result.points.map((p) => p.mA), [20])
})
