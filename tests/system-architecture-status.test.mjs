import test from 'node:test'
import assert from 'node:assert/strict'
import { unoStatus } from '../src/lib/systemArchitectureStatus.ts'

test('does not call one-sensor UNO telemetry a working two-zone measurement', () => {
  const status = unoStatus({
    connected: true,
    source: 'SERIAL',
    zones: null,
    lastNote: 'INA219 house(0x40)=OK lamp(0x41)=NOT FOUND',
  })

  assert.equal(status.state, 'warn')
  assert.match(status.text, /주택 0x40 인식/)
  assert.match(status.text, /가로등 0x41 미응답/)
  assert.match(status.detail, /구간별 측정값 없음/)
})

test('reports measured zone values only when the connected UNO supplies both zones', () => {
  const status = unoStatus({ connected: true, source: 'SERIAL', zones: { HOUSE: {}, LAMP: {} }, lastNote: null })

  assert.equal(status.state, 'ok')
  assert.match(status.text, /두 구간 실측 수신/)
})

test('marks a simulator as simulated rather than measured hardware', () => {
  const status = unoStatus({ connected: true, source: 'MOCK', zones: { HOUSE: {}, LAMP: {} }, lastNote: null })

  assert.equal(status.state, 'warn')
  assert.match(status.text, /시뮬레이터/)
  assert.match(status.detail, /실측이 아님/)
})

test('does not present stale sensor notes as a current connection after unplugging', () => {
  const status = unoStatus({
    connected: false,
    source: 'SERIAL',
    zones: null,
    lastNote: 'INA219 house(0x40)=OK lamp(0x41)=OK',
  })

  assert.equal(status.state, 'down')
  assert.match(status.text, /장치 연결 끊김/)
})
