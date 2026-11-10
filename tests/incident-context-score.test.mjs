import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIncidentContext } from '../src/lib/incidentContext.ts'

test('incident assistant evidence presents uncalibrated model score as a decimal', () => {
  const incident = {
    caseType: 'WAVEFORM', id: 'case-1', title: '시험 사건', createdAt: '2026-11-11T00:00:00Z', stage: 'ANALYZED',
    source: {
      fileName: 'wave.csv', fileSize: 1, sha256: 'abc', sourceType: 'PUBLIC_DATASET', datasetId: 'RU',
      samplingRateHz: 1600, systemFrequencyHz: 50, channelOrder: ['Ia', 'Ic', 'Va', 'Vb', 'Vc'], labelMeaning: 'RU classes',
    },
    diagnosis: { status: 'ACCEPTED', rows: 512, cols: 5, issues: [], checkedAt: '2026-11-11T00:00:00Z' },
    waveform: null,
    analysis: {
      kind: 'COMPLETED', analysisType: 'EVENT_TYPE', predictedLabel: 'FAULT',
      scores: { NORMAL: 0.01, SWITCHING: 0.01, ABNORMAL: 0.04, FAULT: 0.94 },
      features: [], limitations: [], modelVersion: 'RU-test', preprocessVersion: 'prep-1', executedAt: '2026-11-11T00:00:00Z',
    },
    reviews: [], history: [],
  }

  const context = buildIncidentContext(incident)
  const result = context.evidence.find((item) => item.id === 'analysis.status')

  assert.equal(result.value, '고장 (FAULT) · 0.94 (점수, 확률 아님)')
  assert.doesNotMatch(result.value, /94%/)
})
