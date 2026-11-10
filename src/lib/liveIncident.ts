// 실시간 사건: FRTU 고장표시가 뜨는 순간을 하나의 "사건"으로 묶어 발생 → 진행 → 복구까지 기록한다.
// 데이터는 마을 모형의 직류 계측(FRTU 3대)뿐이다. 교류 고장파형 분석과 섞지 않는다.
// 실제 현장이라면 같은 자리에 FRTU가 녹화한 교류 고장파형과 그 AI 분석이 들어간다.

import { useEffect, useSyncExternalStore } from 'react'
import { getCachedVillageRecords, listVillageRecords, queueVillageRecord, retryVillageRecords, subscribeVillageRecords } from '../api/village'
import { API_CHANGED_EVENT } from './backend'
import { FI_LABEL, frtuViews, locateFault, type FaultScope, type FiKind, type FrtuId } from './frtu'
import { ledA, type DataSource, type VillageSnapshot } from './village'
import { getVillageEvents } from './villageEvents'

export interface IncidentPoint {
  t: number
  i: number
  ih: number | null
  il: number | null
  measurementScope?: VillageSnapshot['measurementScope']
}

export interface LiveIncident {
  id: number
  recordId: string
  deviceId: string
  /** 다른 브라우저에서 조회한 사건을 이 브라우저의 새 계측으로 덮어쓰지 않는다. */
  observerId: string
  rawEventRecordId?: string | null
  source: DataSource
  measurementScope: VillageSnapshot['measurementScope']
  startedAt: number
  /** 복구된 시각 (아직 진행 중이면 null) */
  clearedAt: number | null
  scope: FaultScope
  title: string
  reasons: string[]
  /** 고장표시가 뜬 FRTU와 종류 (가장 심했을 때) */
  fi: Record<FrtuId, FiKind>
  /** 원인 판정 (계측값만으로 낸 규칙 판정) */
  cause: string
  /** 사건 전 10초 + 진행 중 계측 */
  points: IncidentPoint[]
  /** 규칙 기반 이상 이벤트 id (사건 등록에 씀) */
  ruleEventId: number | null
  caseId: string | null
  /** 처리 단계 (접수 → 출동 → 점검 → 복구 → 종결) */
  stage: IncidentStage
  /** 담당자 (출동·점검을 맡은 사람) */
  assignee: string | null
  /** 단계가 바뀐 기록 */
  stageLog: { stage: IncidentStage; at: number; by: string }[]
}

export type IncidentStage = 'RECEIVED' | 'DISPATCHED' | 'INSPECTING' | 'RESTORED' | 'CLOSED'
export const STAGES: IncidentStage[] = ['RECEIVED', 'DISPATCHED', 'INSPECTING', 'RESTORED', 'CLOSED']
export const STAGE_LABEL: Record<IncidentStage, string> = { RECEIVED: '접수', DISPATCHED: '출동', INSPECTING: '점검', RESTORED: '복구', CLOSED: '종결' }

interface State {
  incidents: LiveIncident[]
  /** 화면에 펼쳐 둔 사건 */
  openId: string | null
  /** 알림 배너를 닫은 사건 */
  dismissed: string[]
}

const ACTIVE: FaultScope[] = ['HOUSE', 'LAMP', 'BOTH', 'UPSTREAM', 'UNKNOWN']
const REOPEN_MS = 3000 // 복구 직후 다시 고장표시가 뜨면 같은 사건으로 이어 봄 (깜빡임 방지)

const OBSERVER_KEY = 'gridwitness.village.observer.v1'
const observerId = (() => {
  try {
    const id = localStorage.getItem(OBSERVER_KEY) ?? crypto.randomUUID()
    localStorage.setItem(OBSERVER_KEY, id)
    return id
  } catch { return crypto.randomUUID() }
})()
const normalize = (x: LiveIncident): LiveIncident => ({ ...x, recordId: x.recordId ?? crypto.randomUUID(), deviceId: x.deviceId ?? (x.source === 'MOCK' ? 'arduino-sim-01' : 'arduino-village'), observerId: x.observerId ?? observerId, stage: x.stage ?? (x.clearedAt ? 'RESTORED' : 'RECEIVED'), assignee: x.assignee ?? null, stageLog: x.stageLog ?? [] })
const readCached = () => getCachedVillageRecords<LiveIncident>('incident').map((r) => normalize({ ...r.data, recordId: r.record_id }))
  .filter((x) => Number.isFinite(x.id) && Number.isFinite(x.startedAt) && Array.isArray(x.points))
  .sort((a, b) => b.startedAt - a.startedAt)
function loadSaved(): LiveIncident[] {
  const cached = readCached()
  if (cached.length) return cached
  try {
    if (localStorage.getItem('gridwitness.liveIncidents.v1.migrated') === '1') return []
    const xs = JSON.parse(localStorage.getItem('gridwitness.liveIncidents.v1') ?? '[]') as LiveIncident[]
    const migrated = xs.map(normalize)
    for (const x of migrated) queueVillageRecord(x.recordId, 'incident', x.deviceId, x)
    // 원래 기록은 마이그레이션 이후에도 보관하며 다시 가져오지 않도록 표시한다.
    if (migrated.length) localStorage.setItem('gridwitness.liveIncidents.v1.migrated', '1')
    return migrated
  } catch { return [] }
}
let pendingFlush: ReturnType<typeof setTimeout> | null = null
function persist(force = false) {
  if (force) { if (pendingFlush) clearTimeout(pendingFlush); pendingFlush = null; void retryVillageRecords(); return }
  if (!pendingFlush) pendingFlush = setTimeout(() => { pendingFlush = null; void retryVillageRecords() }, 2000)
}

let state: State = { incidents: loadSaved(), openId: null, dismissed: [] }
let lastPacket = ''
const hidden = new Set<string>()
const listeners = new Set<() => void>()
const set = (next: Partial<State>, force = false) => {
  const previous = new Map(state.incidents.map((x) => [x.recordId, x]))
  state = { ...state, ...next }
  if (next.incidents) {
    // 모든 계측을 즉시 브라우저 큐에 보존하고 네트워크 요청만 묶는다.
    for (const x of next.incidents) if (previous.get(x.recordId) !== x) queueVillageRecord(x.recordId, 'incident', x.deviceId, x)
    persist(force)
  }
  listeners.forEach((l) => l())
}
/** UUID를 기준으로 찾고 예전 숫자 링크는 일치하는 사건이 하나일 때만 허용한다. */
export function getLiveIncident(id: string | number): LiveIncident | null {
  const direct = state.incidents.find((x) => x.recordId === String(id))
  if (direct) return direct
  const old = state.incidents.filter((x) => x.id === Number(id))
  return old.length === 1 ? old[0] : null
}
const patch = (id: string | number, f: (x: LiveIncident) => LiveIncident) => {
  const recordId = getLiveIncident(id)?.recordId
  if (recordId) set({ incidents: state.incidents.map((x) => (x.recordId === recordId ? f(x) : x)) }, true)
}

/** 처리 단계 바꾸기 (담당자가 직접) */
export const setIncidentStage = (id: string | number, stage: IncidentStage, by: string) =>
  patch(id, (x) => ({ ...x, stage, stageLog: [...x.stageLog, { stage, at: Date.now(), by }] }))
export const assignIncident = (id: string | number, name: string) => patch(id, (x) => ({ ...x, assignee: name.trim() || null }))
export const clearIncidentHistory = () => {
  state.incidents.filter((x) => x.clearedAt).forEach((x) => hidden.add(x.recordId))
  state = { ...state, incidents: state.incidents.filter((x) => !x.clearedAt) }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l))
subscribeVillageRecords(() => {
  state = { ...state, incidents: readCached().filter((x) => !hidden.has(x.recordId)) }
  listeners.forEach((l) => l())
})

export function useLiveIncidents() {
  useEffect(() => {
    const sync = () => { void retryVillageRecords().then(() => listVillageRecords<LiveIncident>('incident')) }
    sync()
    const timer = setInterval(sync, 30_000)
    window.addEventListener(API_CHANGED_EVENT, sync)
    return () => { clearInterval(timer); window.removeEventListener(API_CHANGED_EVENT, sync) }
  }, [])
  return useSyncExternalStore(subscribe, () => state)
}
export const openIncident = (id: string | number | null) => set({ openId: id == null ? null : getLiveIncident(id)?.recordId ?? null })
export const dismissIncident = (id: string | number) => {
  const recordId = getLiveIncident(id)?.recordId
  if (recordId) set({ dismissed: [...state.dismissed, recordId] })
}
export const markIncidentRegistered = (id: string | number, caseId: string) => patch(id, (x) => ({ ...x, caseId }))

const toPoint = (h: VillageSnapshot['history'][number]): IncidentPoint => ({ t: h.t, i: h.i, ih: h.ih ?? null, il: h.il ?? null, measurementScope: h.scope })

/** 계측값만으로 낸 원인 판정 (고장표시 종류 + 전류 변화량) */
function causeOf(s: VillageSnapshot): string {
  const fv = frtuViews(s)
  const hit = [fv.house, fv.lamp].filter((f) => f.fi !== 'NONE')
  const one = hit[0] ?? fv.inlet
  const diff = one.expected - one.i
  const leds = Math.round(Math.abs(diff) / ledA())
  switch (one.fi) {
    case 'LOW':
      return `단선 의심 — ${one.def.short}에서 LED 약 ${leds || 1}개 분량 전류가 사라졌어요`
    case 'HIGH':
      return `누설·과전류 의심 — ${one.def.short}에 예상보다 ${(Math.abs(diff) * 1000).toFixed(0)} mA 더 흘러요`
    case 'VOLTAGE':
      return `전원 전압 강하 — ${one.v.toFixed(2)} V (분기점 앞 전원·어댑터 쪽)`
    case 'OUTAGE':
      return '전원 없음 — 분기점 앞에서 끊김'
    default:
      return '판단 보류 — 고장표시 종류를 정하기에 근거가 부족해요'
  }
}

const SEVERITY: Record<FiKind, number> = { NONE: 0, VOLTAGE: 1, HIGH: 2, LOW: 2, OUTAGE: 3 }

/** 계측이 새로 올 때마다 부른다 (상단 셸의 감시 컴포넌트에서) */
export function observeVillage(s: VillageSnapshot) {
  const loc = locateFault(s)
  // 계측값이 없으면 고장인지 복구인지 알 수 없으므로 아무것도 바꾸지 않는다 (새로고침 직후 등)
  if (loc.scope === 'NO_DATA') return
  const packetKey = `${s.source}.${s.packets}.${s.lastPacketAt}`
  if (packetKey === lastPacket) return
  lastPacket = packetKey
  const active = ACTIVE.includes(loc.scope)
  const now = Date.now()
  const last = s.history[s.history.length - 1]
  const cur = state.incidents.find((x) => x.observerId === observerId && x.source === s.source)
  const rest = state.incidents.filter((x) => x.recordId !== cur?.recordId)
  const fvNow = frtuViews(s)
  const fiNow = { inlet: fvNow.inlet.fi, house: fvNow.house.fi, lamp: fvNow.lamp.fi }
  const ruleEventId = s.events.find((e) => !e.clearedAt)?.id ?? null
  const rawEventRecordId = getVillageEvents().find((a) => (a.e.source ?? 'SERIAL') === s.source && Math.abs(Date.parse(a.e.receivedAt) - (cur?.startedAt ?? now)) < 8000)?.recordId ?? null

  const reopen = cur && cur.clearedAt && active && now - cur.clearedAt < REOPEN_MS
  if (cur && (!cur.clearedAt || reopen)) {
    const points = last && cur.points[cur.points.length - 1]?.t !== last.t ? [...cur.points, toPoint(last)] : cur.points
    const worse = (k: FrtuId) => (SEVERITY[fiNow[k]] > SEVERITY[cur.fi[k]] ? fiNow[k] : cur.fi[k])
    // 계측이 정상으로 돌아오면 처리 단계를 '복구'로 (담당자가 이미 종결했으면 그대로)
    // 의도적 전원 차단은 정상 복구 근거가 아니다.
    const restored = loc.scope === 'NONE' && (Object.keys(cur.fi) as FrtuId[]).every((k) => cur.fi[k] === 'NONE' || fvNow[k].available)
    const justRestored = restored && !cur.clearedAt && cur.stage !== 'RESTORED' && cur.stage !== 'CLOSED'
    set({
      incidents: [
        {
          ...cur,
          ...(justRestored && { stage: 'RESTORED' as IncidentStage, stageLog: [...cur.stageLog, { stage: 'RESTORED' as IncidentStage, at: now, by: '계측 복구 감지' }] }),
          points,
          clearedAt: active ? null : restored ? cur.clearedAt ?? now : cur.clearedAt,
          ...(active && { scope: loc.scope, title: loc.title, reasons: loc.reasons, cause: causeOf(s) }),
          fi: { inlet: worse('inlet'), house: worse('house'), lamp: worse('lamp') },
          ruleEventId: cur.ruleEventId ?? ruleEventId,
          rawEventRecordId: cur.rawEventRecordId ?? rawEventRecordId,
        },
        ...rest,
      ],
    }, justRestored)
    return
  }
  if (!active) return
  const inc: LiveIncident = {
    id: Date.now() * 1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 1000,
    recordId: crypto.randomUUID(),
    deviceId: s.source === 'MOCK' ? 'arduino-sim-01' : 'arduino-village',
    observerId,
    rawEventRecordId,
    source: s.source,
    measurementScope: s.measurementScope,
    startedAt: now,
    clearedAt: null,
    scope: loc.scope,
    title: loc.title,
    reasons: loc.reasons,
    fi: fiNow,
    cause: causeOf(s),
    points: s.history.slice(-20).map(toPoint),
    ruleEventId,
    caseId: null,
    stage: 'RECEIVED',
    assignee: null,
    stageLog: [{ stage: 'RECEIVED', at: now, by: '고장표시 자동 접수' }],
  }
  set({ incidents: [inc, ...state.incidents] }, true)
}

export const FI_SHORT: Record<FiKind, string> = { ...FI_LABEL, NONE: '정상' }
