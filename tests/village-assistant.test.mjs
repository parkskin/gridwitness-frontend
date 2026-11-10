import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVillageEvidence } from '../src/lib/assistant.ts'
import { getVillage } from '../src/lib/village.ts'

test('village context preserves real source and withholds unavailable FRTU readings', () => {
  const snapshot = { ...getVillage(), source: 'SERIAL', connected: true, status: 'WARNING', lastPacketAt: 10_000,
    v: 4.91, i: 0.021, expected: 0.02, relay: true, zones: null }
  const [event] = [{ e: { ev: 7, receivedAt: '2026-11-10T10:00:00Z', source: 'SERIAL', src: 'cmd', cmd: 'CH 2 0', i100: Array(260).fill(2100), ch: [1, 0, 1, 1, 1] }, verdict: { kind: 'NO_MODEL', reasons: ['분류 모델 없음'] } }]
  const evidence = buildVillageEvidence(snapshot, [event], 10_100)
  assert.match(evidence.find((e) => e.id === 'village.source').value, /실측 · Arduino/)
  assert.match(evidence.find((e) => e.id === 'village.frtu.lamp').value, /측정 불가/)
  assert.match(evidence.find((e) => e.id === 'village.event.latest.summary').value, /명령 직후 CH 2 0/)
  assert.match(evidence.find((e) => e.id === 'village.event.latest.summary').value, /260개 원시 표본/)
  assert.ok(!evidence.some((e) => e.id === 'village.frtu.lamp' && /0\.0 mA/.test(e.value)))
})

test('stale serial telemetry is sent as unavailable rather than a measurement', () => {
  const snapshot = { ...getVillage(), source: 'SERIAL', connected: true, status: 'NORMAL', lastPacketAt: 1_000, v: 5, i: 0.02 }
  const evidence = buildVillageEvidence(snapshot, [], 10_000)
  assert.match(evidence.find((e) => e.id === 'village.status').value, /오래된 계측/)
  assert.match(evidence.find((e) => e.id === 'village.measurement.total').value, /5초 이상/)
})

test('keeps command and automatic UNO summaries available for event comparison', () => {
  const snapshot = { ...getVillage(), source: 'SERIAL', connected: false, status: 'NO_DATA', lastPacketAt: null }
  const event = (src, ev) => ({ e: { ev, receivedAt: `2026-11-10T10:00:0${ev}Z`, source: 'SERIAL', src, cmd: src === 'cmd' ? 'CH 2 0' : '', i100: Array(260).fill(1200), ch: [1, 0, 1, 1, 1] }, verdict: { kind: 'NO_MODEL', reasons: [] } })
  const events = [event('auto', 9), event('auto', 8), event('auto', 7), event('cmd', 6)]
  const evidence = buildVillageEvidence(snapshot, events, Date.now())
  assert.match(evidence.find((e) => e.id === 'village.event.command.summary').value, /명령 직후 CH 2 0/)
  assert.match(evidence.find((e) => e.id === 'village.event.automatic.summary').value, /자동 감지/)
})
