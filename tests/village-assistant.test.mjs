import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVillageEvidence, villageChatHistory } from '../src/lib/assistant.ts'
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

test('disconnected devices and legacy events without source keep their provenance unknown', () => {
  const snapshot = { ...getVillage(), source: 'SERIAL', connected: false, status: 'NO_DATA', lastPacketAt: null }
  const event = { e: { ev: 2, receivedAt: '2026-11-10T00:00:00Z', src: 'auto', cmd: '', i100: Array(260).fill(1000), ch: [] }, verdict: { kind: 'NO_MODEL', reasons: [] } }
  const evidence = buildVillageEvidence(snapshot, [event], Date.now())
  assert.match(evidence.find((e) => e.id === 'village.status').value, /연결 끊김/)
  assert.match(evidence.find((e) => e.id === 'village.event.latest.summary').value, /출처 미기록/)
})

test('disconnected UNO and unknown sensor scope never expose the last sample as current LLM evidence', () => {
  const base = getVillage()
  const disconnected = buildVillageEvidence({ ...base, source: 'SERIAL', connected: false, status: 'NORMAL', measurementScope: 'HOUSE', lastPacketAt: 10_000, v: 3.7, i: 0.034 }, [], 10_100)
  assert.match(disconnected.find((e) => e.id === 'village.status').value, /최신 값 없음/)
  assert.match(disconnected.find((e) => e.id === 'village.measurement.total').value, /연결이 끊겼거나/)
  assert.ok(!disconnected.find((e) => e.id === 'village.measurement.total').value.includes('3.70 V'))

  const unknown = buildVillageEvidence({ ...base, source: 'SERIAL', connected: true, status: 'NORMAL', measurementScope: 'UNKNOWN', lastPacketAt: 10_000, v: 3.7, i: 0.034 }, [], 10_100)
  assert.match(unknown.find((e) => e.id === 'village.status').value, /데이터 없음/)
  assert.match(unknown.find((e) => e.id === 'village.measurement.total').value, /센서 범위가 확인되지 않음/)
})

test('keeps command and automatic UNO summaries available for event comparison', () => {
  const snapshot = { ...getVillage(), source: 'SERIAL', connected: false, status: 'NO_DATA', lastPacketAt: null }
  const event = (src, ev) => ({ e: { ev, receivedAt: `2026-11-10T10:00:0${ev}Z`, source: 'SERIAL', src, cmd: src === 'cmd' ? 'CH 2 0' : '', i100: Array(260).fill(1200), ch: [1, 0, 1, 1, 1] }, verdict: { kind: 'NO_MODEL', reasons: [] } })
  const events = [event('auto', 9), event('auto', 8), event('auto', 7), event('cmd', 6)]
  const evidence = buildVillageEvidence(snapshot, events, Date.now())
  assert.match(evidence.find((e) => e.id === 'village.event.command.summary').value, /명령 직후 CH 2 0/)
  assert.match(evidence.find((e) => e.id === 'village.event.automatic.summary').value, /자동 감지/)
})

test('follow-up context omits the welcome message and strips display-only model badges', () => {
  const history = villageChatHistory([
    { role: 'bot', text: '초기 안내' },
    { role: 'user', text: '지금 상태 어때?' },
    { role: 'bot', text: '주의 상태입니다.\n[서버 LLM · qwen2.5:3b]' },
  ])
  assert.deepEqual(history, [
    { role: 'user', content: '지금 상태 어때?' },
    { role: 'assistant', content: '주의 상태입니다.' },
  ])
})
