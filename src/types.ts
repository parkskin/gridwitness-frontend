// 프론트엔드 도메인 타입. API 응답 스키마와의 변환은 src/api/backend.ts에서 처리한다.

export const CHANNELS = ['Ia', 'Ib', 'Ic', 'In', 'Va', 'Vb', 'Vc'] as const
export const RU_CHANNELS = ['Ia', 'Ic', 'Va', 'Vb', 'Vc'] as const
export type Channel = (typeof CHANNELS)[number]
export type ModelCountry = 'CN' | 'RU'
/** 입력의 실제 열을 유지한다. RU에 없는 Ib/In은 만들지 않는다. */
export const channelsFor = (columns: number): readonly Channel[] => columns === 5 ? RU_CHANNELS : columns === 7 ? CHANNELS : []

export type SourceType = 'PUBLIC_DATASET' | 'FIELD_FRTU' | 'SYNTHETIC' | 'UNKNOWN'

export const SOURCE_LABEL: Record<SourceType, string> = {
  PUBLIC_DATASET: '공개 데이터셋',
  FIELD_FRTU: '현장 FRTU (승인 자료)',
  SYNTHETIC: '합성 데이터',
  UNKNOWN: '출처 불명',
}

/** ① 사고/원본 등록 */
export interface SourceRecord {
  fileName: string
  fileSize: number
  sha256: string
  sourceType: SourceType
  datasetId: string
  samplingRateHz: number
  systemFrequencyHz: 50 | 60
  channelOrder: string[]
  labelMeaning: string
  /** 업로드 형식 (없으면 CSV) */
  format?: 'CSV' | 'COMTRADE'
  /** COMTRADE .cfg에서 읽은 정보 */
  comtrade?: { station: string; device: string; revYear: string; fileType: string; mapping: Record<string, string> }
  provenance?: {
    format: 'CSV' | 'COMTRADE'
    channelOrder: string[]
    originalFiles: { name: string; size: number; sha256: string; role: 'csv' | 'cfg' | 'dat' }[]
    originalSha256?: string
    comtrade?: SourceRecord['comtrade']
  }
  originalFiles?: Record<string, { filename: string; sha256: string; size: number; download_url: string }>
}

/** ② 입력 진단: 정상 / 제한 / 거부 */
export type DiagnosisStatus = 'ACCEPTED' | 'LIMITED' | 'REJECTED'

export interface DiagnosisIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  fix?: string
}

export interface InputDiagnosis {
  status: DiagnosisStatus
  rows: number
  cols: number
  issues: DiagnosisIssue[]
  checkedAt: string
}

export type AnalysisType = 'EVENT_TYPE' | 'PHYSICAL_CAUSE' | 'NORMAL_VS_FAULT'

export const ANALYSIS_LABEL: Record<AnalysisType, string> = {
  EVENT_TYPE: '모델별 이벤트 유형 분류 (CN / RU)',
  PHYSICAL_CAUSE: '물리적 고장원인 추정 (수목 접촉·절연 파괴 등)',
  NORMAL_VS_FAULT: '정상/고장 탐지',
}

export const EVENT_LABELS = ['SIF', 'MIF', 'PF', 'TD'] as const
export const RU_EVENT_LABELS = ['NORMAL', 'SWITCHING', 'ABNORMAL', 'FAULT'] as const
export type EventLabel = (typeof EVENT_LABELS)[number] | (typeof RU_EVENT_LABELS)[number]
export type EventScores = Record<string, number>

export interface ChannelFeatures {
  channel: Channel
  rms: number
  peak: number
  crestFactor: number
  diffRms: number
}

/** ④ AI 결과 / ⑤ 추가 확인 필요 */
/** 서버 AI(gw_ai)가 결과와 함께 돌려준 근거·추적 정보. 예전 기록이나 모델 없이 끝난 분석에는 없음 */
export interface AiDetail {
  status: 'ok' | 'abstained' | 'rejected'
  /** treeshap = 이 사건에서 1순위 유형 점수를 실제로 올리고(+) 내린(-) 특징 */
  method: string
  topFeatures: { name: string; value: number; contribution: number }[]
  /** 1순위 유형 (보류여도 계산은 함. 화면에서 답처럼 보이지 않게 쓴다) */
  topLabel: string | null
  topScore: number | null
  margin: number | null
  oodRatio: number | null
  thresholds: Record<string, number>
  reasonCodes: string[]
  versions: Record<string, string>
  modelCountry: string | null
  modelDataset: string | null
  fileSha256: string | null
  limitations: string[]
}

export type AnalysisResult =
  | {
      kind: 'COMPLETED'
      analysisType: AnalysisType
      predictedLabel: EventLabel
      scores: EventScores
      features: ChannelFeatures[]
      limitations: string[]
      modelVersion: string
      preprocessVersion: string
      executedAt: string
      ai?: AiDetail
    }
  | {
      kind: 'WITHHELD'
      analysisType: AnalysisType
      reasons: string[]
      neededInfo: string[]
      features: ChannelFeatures[] | null
      scores: EventScores | null
      modelVersion: string | null
      preprocessVersion: string | null
      executedAt: string
      ai?: AiDetail
    }

/** ⑥ 사람 검토 — AI 결과와 분리 저장 */
export interface Review {
  reviewer: string
  verdict: 'AGREE' | 'DISAGREE' | 'NEEDS_INVESTIGATION'
  finalJudgment: string
  additionalInvestigation: string
  reviewedAt: string
}

export const VERDICT_LABEL: Record<Review['verdict'], string> = {
  AGREE: 'AI 결과에 동의',
  DISAGREE: 'AI 결과와 다르게 판단',
  NEEDS_INVESTIGATION: '추가 조사 필요',
}

export interface HistoryEvent {
  at: string
  actor: string
  action: string
  detail?: string
}

export type CaseStage = 'REGISTERED' | 'DIAGNOSED' | 'ANALYZED' | 'WITHHELD' | 'REVIEWED'

export type CaseType = 'WAVEFORM' | 'IOT'
export interface CaseSync {
  checkedAt: string | null
  error: string | null
}

export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  WAVEFORM: '고장파형 분석',
  IOT: 'IoT 이상 이벤트',
}

export interface IncidentCase {
  caseType: 'WAVEFORM'
  id: string
  title: string
  createdAt: string
  stage: CaseStage
  source: SourceRecord
  diagnosis: InputDiagnosis
  /** 행 = 샘플, 열 = 채널 */
  waveform: number[][] | null
  analysis: AnalysisResult | null
  reviews: Review[]
  history: HistoryEvent[]
  /** 서버가 부여한 ID. 서버에 올리지 못한 사건에는 없음 */
  backend?: { incidentId: string; validationId: string | null; analysisId: string | null }
  archived?: boolean
  sync?: CaseSync
  /** 내보내기 시 서버의 대화·메모 등 원래 기록을 함께 보존한다. */
  serverRecords?: { fieldNotes: unknown; assistantMessages: unknown; metadata?: unknown; validation?: unknown; analysis?: unknown; reviews?: unknown; audit?: unknown; originalFiles?: { name: string; base64: string }[]; waveformFile?: { name: string; base64: string } }
}

// ── IoT (Arduino + INA219 모형) ─────────────────────────

export interface IotPoint {
  t: number
  v: number
  i: number
  expected: number
  score: number
  /** 실제 측정에 포함된 센서 범위. 구형 기록에는 없음. */
  scope?: 'BOTH' | 'HOUSE' | 'LAMP' | 'UNKNOWN'
  /** 구간별 전류·예상 전류 (INA219 두 개 구성). 예전 기록에는 없음 */
  ih?: number
  il?: number
  eh?: number
  el?: number
}

export interface IotDetection {
  model: string
  maxScore: number
  status: 'WARNING' | 'FAULT' | 'OUTAGE'
  maxResidualA: number
  minV: number
  findings: string[]
  limitations: string[]
  executedAt: string
}

/** IoT 이상 이벤트 사건. 모형의 DC 계측 기록이며 교류 고장파형과 섞지 않음. */
export interface IotCase {
  caseType: 'IOT'
  id: string
  title: string
  createdAt: string
  stage: CaseStage
  device: {
    deviceId: string
    sensor: string
    /** 측정 범위 (INA219 2개 → 주택·가로등 구간, 예전 장치는 1개 → 마을 전체) */
    scope: string
    nominalV: number
    expectedA: number
    relayOn: boolean
    faultInjected: string | null
  }
  window: IotPoint[]
  diagnosis: InputDiagnosis
  detection: IotDetection
  reviews: Review[]
  history: HistoryEvent[]
  persistence?: 'server' | 'pending'
  sync?: CaseSync
}

export type AnyCase = IncidentCase | IotCase

/** 원본 CSV(파형)가 이 브라우저에 없어 분석·검토를 할 수 없는 고장파형 사건.
 *  입력 진단에서 거부된 사건은 원래 파형을 쓰지 않으므로 제외 */
export const needsWaveform = (c: AnyCase) => c.caseType === 'WAVEFORM' && !c.waveform && c.diagnosis.status !== 'REJECTED'

export interface CaseSummary {
  caseType: CaseType
  id: string
  title: string
  createdAt: string
  stage: CaseStage
  source: string
  diagnosisStatus: DiagnosisStatus
  /** 원본 CSV를 다시 연결해야 분석·검토할 수 있음 */
  needsWaveform?: boolean
  sync?: CaseSync
}

/** 모든 사건의 실행 이력을 시간순으로 펼친 항목 (관리자 활동 기록용) */
export interface ActivityItem {
  at: string
  actor: string
  action: string
  detail?: string
  caseId: string
  caseTitle: string
  caseType: CaseType
}
