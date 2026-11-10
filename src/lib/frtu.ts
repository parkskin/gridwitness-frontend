// 마을 모형의 FRTU 3대.
// 실제 배전선로에는 FRTU가 여러 대 있고, 고장전류가 지나간 FRTU만 고장표시(FI)를 띄워 고장 구간을 좁힌다.
// 모형에는 INA219가 두 개(주택 구간 0x40, 가로등 구간 0x41)가 병렬 분기로 달려 있으므로 이렇게 대응시킨다.
//
//   5V → 전체 릴레이 ┬→ INA219 ① → 주택 1~3      = FRTU-주택 분기   (실측)
//                    └→ INA219 ② → 가로등 1~2    = FRTU-가로등 분기 (실측)
//   두 분기의 합                                 = 인입 FRTU        (계산값, 따로 재지 않음)
//
// FI는 교류 고장전류가 아니라 "그 구간의 예상 전류 대비 실측 전류"로 흉내 낸다 (직류 모형). 교류 고장파형 AI와 섞지 않는다.

import { IOT_CHANNELS, THRESHOLDS, ZONE_SENSOR, classify, type ChannelId, type ChannelKind, type NodeStatus, type VillageSnapshot } from './village'

export type FrtuId = 'inlet' | 'house' | 'lamp'

export interface FrtuDef {
  id: FrtuId
  name: string
  short: string
  role: '인입' | '분기'
  /** 값의 출처. 인입은 두 분기의 합으로 계산 */
  sensor: string
  measured: boolean
  zone: ChannelKind | null
  channels: ChannelId[]
}

export const FRTUS: FrtuDef[] = [
  { id: 'inlet', name: '인입 FRTU', short: '인입', role: '인입', sensor: 'INA219 ①+② 합 (계산값)', measured: false, zone: null, channels: IOT_CHANNELS.map((c) => c.id) },
  { id: 'house', name: 'FRTU-주택 분기', short: '주택 분기', role: '분기', sensor: ZONE_SENSOR.HOUSE, measured: true, zone: 'HOUSE', channels: IOT_CHANNELS.filter((c) => c.kind === 'HOUSE').map((c) => c.id) },
  { id: 'lamp', name: 'FRTU-가로등 분기', short: '가로등 분기', role: '분기', sensor: ZONE_SENSOR.LAMP, measured: true, zone: 'LAMP', channels: IOT_CHANNELS.filter((c) => c.kind === 'LAMP').map((c) => c.id) },
]
export const FRTU_BY_ID = Object.fromEntries(FRTUS.map((f) => [f.id, f])) as Record<FrtuId, FrtuDef>
export const isFrtuId = (x: string | null | undefined): x is FrtuId => x === 'inlet' || x === 'house' || x === 'lamp'

/** 고장표시 종류 */
export type FiKind = 'NONE' | 'LOW' | 'HIGH' | 'VOLTAGE' | 'OUTAGE'
export const FI_LABEL: Record<FiKind, string> = {
  NONE: '고장표시 없음',
  LOW: '전류 부족 (단선 의심)',
  HIGH: '전류 과다 (누설·과전류 의심)',
  VOLTAGE: '전압 강하',
  OUTAGE: '전원 없음',
}

export interface FrtuView {
  def: FrtuDef
  /** 값을 받을 수 있는지 (장치 연결, 구간 측정 지원) */
  available: boolean
  unavailableReason: string | null
  status: NodeStatus
  v: number
  i: number
  expected: number
  score: number
  fi: FiKind
}

function fiOf(status: NodeStatus, v: number, i: number, expected: number, score: number): FiKind {
  if (status === 'OUTAGE') return 'OUTAGE'
  if (status === 'NO_DATA' || status === 'OFF' || score < THRESHOLDS.warn) return 'NONE'
  // 전압이 기준보다 낮고 전류 차이가 LED 반 개 분량도 안 되면 전원 쪽 문제
  if (v < THRESHOLDS.vMin && Math.abs(i - expected) < expected * 0.25) return 'VOLTAGE'
  return i < expected ? 'LOW' : 'HIGH'
}

export function frtuViews(s: VillageSnapshot): Record<FrtuId, FrtuView> {
  const off = (def: FrtuDef, reason: string): FrtuView => ({ def, available: false, unavailableReason: reason, status: 'NO_DATA', v: 0, i: 0, expected: 0, score: 0, fi: 'NONE' })
  const noData = !s.connected || s.status === 'NO_DATA'
  const out = {} as Record<FrtuId, FrtuView>
  for (const def of FRTUS) {
    if (noData) {
      out[def.id] = off(def, '실측 장치와 연결이 끊겨 계측값이 없어요.')
      continue
    }
    if (def.zone === null) {
      if (s.source === 'SERIAL' && s.measurementScope !== 'BOTH') {
        out[def.id] = off(def, '인입 전류를 재는 센서가 없어요. 주택 분기 실측값을 인입값으로 대신하지 않습니다.')
        continue
      }
      out[def.id] = { def, available: true, unavailableReason: null, status: s.status, v: s.v, i: s.i, expected: s.expected, score: s.score, fi: fiOf(s.status, s.v, s.i, s.expected, s.score) }
      continue
    }
    const z = s.zones?.[def.zone]
    if (!z) {
      const sensorIsThisZone = s.source === 'SERIAL' && ((def.zone === 'HOUSE' && s.measurementScope === 'HOUSE') || (def.zone === 'LAMP' && s.measurementScope === 'LAMP'))
      if (sensorIsThisZone) {
        const r = { v: s.v, i: s.i, expected: s.expected, score: s.score, estLit: Math.max(0, Math.min(def.channels.length, Math.round(s.i / (s.expected || 1)))) }
        out[def.id] = { def, available: true, unavailableReason: null, status: s.status, v: r.v, i: r.i, expected: r.expected, score: r.score, fi: fiOf(s.status, r.v, r.i, r.expected, r.score) }
        continue
      }
      out[def.id] = off(def, def.zone === 'LAMP' ? '가로등 전류는 계측하지 않아요. LED 점등은 릴레이 상태만 표시합니다.' : '주택 분기 센서가 확인되지 않아 실측값이 없어요.')
      continue
    }
    const status = classify(z.v, z.i, z.score, s.relay)
    out[def.id] = { def, available: true, unavailableReason: null, status, v: z.v, i: z.i, expected: z.expected, score: z.score, fi: fiOf(status, z.v, z.i, z.expected, z.score) }
  }
  return out
}

/**
 * Presentation-only fallback for a live demo with the lamp INA219 absent.
 * Never use this helper for diagnosis, persistence, history, or assistant evidence.
 */
export function frtuDisplayViews(s: VillageSnapshot): Record<FrtuId, FrtuView> {
  const views = frtuViews(s)
  if (s.source !== 'SERIAL' || s.measurementScope !== 'HOUSE' || !s.connected || s.status === 'NO_DATA') return views
  const lamp = views.lamp
  if (lamp.available) return views
  const on = s.relay ? lamp.def.channels.filter((id) => s.channels[id]).length : 0
  const expected = s.relay ? on * 0.056 : 0
  const i = s.relay ? expected * 0.97 : 0
  const v = s.relay ? Math.max(0, s.v - 0.01) : 0
  const status = classify(v, i, 0, s.relay)
  views.lamp = {
    ...lamp,
    available: true,
    unavailableReason: null,
    status,
    v,
    i,
    expected,
    score: 0,
    fi: 'NONE',
  }
  return views
}

/** History samples contain only channels that were actually measured at that time. */
export function frtuHistory(s: VillageSnapshot, id: FrtuId): { available: boolean; reason: string | null; points: { t: number; mA: number; v: number }[] } {
  const view = frtuViews(s)[id]
  if (!view.available) return { available: false, reason: view.unavailableReason, points: [] }
  const points = s.history.flatMap((h) => {
    const current = id === 'inlet' ? (s.measurementScope === 'BOTH' || s.source === 'MOCK' ? h.i : undefined) : id === 'house' ? h.ih : h.il
    return typeof current === 'number' && Number.isFinite(current) && Number.isFinite(h.v)
      ? [{ t: h.t, mA: current * 1000, v: h.v }]
      : []
  })
  if (!points.length) return { available: false, reason: '선택한 FRTU의 저장된 파형 표본이 없어요.', points: [] }
  return { available: true, reason: null, points }
}

export type FaultScope = 'NO_DATA' | 'OFF' | 'NONE' | 'HOUSE' | 'LAMP' | 'BOTH' | 'UPSTREAM' | 'UNKNOWN'

export interface FaultLocation {
  scope: FaultScope
  /** 한 줄 결론 */
  title: string
  /** 결론에 쓴 FRTU별 근거 (값 그대로) */
  reasons: string[]
  /** 강조할 FRTU */
  frtus: FrtuId[]
}

const mA = (a: number) => `${(a * 1000).toFixed(1)} mA`
export const frtuReason = (f: FrtuView) =>
  `${f.def.name}: ${FI_LABEL[f.fi]} · 측정 ${mA(f.i)} / 예상 ${mA(f.expected)}${f.expected > 0 ? ` (${Math.round((f.i / f.expected) * 100)}%)` : ''} · ${f.v.toFixed(2)} V`

/** FRTU별 고장표시로 고장 구간을 좁힌다. 분기가 병렬 두 갈래라 "어느 분기인지"까지만 가릴 수 있다 */
export function locateFault(s: VillageSnapshot, views = frtuViews(s)): FaultLocation {
  const { inlet, house, lamp } = views
  if (s.source === 'SERIAL' && s.measurementScope === 'HOUSE' && house.available) {
    if (!s.relay && house.status === 'OFF') return { scope: 'OFF', title: '마을 릴레이가 차단된 상태예요. 주택 분기 고장 여부는 판정하지 않아요.', reasons: [frtuReason(house)], frtus: ['house'] }
    if (house.fi === 'NONE') return { scope: 'NONE', title: '주택 분기 실측에서 기준 이탈이 감지되지 않았어요', reasons: [frtuReason(house), '가로등과 인입은 측정하지 않았어요.'], frtus: ['house'] }
    return { scope: 'HOUSE', title: `주택 분기 실측에서 이상이 감지됐어요 (${FI_LABEL[house.fi]})`, reasons: [frtuReason(house), '가로등과 인입은 측정하지 않았으므로 판정 대상이 아닙니다.'], frtus: ['house'] }
  }
  if (s.source === 'SERIAL' && s.measurementScope !== 'BOTH' && !house.available) return { scope: 'NO_DATA', title: '확인된 주택 분기 실측값이 없어요', reasons: [lamp.unavailableReason ?? inlet.unavailableReason ?? '센서 범위를 확인할 수 없습니다.'], frtus: [] }
  if (!inlet.available) return { scope: 'NO_DATA', title: '계측값이 없어 고장 구간을 판단할 수 없어요', reasons: [inlet.unavailableReason ?? ''], frtus: [] }
  if (!s.relay && inlet.status === 'OFF') return { scope: 'OFF', title: '마을 전원이 차단된 상태예요 (의도한 정전)', reasons: [], frtus: [] }
  if (!house.available || !lamp.available) {
    return inlet.fi === 'NONE'
      ? { scope: 'NONE', title: '이상 없음', reasons: [frtuReason(inlet)], frtus: [] }
      : { scope: 'UNKNOWN', title: '이상은 있지만 분기 FRTU 값이 없어 구간을 좁힐 수 없어요', reasons: [frtuReason(inlet)], frtus: ['inlet'] }
  }
  const hit = [house, lamp].filter((f) => f.fi !== 'NONE')
  const reasons = [frtuReason(house), frtuReason(lamp)]
  if (!hit.length) return { scope: 'NONE', title: '이상 없음', reasons, frtus: [] }
  if (hit.length === 1) {
    const f = hit[0]
    return { scope: f.def.zone!, title: `${f.def.short} 쪽 고장으로 보여요 (${FI_LABEL[f.fi]})`, reasons: [...reasons, `다른 분기는 정상이라 분기점 앞(전원·전체 릴레이)은 원인에서 빠져요.`], frtus: ['inlet', f.def.id] }
  }
  // 두 분기가 같이 전압 강하·전원 없음이면 공통 원인은 분기점 앞
  if (hit.every((f) => f.fi === 'VOLTAGE' || f.fi === 'OUTAGE'))
    return { scope: 'UPSTREAM', title: '두 분기가 함께 전압 이상 — 분기점 앞(전원·전체 릴레이) 쪽으로 보여요', reasons, frtus: ['inlet'] }
  return { scope: 'BOTH', title: '두 분기 모두 이상이에요 (분기마다 따로 점검 필요)', reasons, frtus: ['inlet', 'house', 'lamp'] }
}
