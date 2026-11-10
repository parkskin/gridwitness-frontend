import test from 'node:test'
import assert from 'node:assert/strict'
import { formatModelScore } from '../src/lib/modelScore.ts'
import { answer } from '../src/lib/assistant.ts'

test('formats uncalibrated model scores as decimals, never percentages', () => {
  assert.equal(formatModelScore(0.4925), '0.49')
  assert.equal(formatModelScore(1), '1.00')
  assert.equal(formatModelScore(undefined), '—')
})

test('village assistant describes recorded event score as an uncalibrated score', () => {
  const event = {
    e: { ev: 34, receivedAt: '2026-11-10T12:17:44Z', source: 'SERIAL', src: 'auto', i100: Array(260).fill(1000) },
    verdict: { kind: 'ANSWERED', labelKo: '순간 접촉 불량', score: 0.4925, evidence: [{ label: '사건 전후 전류 차이' }] },
  }

  const text = answer('마지막 사건 판정은?', [event])

  assert.match(text, /점수 0\.49 \(정답 확률 아님\)/)
  assert.doesNotMatch(text, /49%/)
})
