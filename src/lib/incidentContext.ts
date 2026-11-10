// 현장 대응 AI가 답할 때 쓰는 "사건 하나의 근거 묶음".
// 서버의 GET /incidents/{id}/assistant/context 와 같은 모양으로, 서버가 없을 때는 이 브라우저의 사건 기록에서 만든다.
// 교류 고장파형 사건(IncidentCase)만 다룬다. 마을 모형 DC 계측·한전 사용량 데이터는 섞지 않는다.

import { featureLabel, REASON_SHORT } from './aiExplain'
import { formatModelScore } from './modelScore'
import { ANALYSIS_LABEL, SOURCE_LABEL, VERDICT_LABEL, type IncidentCase } from '../types'

/** 이벤트 유형 코드의 뜻 (Xiong et al. 2020 공개 데이터셋 정의) */
export const EVENT_KO: Record<string, string> = {
  SIF: '1주기 미만 초기 고장 (SIF)',
  MIF: '여러 주기 초기 고장 (MIF)',
  PF: '영구 고장 (PF)',
  TD: '일시적 외란 (TD)',
  NORMAL: '정상 (NORMAL)',
  SWITCHING: '개폐 (SWITCHING)',
  ABNORMAL: '비정상 (ABNORMAL)',
  FAULT: '고장 (FAULT)',
}
export const eventKo = (label: string) => EVENT_KO[label] ?? label

export type EvidenceGroup = 'analysis' | 'diagnosis' | 'model' | 'review' | 'source'
export const EVIDENCE_GROUP_LABEL: Record<EvidenceGroup, string> = {
  analysis: '분석 결과',
  diagnosis: '입력 적합성',
  model: '모델 정보',
  review: '검토 이력',
  source: '원본 자료',
}

export interface EvidenceItem {
  id: string
  group: EvidenceGroup
  label: string
  value: string
}

export interface IncidentContext {
  caseId: string
  /** 서버 사건 ID. 서버에 올라가지 않은 사건은 null */
  incidentId: string | null
  title: string
  /** 이 대화가 다루는 데이터 종류. 항상 교류 고장파형 */
  dataKind: 'AC_WAVEFORM'
  analysis: {
    status: 'NONE' | 'COMPLETED' | 'WITHHELD'
    type: string | null
    label: string | null
    score: number | null
    ranking: { label: string; score: number }[]
    reasons: string[]
    neededInfo: string[]
    topFeatures: { label: string; contribution: number }[]
    executedAt: string | null
  }
  diagnosis: { status: 'ACCEPTED' | 'LIMITED' | 'REJECTED'; issues: string[] }
  model: { version: string | null; preprocess: string | null; country: string | null; dataset: string | null; limitations: string[] }
  reviews: { reviewer: string; verdict: string; finalJudgment: string; at: string }[]
  /** 설비 위치·선로 구간. 지금 사건 자료에는 없으므로 항상 null (P1에서 설비정보와 연계) */
  location: null
  evidence: EvidenceItem[]
  builtAt: string
}

export function buildIncidentContext(c: IncidentCase): IncidentContext {
  const a = c.analysis
  const ai = a?.ai
  const ranking = a?.scores ? Object.entries(a.scores).map(([label, score]) => ({ label, score })).sort((x, y) => y.score - x.score) : []
  const reasons = !a ? [] : a.kind === 'WITHHELD' ? a.reasons : (ai?.reasonCodes ?? []).map((r) => REASON_SHORT[r] ?? r)
  const topFeatures = (ai?.topFeatures ?? []).slice(0, 4).map((f) => ({ label: featureLabel(f.name), contribution: f.contribution }))

  const ctx: IncidentContext = {
    caseId: c.id,
    incidentId: c.backend?.incidentId ?? null,
    title: c.title,
    dataKind: 'AC_WAVEFORM',
    analysis: {
      status: !a ? 'NONE' : a.kind,
      type: a ? ANALYSIS_LABEL[a.analysisType] : null,
      label: a?.kind === 'COMPLETED' ? a.predictedLabel : null,
      score: a?.kind === 'COMPLETED' ? (a.scores[a.predictedLabel] ?? null) : null,
      ranking,
      reasons,
      neededInfo: a?.kind === 'WITHHELD' ? a.neededInfo : [],
      topFeatures,
      executedAt: a?.executedAt ?? null,
    },
    diagnosis: { status: c.diagnosis.status, issues: c.diagnosis.issues.map((i) => i.message) },
    model: {
      version: a?.modelVersion ?? null,
      preprocess: a?.preprocessVersion ?? null,
      country: ai?.modelCountry ?? (a?.kind === 'COMPLETED' ? (['NORMAL', 'SWITCHING', 'ABNORMAL', 'FAULT'].includes(a.predictedLabel) ? 'RU' : 'CN') : null),
      dataset: ai?.modelDataset ?? null,
      limitations: [...(a?.kind === 'COMPLETED' ? a.limitations : []), ...(ai?.limitations ?? [])],
    },
    reviews: c.reviews.map((r) => ({ reviewer: r.reviewer, verdict: VERDICT_LABEL[r.verdict], finalJudgment: r.finalJudgment, at: r.reviewedAt })),
    location: null,
    evidence: [],
    builtAt: new Date().toISOString(),
  }

  // 화면에 띄울 근거 항목. 값은 모두 위 기록에서 그대로 옮긴다
  const ev: EvidenceItem[] = []
  const add = (group: EvidenceGroup, id: string, label: string, value: string) => ev.push({ id, group, label, value })
  const an = ctx.analysis
  if (an.status === 'NONE') add('analysis', 'analysis.status', '분석 실행', '아직 분석하지 않음')
  else {
    add('analysis', 'analysis.type', '분석 종류', an.type ?? '—')
    add('analysis', 'analysis.status', 'AI 결과', an.status === 'COMPLETED' ? `${eventKo(an.label!)} · ${an.score != null ? `${formatModelScore(an.score)} (점수, 확률 아님)` : '—'}` : '판단 보류')
    if (an.ranking.length > 1) add('analysis', 'analysis.ranking', '유형별 점수', an.ranking.map((r) => `${r.label} ${r.score.toFixed(2)}`).join(' / '))
    an.reasons.forEach((r, k) => add('analysis', `analysis.reason.${k}`, '보류·주의 사유', r))
    an.topFeatures.forEach((f, k) => add('analysis', `analysis.feature.${k}`, '판단에 영향 준 특징', `${f.label} (${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(3)})`))
  }
  add('diagnosis', 'diagnosis.status', '입력 검사', { ACCEPTED: '통과', LIMITED: '제한 통과 (학습 조건과 다름)', REJECTED: '거부' }[ctx.diagnosis.status])
  ctx.diagnosis.issues.slice(0, 3).forEach((m, k) => add('diagnosis', `diagnosis.issue.${k}`, '입력 확인 사항', m))
  add('model', 'model.version', '모델 버전', ctx.model.version ?? '모델 미실행')
  if (ctx.model.dataset || ctx.model.country) add('model', 'model.dataset', '학습 데이터', [ctx.model.country, ctx.model.dataset].filter(Boolean).join(' · '))
  ctx.model.limitations.slice(0, 2).forEach((m, k) => add('model', `model.limit.${k}`, '모델 한계', m))
  if (!ctx.reviews.length) add('review', 'review.none', '사람 검토', '아직 검토 없음')
  ctx.reviews.forEach((r, k) => add('review', `review.${k}`, `${r.reviewer} 검토`, `${r.verdict}${r.finalJudgment ? ` — ${r.finalJudgment}` : ''}`))
  add('source', 'source.kind', '자료 출처', `${SOURCE_LABEL[c.source.sourceType]}${c.source.datasetId ? ` · ${c.source.datasetId}` : ''}`)
  add('source', 'source.format', '파형 형식', `${c.source.samplingRateHz} Hz 샘플링 · 계통 ${c.source.systemFrequencyHz} Hz`)
  add('source', 'source.channels', '실제 입력 채널', c.source.channelOrder.join(', '))
  if (c.source.labelMeaning) add('source', 'source.labels', '원본 라벨 의미', c.source.labelMeaning)
  if (c.sync?.error) add('source', 'source.stale', '서버 확인 상태', c.sync.error)
  ctx.evidence = ev
  return ctx
}
