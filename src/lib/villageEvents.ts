// 마을 모형 '사건 파형' 원인 분석 (스케치 v3.1 이 사건 앞 0.6초·뒤 2.0초를 10 ms 간격으로 녹화한 전류).
// 고장파형 AI 와 같은 흐름을 작게 재현: 입력 검사 → 특징 → 분류 → 근거 부족하면 보류 → 근거(경로 기여도).
// 모델은 gridwitness-ai scripts/train_village_events.py 가 실측 사건으로 학습해 src/data/village_events_model.json 으로 내보낸다.
// features() 는 gridwitness-ai gw_ai/iot/events.py 의 features() 와 똑같이 계산해야 한다.
// 직류 모형의 전류라 한전 교류 고장파형과 같은 신호가 아니다.

import { useEffect, useSyncExternalStore } from 'react'
import MODEL from '../data/village_events_model.json'
import { getCachedVillageRecords, listVillageRecords, saveVillageRecord, subscribeVillageRecords } from '../api/village'
import { API_CHANGED_EVENT } from './backend'

export interface VillageEvent {
  source?: 'SERIAL' | 'MOCK'
  sensorScope?: 'BOTH' | 'HOUSE' | 'LAMP' | 'UNKNOWN'
  deviceId?: string
  ev: number
  dtMs: number
  pre: number
  src: 'auto' | 'cmd'
  cmd: string
  ch: number[]
  /** 0.01 mA 단위 정수 */
  i100: number[]
  receivedAt: string
}

export interface EventTree {
  l: number[]
  r: number[]
  f: number[]
  t: number[]
  v: number[][]
}
interface EventModel {
  version: string
  trained_at?: string
  labels: string[]
  label_ko: Record<string, string>
  fault_labels: string[]
  features: string[]
  thresholds: { score: number; margin: number; target_met?: boolean }
  data?: { counts: Record<string, number>; sources: { file: string; sha256: string }[] }
  metrics?: {
    n_train: number
    n_test: number
    split: string
    test_all: { accuracy: number; macro_f1: number }
    test_selective: { abstained: number; coverage: number; selective_accuracy: number | null }
    fault_vs_not: { nonfault_called_fault: number; fault_called_nonfault: number }
  }
  trees: EventTree[]
}
export const EVENT_MODEL = MODEL as unknown as EventModel
export const eventModelReady = () => EVENT_MODEL.trees.length > 0

const TRIG_MA = 1.5
const EXPECTED_SAMPLES = 260
const EXPECTED_PRE = 60
const EXPECTED_DT_MS = 10

export const FEATURE_KO: Record<string, string> = {
  src_cmd: '개폐 명령 직후인가',
  step_mA: '사건 전후 전류 차이',
  step_rel: '전후 차이 비율',
  min_dev_mA: '가장 크게 떨어진 양',
  max_dev_mA: '가장 크게 오른 양',
  n_low: '끊긴 횟수',
  n_high: '올라간 횟수',
  low_ms: '끊겨 있던 시간 합',
  first_low_ms: '첫 끊김 길이',
  recovered: '끝에 원래대로 돌아왔나',
  transitions: '상태가 바뀐 횟수',
  last_change_ms: '마지막 변화 시점',
  pre_std_mA: '사건 전 흔들림',
}

export function parseEventLine(line: string): VillageEvent | null {
  if (!line.startsWith('{"ev"')) return null
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    const i = o.i
    if (!Array.isArray(i)) return null
    return {
      ev: Number(o.ev),
      dtMs: Number(o.dt),
      pre: Number(o.pre),
      src: o.src === 'cmd' ? 'cmd' : 'auto',
      cmd: String(o.cmd ?? ''),
      ch: Array.isArray(o.ch) ? o.ch.map(Number) : [],
      i100: i.map(Number),
      receivedAt: new Date().toISOString(),
      source: 'SERIAL',
      deviceId: 'arduino-village',
    }
  } catch {
    return null
  }
}

/** 입력 검사: 스케치 v3.1 형식과 다르면 분석하지 않는다 */
export function checkEvent(e: VillageEvent): string[] {
  const bad: string[] = []
  if (e.dtMs !== EXPECTED_DT_MS) bad.push(`샘플 간격이 ${EXPECTED_DT_MS} ms가 아님 (스케치 v3.1 필요)`)
  if (e.pre < EXPECTED_PRE) bad.push(`사건 전 실측 표본이 ${e.pre}/${EXPECTED_PRE}개뿐이라 분류 판정을 보류합니다 (원시 파형은 보존).`)
  else if (e.i100.length !== EXPECTED_SAMPLES || e.pre !== EXPECTED_PRE) bad.push(`길이가 ${EXPECTED_SAMPLES}샘플(앞 ${EXPECTED_PRE})이 아님`)
  if (e.i100.some((x) => !Number.isFinite(x) || x < 0 || x >= 32767)) bad.push('측정 범위를 벗어난 값')
  return bad
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const std = (xs: number[]) => {
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length)
}
const runs = (state: number[], target: number) => {
  const out: number[] = []
  let n = 0
  for (const s of state) {
    if (s === target) n++
    else if (n) {
      out.push(n)
      n = 0
    }
  }
  if (n) out.push(n)
  return out
}

export function features(e: VillageEvent): number[] {
  const i = e.i100.map((x) => x / 100)
  const pre = i.slice(0, e.pre)
  const post = i.slice(e.pre)
  const base = median(pre.slice(0, Math.max(1, e.pre - 2)))
  const dev = post.map((x) => x - base)
  const step = median(post.slice(-40)) - base
  const state = dev.map((d) => (d < -TRIG_MA ? -1 : d > TRIG_MA ? 1 : 0))
  const low = runs(state, -1)
  const high = runs(state, 1)
  const changes: number[] = []
  for (let k = 0; k + 1 < state.length; k++) if (state[k + 1] !== state[k]) changes.push(k)
  let firstLow = 0
  for (const s of state) {
    if (s === -1) firstLow++
    else if (firstLow) break
  }
  return [
    e.src === 'cmd' ? 1 : 0,
    step,
    step / Math.max(base, 1),
    Math.min(...dev),
    Math.max(...dev),
    low.length,
    high.length,
    low.reduce((a, b) => a + b, 0) * e.dtMs,
    firstLow * e.dtMs,
    Math.abs(step) < TRIG_MA ? 1 : 0,
    changes.length,
    changes.length ? (changes[changes.length - 1] + 1) * e.dtMs : 0,
    std(pre),
  ]
}

export function forestPredict(trees: EventTree[], x0: number[]): { proba: number[]; contrib: number[][] } {
  const x = x0.map(Math.fround) // sklearn 은 입력을 float32 로 바꿔 비교한다
  const nC = trees[0].v[0].length
  const proba = new Array<number>(nC).fill(0)
  const contrib = x.map(() => new Array<number>(nC).fill(0))
  for (const t of trees) {
    let n = 0
    while (t.l[n] !== -1) {
      const f = t.f[n]
      const nxt = x[f] <= t.t[n] ? t.l[n] : t.r[n]
      for (let c = 0; c < nC; c++) contrib[f][c] += t.v[nxt][c] - t.v[n][c]
      n = nxt
    }
    for (let c = 0; c < nC; c++) proba[c] += t.v[n][c]
  }
  return { proba: proba.map((p) => p / trees.length), contrib: contrib.map((r) => r.map((v) => v / trees.length)) }
}

export type EventVerdict =
  | { kind: 'REJECTED'; reasons: string[] }
  | { kind: 'NO_MODEL'; reasons: string[] }
  | {
      kind: 'ANSWERED' | 'WITHHELD'
      label: string
      labelKo: string
      isFault: boolean
      score: number
      margin: number
      ranking: { label: string; labelKo: string; score: number }[]
      reasons: string[]
      evidence: { name: string; label: string; value: number; contribution: number }[]
    }

export function analyzeEvent(e: VillageEvent): EventVerdict {
  const bad = checkEvent(e)
  if (bad.length) return { kind: 'REJECTED', reasons: bad }
  if (!eventModelReady()) return { kind: 'NO_MODEL', reasons: ['원인 분류 모델이 아직 학습되지 않았습니다 (실측 사건 수집 후 학습)'] }
  const m = EVENT_MODEL
  const x = features(e)
  const { proba, contrib } = forestPredict(m.trees, x)
  const order = proba.map((p, k) => [p, k] as const).sort((a, b) => b[0] - a[0])
  const [s1, top] = order[0]
  const margin = s1 - order[1][0]
  const reasons: string[] = []
  if (s1 < m.thresholds.score) reasons.push(`1순위 점수 ${s1.toFixed(2)}가 기준 ${m.thresholds.score} 미만`)
  if (margin < m.thresholds.margin) reasons.push(`1·2위 점수 차 ${margin.toFixed(2)}가 기준 ${m.thresholds.margin} 미만`)
  const label = m.labels[top]
  const evidence = m.features
    .map((name, k) => ({ name, label: FEATURE_KO[name] ?? name, value: x[k], contribution: contrib[k][top] }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 5)
  return {
    kind: reasons.length ? 'WITHHELD' : 'ANSWERED',
    label,
    labelKo: m.label_ko[label] ?? label,
    isFault: m.fault_labels.includes(label),
    score: s1,
    margin,
    ranking: order.map(([p, k]) => ({ label: m.labels[k], labelKo: m.label_ko[m.labels[k]] ?? m.labels[k], score: p })),
    reasons,
    evidence,
  }
}

// ── 원시 파형·판정·근거 보존. 우노 사건 번호가 재시작해도 UUID로 구분한다. ──

export interface AnalyzedEvent {
  recordId: string
  e: VillageEvent
  verdict: EventVerdict
}
const readCached = () => getCachedVillageRecords<AnalyzedEvent>('event').map((r) => ({ ...r.data, recordId: r.record_id }))
  .filter((a) => a.e && Array.isArray(a.e.i100) && a.verdict)
  .sort((a, b) => b.e.receivedAt.localeCompare(a.e.receivedAt))
let recent: AnalyzedEvent[] = readCached()
const hidden = new Set<string>()
const listeners = new Set<() => void>()
function refreshCached() {
  recent = readCached().filter((a) => !hidden.has(a.recordId))
  listeners.forEach((l) => l())
}
subscribeVillageRecords(refreshCached)
export const getVillageEvents = () => recent
export function pushVillageEvent(e: VillageEvent) {
  const record: AnalyzedEvent = { recordId: crypto.randomUUID(), e: { ...e, source: e.source ?? 'SERIAL', deviceId: e.deviceId ?? 'arduino-village' }, verdict: analyzeEvent(e) }
  recent = [record, ...recent]
  listeners.forEach((l) => l())
  // 오류는 공용 저장 상태에 표시된다. 기록은 메모리·재시도 큐에도 유지한다.
  void saveVillageRecord(record.recordId, 'event', record.e.deviceId!, record).catch(() => {})
}
export function clearVillageEvents() {
  recent.forEach((a) => hidden.add(a.recordId))
  recent = []
  listeners.forEach((l) => l())
}
export function useVillageEvents(): AnalyzedEvent[] {
  useEffect(() => {
    const sync = () => { void listVillageRecords<AnalyzedEvent>('event') }
    sync()
    const timer = setInterval(sync, 30_000)
    window.addEventListener(API_CHANGED_EVENT, sync)
    return () => { clearInterval(timer); window.removeEventListener(API_CHANGED_EVENT, sync) }
  }, [])
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => recent,
  )
}
