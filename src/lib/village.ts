import { parseEventLine, pushVillageEvent } from './villageEvents'
import COMBO_JSON from '../data/village_combo.json'
import { deviation } from './deviation'
import { useSyncExternalStore } from 'react'
import type { IotPoint } from '../types'
import { NO_GRANTED_PORT, onSerialPlug, openSerial, parseFrame, serialSupported, type SerialLink, type SerialReading } from './serial'

// 스마트 마을 모형 계측 (채널 릴레이 구성).
//   5V DC 어댑터 → 전체 릴레이(D2, COM→NC, 마을 ON/OFF)
//     → INA219 ① 0x40 → 채널 릴레이 ①~③ (D3~D5) → 주택 1~3 LED
//     → INA219 ② 0x41 → 채널 릴레이 ④~⑤ (D6~D7) → 가로등 1~2 LED
// 출처: MOCK(브라우저 시뮬레이터) 또는 SERIAL(실제 모형, Web Serial).
// LED별 전류는 측정하지 않음. 구간 전류로 켜진 LED 수를 추정하고, 어느 LED인지는 채널 점검으로 확인. 교류 고장파형과는 별개 데이터.

export type ChannelId = 'h1' | 'h2' | 'h3' | 'l1' | 'l2'
export type ChannelKind = 'HOUSE' | 'LAMP'
export type DataSource = 'MOCK' | 'SERIAL'
export type MeasurementScope = 'BOTH' | 'HOUSE' | 'LAMP' | 'UNKNOWN'
/** LED 위치 고장(OPEN·GROUND)과 전원·제어 고장(SAG·OUTAGE·STUCK) */
export type FaultKind = 'OPEN' | 'GROUND' | 'SAG' | 'OUTAGE' | 'STUCK'
export type NodeStatus = 'NORMAL' | 'OFF' | 'WARNING' | 'FAULT' | 'OUTAGE' | 'NO_DATA'

export interface ChannelDef {
  id: ChannelId
  /** LED 번호 (구성도의 LED 1~5) */
  ch: number
  kind: ChannelKind
  name: string
  /** 이 LED를 켜고 끄는 채널 릴레이와 Arduino 핀 */
  relay: string
}

/** 마을 부하: 주택 3 + 가로등 2. LED마다 채널 릴레이가 있고, 구간마다 INA219가 하나씩 있음 */
export const IOT_CHANNELS: ChannelDef[] = [
  { id: 'h1', ch: 1, kind: 'HOUSE', name: '주택 1', relay: '릴레이 ① · D3' },
  // 실제 배선에서 주택 2·3 LED가 서로 바뀌어 있어 채널 번호를 맞바꿈 (주택 2 = 채널 ③ D5, 주택 3 = 채널 ② D4)
  { id: 'h2', ch: 3, kind: 'HOUSE', name: '주택 2', relay: '릴레이 ③ · D5' },
  { id: 'h3', ch: 2, kind: 'HOUSE', name: '주택 3', relay: '릴레이 ② · D4' },
  { id: 'l1', ch: 4, kind: 'LAMP', name: '가로등 1', relay: '릴레이 ④ · D6' },
  { id: 'l2', ch: 5, kind: 'LAMP', name: '가로등 2', relay: '릴레이 ⑤ · D7' },
]

export const SOURCE_LABEL: Record<DataSource, string> = {
  MOCK: '시뮬레이터',
  SERIAL: '실측 · Arduino',
}

export const FAULT_LABEL: Record<FaultKind, string> = {
  OPEN: 'LED 단선',
  GROUND: '누설·과전류',
  SAG: '어댑터 전압 강하',
  OUTAGE: '어댑터 전원 상실',
  STUCK: '릴레이 접점 고착',
}
/** 특정 LED 위치에 거는 고장인지 */
export const FAULT_AT_LED: Record<FaultKind, boolean> = { OPEN: true, GROUND: true, SAG: false, OUTAGE: false, STUCK: false }

export const STATUS_LABEL: Record<NodeStatus, string> = {
  NORMAL: '정상',
  OFF: '차단됨',
  WARNING: '주의',
  FAULT: '이상',
  OUTAGE: '정전',
  NO_DATA: '데이터 없음',
}

export const DEVICE_INFO: Record<DataSource, { deviceId: string; sensor: string; port: string }> = {
  MOCK: { deviceId: 'arduino-sim-01', sensor: 'INA219 ×2 (시뮬레이터)', port: 'SIM' },
  SERIAL: { deviceId: 'arduino-village', sensor: 'INA219 (실측, 감지된 개수만큼)', port: 'Web Serial 115200' },
}
export const IOT_MODEL = 'iot-combo-v3 (주택·가로등 합산 조합별 실측 정상 전류)'
export const NOMINAL_V = 5
/** LED 1개(저항 포함)가 흘리는 전류 A 기본값. 실제 LED·저항·전원 전압에 따라 크게 달라서 관리자 화면에서 보정할 수 있음 */
// 실측 (2026-11-08, USB 전원): LED 1개 9~12 mA. 여러 개를 켜면 전압이 내려가 합이 맞지 않으므로 판정은 아래 조합표를 쓴다
export const DEFAULT_LED_A = 0.011
const LED_KEY = 'gridwitness.ledA.v1'
function loadLedA(): number {
  try {
    const n = Number(localStorage.getItem(LED_KEY))
    if (Number.isFinite(n) && n >= 0.002 && n <= 0.3) return n
  } catch {
    // 저장값을 못 읽으면 기본값
  }
  return DEFAULT_LED_A
}
let ledAValue = loadLedA()
/** LED 1개 기준 전류 (A). 항상 최신 값 */
export const ledA = () => ledAValue
export function setLedA(a: number) {
  if (!Number.isFinite(a) || a < 0.002 || a > 0.3) return
  ledAValue = a
  try {
    localStorage.setItem(LED_KEY, String(a))
  } catch {
    // 저장 불가 환경은 무시
  }
  emit()
}
/** 지금 켜져 있는 LED 수로 현재 전류를 나눠 기준값으로 삼음. 실패하면 이유를 돌려줌 */
export function calibrateLedA(): { ok: true; a: number; n: number; vMin: number | null } | { ok: false; reason: string } {
  if (!snap.connected || snap.status === 'NO_DATA') return { ok: false, reason: '장치에서 측정값을 받고 있지 않습니다.' }
  if (!snap.relay) return { ok: false, reason: '마을 전원이 꺼져 있습니다. 전력 복구 뒤에 시도하세요.' }
  const counted = IOT_CHANNELS.filter((c) => snap.channels[c.id] && !snap.faults[c.id] && (snap.source !== 'SERIAL' || snap.measurementScope === 'BOTH' || c.kind === (snap.measurementScope === 'HOUSE' ? 'HOUSE' : 'LAMP')))
  const n = counted.length
  if (n < 1) return { ok: false, reason: '켜져 있는 LED 채널이 없습니다.' }
  if (snap.i < 0.003) return { ok: false, reason: `전류가 거의 없습니다(${snap.i.toFixed(3)} A). LED가 켜져 있는지 확인하세요.` }
  const a = snap.i / n
  setLedA(a)
  // 전원이 약해서 전압이 하한보다 낮게 측정되면 하한도 그에 맞춰 낮춘다 (정상 상태를 매번 이상으로 판정하지 않도록).
  // 하한은 지금 전압보다 0.4V 아래로 잡는다. 전압 강하·정전 판정(1V 미만)은 그대로다.
  let vMin: number | null = null
  if (snap.v < THRESHOLDS.vMin + 0.15) {
    vMin = Math.max(2.5, Math.floor((snap.v - 0.4) * 20) / 20)
    setThresholds({ vMin })
  }
  return { ok: true, a, n, vMin }
}
/** 이상 탐지 기준. 관리자 페이지에서 바꾸면 이 브라우저에 저장됨 */
export interface Thresholds {
  /** 이 점수 이상이면 '주의' */
  warn: number
  /** 이 점수 이상이면 '이상' */
  fault: number
  /** 릴레이가 닫혀 있을 때 이 전압(V) 아래로 내려가면 점수가 오름 */
  vMin: number
}
export const DEFAULT_THRESHOLDS: Thresholds = { warn: 0.3, fault: 0.6, vMin: 4.75 }
const TH_KEY = 'gridwitness.thresholds.v1'
function loadThresholds(): Thresholds {
  try {
    const raw = JSON.parse(localStorage.getItem(TH_KEY) ?? 'null') as Partial<Thresholds> | null
    if (raw && typeof raw.warn === 'number' && typeof raw.fault === 'number' && typeof raw.vMin === 'number' && raw.warn < raw.fault) return { warn: raw.warn, fault: raw.fault, vMin: raw.vMin }
  } catch {
    // 저장값을 못 읽으면 기본값
  }
  return { ...DEFAULT_THRESHOLDS }
}
/** 항상 같은 객체를 갱신해서 어디서 읽어도 최신 값 */
export const THRESHOLDS: Thresholds = loadThresholds()
export function setThresholds(next: Partial<Thresholds>) {
  Object.assign(THRESHOLDS, next)
  // 주의 기준이 이상 기준 이상이면 화면에서만 보여주고 저장하지 않음 (다시 열면 마지막 정상 값)
  if (THRESHOLDS.warn < THRESHOLDS.fault) {
    try {
      localStorage.setItem(TH_KEY, JSON.stringify(THRESHOLDS))
    } catch {
      // 저장 불가 환경은 무시
    }
  }
  emit()
}
export function resetThresholds() {
  setThresholds({ ...DEFAULT_THRESHOLDS })
}
export const TICK_MS = 500
const HISTORY = 120
const COMMAND_LATENCY_MS = 350 // 시뮬레이터 릴레이 응답 지연

export interface LedState extends ChannelDef {
  /** 켜져 있다고 보는지. Mock은 시뮬레이터 값, 실측은 구간 전류로 추정 */
  lit: boolean
  /** 채널 릴레이가 켜져 있는지 (꺼져 있으면 의도한 소등) */
  channelOn: boolean
  fault: FaultKind | null
}

/** 측정 구간: INA219 ① 0x40 = 주택 1~3, ② 0x41 = 가로등 1~2 */
export const ZONE_LABEL: Record<ChannelKind, string> = { HOUSE: '주택 구간', LAMP: '가로등 구간' }
export const ZONE_SENSOR: Record<ChannelKind, string> = { HOUSE: 'INA219 ① 0x40', LAMP: 'INA219 ② 0x41' }
export const zoneChannels = (kind: ChannelKind) => IOT_CHANNELS.filter((c) => c.kind === kind)

export interface ZoneState {
  v: number
  i: number
  expected: number
  score: number
  /** 구간 전류로 추정한 켜진 LED 수 */
  estLit: number
}

export interface VillageEvent {
  id: number
  source: DataSource
  /** 사건 제목으로 쓸 이름 (없으면 상태로 만듦) */
  label?: string
  at: string
  injected: FaultKind | null
  injectedAt: string | null
  status: Exclude<NodeStatus, 'NORMAL' | 'OFF' | 'NO_DATA'>
  maxScore: number
  relayOn: boolean
  expected: number
  window: IotPoint[]
  clearedAt: string | null
  caseId: string | null
  /** 사건 근거에 덧붙일 설명 (시험 시나리오로 만든 이벤트 등) */
  notes?: string[]
}

export interface Scenario {
  label: string
  profile: number[]
  hour: number
}

// ── 조합별 정상 전류표 (실측 학습) ─────────────────────
// 32가지 채널 조합마다 실제로 잰 정상 전류(중앙값)와 흔들림. 키는 장치 채널 1~5(D3~D7) 순서
interface ComboTable {
  source: string
  k_sigma: number
  mean_a: Record<string, number>
  sigma_a: Record<string, number>
  eval: { normal_false_alarm: { rate: number; samples: number }; open_circuit: { detected: number }; stuck_relay: { detected: number }; candidates: Record<string, { true_channel_in_candidates: number; mean_candidates: number }> }
}
export const COMBO = COMBO_JSON as ComboTable

// 이 PC에서 다시 맞춘 기준 (USB 전원·포트가 바뀌면 정상 전류가 조금 달라진다). 흔들림(sigma)·기준(k)은 학습값을 그대로 쓴다
export interface ComboCalibration {
  at: string
  mean_a: Record<string, number>
  samplesPerCombo: number
  /** 학습 기준과 가장 크게 달라진 조합의 차이 (A) */
  maxShiftA: number
}
const CAL_KEY = 'gridwitness.comboCal.v1'
function loadCal(): ComboCalibration | null {
  try {
    const raw = localStorage.getItem(CAL_KEY)
    return raw ? (JSON.parse(raw) as ComboCalibration) : null
  } catch {
    return null
  }
}
let comboCal: ComboCalibration | null = loadCal()
export const getComboCalibration = () => comboCal
export function setComboCalibration(cal: ComboCalibration | null) {
  comboCal = cal
  try {
    if (cal) localStorage.setItem(CAL_KEY, JSON.stringify(cal))
    else localStorage.removeItem(CAL_KEY)
  } catch {
    // 저장할 수 없는 환경이면 이 화면에서만 씀
  }
  emit()
}
/** 조합의 정상 전류: 이 PC에서 맞춘 값이 있으면 그것, 없으면 학습값 */
export function comboMean(key: string): number | undefined {
  return comboCal?.mean_a[key] ?? COMBO.mean_a[key]
}
/** 지금 명령한 조합 (장치 채널 1~5 순서, '1' = 켬) */
export const currentCommandKey = () => commandKey()
/** 지금 켜라고 한 채널 조합 (장치 채널 순서) */
function commandKey(): string {
  return [1, 2, 3, 4, 5].map((n) => (enabled[IOT_CHANNELS.find((c) => c.ch === n)!.id] ? '1' : '0')).join('')
}
export interface ComboDiagnosis {
  /** LOW: 켜라고 한 채널 중 전류를 안 흘리는 것이 있음 (단선 의심) · HIGH: 끈 채널에 전류가 흐름(고착 의심) 또는 누설 */
  kind: 'LOW' | 'HIGH'
  z: number
  /** 한 채널만 바꿨을 때 측정과 맞는 채널 (센서가 1개라 여러 개일 수 있음) */
  candidates: ChannelId[]
}
/** 장치가 전류를 1 mA 단위로 보내므로 그 한 칸만큼은 허용 (다른 시점 실측에서 정상값이 1 mA 달라지는 것 확인, 2026-11-08) */
export const COMBO_TOL_A = (COMBO_JSON as { tol_a?: number }).tol_a ?? 0.001
/** 지금 조합에서 채널 하나를 끄면 줄어들 것으로 예상되는 전류 (조합표). 표에 없으면 null */
export function expectedDrop(id: ChannelId): number | null {
  if (source === 'SERIAL' && measurementScope === 'HOUSE' && IOT_CHANNELS.find((c) => c.id === id)?.kind === 'HOUSE') return enabled[id] ? ledA() : null
  const key = commandKey()
  const j = IOT_CHANNELS.find((c) => c.id === id)!.ch - 1
  if (key[j] !== '1') return null
  const off = key.slice(0, j) + '0' + key.slice(j + 1)
  const a = comboMean(key)
  const b = comboMean(off)
  return a == null || b == null ? null : a - b
}
/** 조합표로 판정: 점수(0~1)와 진단. 표에 없는 조합이면 null */
function comboJudge(key: string, i: number): { expected: number; score: number; diag: ComboDiagnosis | null } | null {
  const mu = comboMean(key)
  const sd = COMBO.sigma_a[key]
  if (mu == null || sd == null) return null
  const z = (i - mu) / sd
  // 대단지 세대 판정과 같은 규칙 (deviation.ts)
  const dv = deviation(i, mu, { sigma: sd, k: COMBO.k_sigma, tol: COMBO_TOL_A })
  const score = dv.score
  if (dv.ratio <= 1) return { expected: mu, score, diag: null }
  const candidates: ChannelId[] = []
  for (let j = 0; j < 5; j++) {
    const alt = key.slice(0, j) + (key[j] === '1' ? '0' : '1') + key.slice(j + 1)
    const m2 = comboMean(alt)
    const s2 = COMBO.sigma_a[alt]
    if (m2 != null && s2 != null && Math.abs(i - m2) <= COMBO.k_sigma * s2 + COMBO_TOL_A) candidates.push(IOT_CHANNELS.find((c) => c.ch === j + 1)!.id)
  }
  return { expected: mu, score, diag: { kind: z < 0 ? 'LOW' : 'HIGH', z: Math.round(z * 10) / 10, candidates } }
}

export interface VillageSnapshot {
  source: DataSource
  connected: boolean
  lastError: string | null
  badFrames: number
  /** 장치에서 받은 줄 수 (형식이 맞든 틀리든) */
  rawLines: number
  /** 마지막으로 받은 줄 원문 (진단용) */
  lastLine: string | null
  /** 스케치가 보낸 '#' 안내 줄 중 가장 최근 것 (센서를 찾았는지 등) */
  lastNote: string | null
  /** 실제 센서 응답으로 확인된 측정 범위. 단일 센서값을 마을 전체값으로 확대 해석하지 않음 */
  measurementScope: MeasurementScope
  lastPacketAt: number | null
  packets: number
  /** 마을 전체 전원(릴레이) */
  relay: boolean
  relayPending: boolean | null
  v: number
  i: number
  p: number
  expected: number
  score: number
  status: NodeStatus
  /** 전체 전류로 추정한 켜진 LED 수 */
  estLit: number
  leds: Record<ChannelId, LedState>
  /** 채널 릴레이 상태 (D3~D7) */
  channels: Record<ChannelId, boolean>
  /** 장치 확인을 기다리는 채널 명령 */
  channelPending: Partial<Record<ChannelId, boolean>>
  /** 웹에서 채널을 끄고 켤 수 있는지 (시뮬레이터, 또는 채널 상태를 보고하는 장치) */
  canControl: boolean
  /** 실측 장치를 다시 찾는 중 (자동 재연결) */
  reconnecting: boolean
  /** 이 브라우저에 이전에 허용한 포트가 없어 자동 재연결이 불가능함 (클릭해서 다시 허용해야 함) */
  needsGrant: boolean
  /** 구간별 측정. 구간 측정이 없는 예전 장치는 null */
  zones: Partial<Record<ChannelKind, ZoneState>> | null
  /** 조합표 판정 결과 (실측 장치, 이상일 때) */
  diagnosis: ComboDiagnosis | null
  history: (Omit<IotPoint, 't'> & { t: number; p: number })[]
  events: VillageEvent[]
  faults: Partial<Record<ChannelId, FaultKind>>
  supplyFault: FaultKind | null
  scenario: Scenario | null
  thresholds: Thresholds
}

/** IoT 이상 탐지: 릴레이 상태로 예상 전류를 정하고, 실제 전류와의 차이(LED 2개 분량 = 1.0)와 전압 강하로 점수 산출 */
export function anomalyScore(v: number, i: number, expected: number): number {
  const ri = Math.abs(i - expected) / (ledA() * 2)
  const rv = expected > 0 ? Math.max(0, THRESHOLDS.vMin - v) / 0.75 : 0
  return Math.min(1, Math.max(ri, rv))
}

export function classify(v: number, i: number, score: number, relay: boolean): NodeStatus {
  if (!relay) return i > 0.03 ? 'FAULT' : 'OFF'
  if (v < 1) return 'OUTAGE'
  if (score >= THRESHOLDS.fault) return 'FAULT'
  if (score >= THRESHOLDS.warn) return 'WARNING'
  return 'NORMAL'
}

const RANK: Record<NodeStatus, number> = { OFF: 0, NORMAL: 0, NO_DATA: 1, WARNING: 2, FAULT: 3, OUTAGE: 4 }
const noise = (amp: number) => (Math.random() - 0.5) * 2 * amp
const isAbnormal = (s: NodeStatus): s is VillageEvent['status'] => s === 'WARNING' || s === 'FAULT' || s === 'OUTAGE'

let t = 0
let eventSeq = 0
const faults: Partial<Record<ChannelId, FaultKind>> = {}
let supplyFault: FaultKind | null = null
let lastInjectedAt: string | null = null
let relay = true
let relayPending: boolean | null = null
let commandTimer: ReturnType<typeof setTimeout> | undefined
/** 채널 릴레이 상태 (D3~D7). 시뮬레이터는 명령 값, 실측은 장치가 보고한 값 */
const enabled: Record<ChannelId, boolean> = { h1: true, h2: true, h3: true, l1: true, l2: true }
const chPending: Partial<Record<ChannelId, boolean>> = {}
const chTimers: Partial<Record<ChannelId, ReturnType<typeof setTimeout>>> = {}
// 한 번 실측 장치로 연결하면 그 선택을 기억해서, 다음에 열 때 허용 창 없이 다시 붙는다
const AUTO_KEY = 'gridwitness.autoSerial.v1'
function autoPref(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === '1' && serialSupported()
  } catch {
    return false
  }
}
function setAutoPref(on: boolean) {
  try {
    if (on) localStorage.setItem(AUTO_KEY, '1')
    else localStorage.removeItem(AUTO_KEY)
  } catch {
    // 저장 불가 환경은 무시
  }
}
// 시뮬레이터는 사용자가 직접 고른 경우에만 켠다. 아무것도 고르지 않았으면 '실측 장치 · 연결 안 됨'으로 시작해
// 장치 없이 계산한 값이 실측처럼 먼저 보이지 않게 한다
const SIM_KEY = 'gridwitness.simulator.v1'
function simPref(): boolean {
  try {
    return localStorage.getItem(SIM_KEY) === '1'
  } catch {
    return false
  }
}
function setSimPref(on: boolean) {
  try {
    if (on) localStorage.setItem(SIM_KEY, '1')
    else localStorage.removeItem(SIM_KEY)
  } catch {
    // 저장 불가 환경은 무시
  }
}
let source: DataSource = !autoPref() && simPref() ? 'MOCK' : 'SERIAL'
let connected = source === 'MOCK'
let link: SerialLink | null = null
let latest: { at: number; frame: SerialReading } | null = null
let badFrames = 0
let rawLines = 0
let lastLine: string | null = null
let lastNote: string | null = null
let measurementScope: MeasurementScope = 'UNKNOWN'
let lastError: string | null = null
let scenario: Scenario | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

/** 접점이 실제로 닫혀 있는지 (고착이면 명령과 상관없이 닫힘) */
export function contactClosed(s: Pick<VillageSnapshot, 'relay' | 'supplyFault'>): boolean {
  return s.relay || s.supplyFault === 'STUCK'
}

/** 시뮬레이터: LED가 실제로 빛나는지 (릴레이·전원·고장·시나리오 반영) */
function mockLit(id: ChannelId): boolean {
  return contactClosed({ relay, supplyFault }) && supplyFault !== 'OUTAGE' && enabled[id] && faults[id] !== 'OPEN'
}

/** 시뮬레이터 측정: INA219 두 개가 각 구간 전압·전류를 잼 */
function mockMeasure(): SerialReading & { zones: NonNullable<SerialReading['zones']> } {
  // 회로가 열려 있으면 INA219는 0 V·0 A (표시 자릿수 아래의 잡음만)
  if (!contactClosed({ relay, supplyFault }) || supplyFault === 'OUTAGE') {
    const off = () => ({ v: Math.abs(noise(0.004)), i: Math.abs(noise(0.0004)) })
    const house = off()
    const lamp = off()
    return { v: Math.max(house.v, lamp.v), i: house.i + lamp.i, relay, zones: { house, lamp } }
  }
  const vSupply = supplyFault === 'SAG' ? 4.25 + noise(0.05) : 5.03 + noise(0.015)
  const zone = (kind: ChannelKind) => {
    let i = 0
    for (const c of zoneChannels(kind)) {
      if (!mockLit(c.id)) continue
      i += ledA() * (vSupply / 5) * (1 + 0.03 * Math.sin(t / 7 + c.ch))
      if (faults[c.id] === 'GROUND') i += 0.22
    }
    i = Math.max(0, i + noise(0.002))
    return { v: vSupply - i * 0.06, i }
  }
  const house = zone('HOUSE')
  const lamp = zone('LAMP')
  return { v: Math.min(house.v, lamp.v), i: house.i + lamp.i, relay, zones: { house, lamp } }
}

/** 구간 예상 전류 = 마을 전원이 들어가 있을 때 켜진 채널 수 × LED 1개 기준 전류 */
function expectedZone(kind: ChannelKind): number {
  if (!relay) return 0
  return zoneChannels(kind).filter((c) => enabled[c.id]).length * ledA()
}

/** 웹에서 채널을 조종할 수 있는지: 시뮬레이터이거나, 채널 상태를 보고하는 장치 */
function canControlChannels(): boolean {
  return source === 'MOCK' || !!latest?.frame.ch
}

function ledStates(zones: VillageSnapshot['zones']): Record<ChannelId, LedState> {
  // 실측은 LED별 전류가 없으므로 구간마다 "켜진 수"를 켜져 있는 채널 앞에서부터 채워 표시
  const litSerial = (c: ChannelDef) => {
    if (!enabled[c.id]) return false
    // 센서가 1개면 어느 LED의 전류가 모자란지 알 수 없다. 특정 LED(예: 맨 뒤 가로등 2)를 꺼진 것으로 찍으면 오해라서,
    // 채널이 켜져 있으면 켜진 것으로 보고 전류 부족은 전체 판정·'켜진 LED 수'로만 알린다. 어느 LED인지는 채널 점검으로 확인
    if (!zones) return true
    const on = zoneChannels(c.kind).filter((x) => enabled[x.id])
    const zone = zones[c.kind]
    // 측정하지 않는 가로등은 LED 릴레이 명령 상태만 시각화한다.
    if (!zone) return true
    return on.findIndex((x) => x.id === c.id) < zone.estLit
  }
  return Object.fromEntries(
    IOT_CHANNELS.map((c) => [
      c.id,
      { ...c, lit: source === 'MOCK' ? mockLit(c.id) : litSerial(c), channelOn: enabled[c.id], fault: source === 'MOCK' ? (faults[c.id] ?? null) : null },
    ]),
  ) as Record<ChannelId, LedState>
}

function initial(): VillageSnapshot {
  return {
    source,
    connected,
    lastError: null,
    badFrames: 0,
    rawLines: 0,
    lastLine: null,
    lastNote: null,
    measurementScope: source === 'MOCK' ? 'BOTH' : 'UNKNOWN',
    lastPacketAt: null,
    packets: 0,
    relay,
    relayPending: null,
    // 장치 값이 오기 전에는 0 · 데이터 없음 (시뮬레이터만 계산값으로 시작)
    v: source === 'MOCK' ? NOMINAL_V : 0,
    i: source === 'MOCK' ? ledA() * 5 : 0,
    p: source === 'MOCK' ? NOMINAL_V * ledA() * 5 : 0,
    expected: source === 'MOCK' ? ledA() * 5 : 0,
    score: 0,
    status: source === 'MOCK' ? 'NORMAL' : 'NO_DATA',
    estLit: source === 'MOCK' ? 5 : 0,
    leds: ledStates(null),
    channels: { ...enabled },
    channelPending: {},
    canControl: true,
    zones: null,
    diagnosis: null,
    reconnecting: false,
    needsGrant: false,
    history: [],
    events: [],
    faults: {},
    supplyFault: null,
    scenario: null,
    thresholds: { ...THRESHOLDS },
  }
}

let snap: VillageSnapshot = initial()

function emit(patch: Partial<VillageSnapshot> = {}) {
  const zones = patch.zones !== undefined ? patch.zones : snap.zones
  snap = {
    ...snap,
    ...patch,
    measurementScope: source === 'MOCK' ? 'BOTH' : measurementScope,
    source,
    connected,
    lastError,
    badFrames,
    rawLines,
    lastLine,
    lastNote,
    relay,
    relayPending,
    leds: ledStates(zones),
    channels: { ...enabled },
    channelPending: { ...chPending },
    canControl: canControlChannels(),
    reconnecting: source === 'SERIAL' && !link && autoPref(),
    needsGrant: source === 'SERIAL' && !link && autoPref() && noGrant,
    faults: { ...faults },
    supplyFault,
    scenario: scenario && { ...scenario },
    thresholds: { ...THRESHOLDS },
  }
  listeners.forEach((l) => l())
}

function advanceScenario() {
  if (!scenario || t % 4 !== 0) return
  scenario.hour = (scenario.hour + 1) % 24
  const max = Math.max(...scenario.profile)
  const n = Math.round((scenario.profile[scenario.hour] / max) * IOT_CHANNELS.length)
  IOT_CHANNELS.forEach((c, k) => {
    const want = k < n
    if (source === 'MOCK') enabled[c.id] = want
    // 실측: 실제 채널 릴레이를 켜고 끔
    else if (enabled[c.id] !== want && chPending[c.id] === undefined) setChannel(c.id, want)
  })
}

function tick() {
  t++
  advanceScenario()
  const now = Date.now()
  // 실측: 최근 3.5초 안에 받은 프레임이 없으면 데이터 없음 (정전으로 판정하지 않음)
  const stale = source === 'SERIAL' && (!latest || now - latest.at > 3500) // 스케치 v3.1 녹화(뒤 2.0초) 중 쉬는 시간 포함
  if (!connected || stale) return emit({ status: 'NO_DATA' })

  const m = source === 'SERIAL' ? latest!.frame : mockMeasure()
  const { v, i } = m
  const scope: MeasurementScope = source === 'MOCK' ? 'BOTH' : measurementScope
  if (source === 'SERIAL' && scope === 'UNKNOWN' && !m.zones) {
    return emit({ v, i, p: v * i, expected: 0, score: 0, status: 'NO_DATA', estLit: 0, zones: null, diagnosis: null, lastPacketAt: latest!.at, packets: snap.packets + 1 })
  }
  const eh = expectedZone('HOUSE')
  const el = expectedZone('LAMP')
  let expected = scope === 'HOUSE' ? eh : scope === 'LAMP' ? el : eh + el
  let score = anomalyScore(v, i, expected)
  // 전체 범위(BOTH) 단일 센서 장치만 기존 5채널 학습 조합표를 쓴다. 단일 분기값에 이 표를 적용하지 않는다.
  let diagnosis: ComboDiagnosis | null = null
  let comboLit: number | null = null
  if (!m.zones && scope === 'BOTH' && relay) {
    const key = commandKey()
    const j = comboJudge(key, i)
    if (j) {
      expected = j.expected
      score = j.score
      diagnosis = j.diag
      comboLit = key.split('').filter((c) => c === '1').length - (j.diag?.kind === 'LOW' && j.diag.candidates.length ? 1 : 0)
    }
  }
  let zones: VillageSnapshot['zones'] = null
  if (m.zones || (source === 'SERIAL' && (scope === 'HOUSE' || scope === 'LAMP'))) {
    // 구간마다 따로 점수를 내서, 한 구간의 누설과 다른 구간의 단선이 합계에서 서로 가려지지 않게 함
    const zoneState = (kind: ChannelKind, r: { v: number; i: number }, exp: number): ZoneState => ({
      ...r,
      expected: exp,
      score: anomalyScore(r.v, r.i, exp),
      estLit: Math.max(0, Math.min(zoneChannels(kind).length, Math.round(r.i / ledA()))),
    })
    zones = m.zones
      ? { HOUSE: zoneState('HOUSE', m.zones.house, eh), LAMP: zoneState('LAMP', m.zones.lamp, el) }
      : scope === 'HOUSE'
        ? { HOUSE: zoneState('HOUSE', { v, i }, eh) }
        : { LAMP: zoneState('LAMP', { v, i }, el) }
    score = Math.max(score, ...Object.values(zones).map((z) => z!.score))
  }
  const status = classify(v, i, score, relay)
  const estLit = zones
    ? (zones.HOUSE?.estLit ?? 0) + (zones.LAMP?.estLit ?? 0)
    : comboLit ?? Math.max(0, Math.min(IOT_CHANNELS.length, Math.round(i / ledA())))
  const point: IotPoint = { t: now, v, i, expected, score, scope, ...((m.zones || scope === 'HOUSE') && { ih: m.zones?.house.i ?? i, eh }), ...((m.zones || scope === 'LAMP') && { il: m.zones?.lamp.i ?? i, el }) }

  const events = [...snap.events]
  const open = events.findIndex((e) => e.clearedAt === null)
  if (isAbnormal(status) && open < 0) {
    events.unshift({
      id: ++eventSeq,
      source,
      at: new Date(now).toISOString(),
      injected: source === 'MOCK' ? (supplyFault ?? Object.values(faults)[0] ?? null) : null,
      injectedAt: lastInjectedAt,
      status,
      maxScore: score,
      relayOn: relay,
      expected,
      window: snap.history.slice(-20).map(({ p: _p, ...h }) => h).concat(point),
      clearedAt: null,
      caseId: null,
    })
  } else if (open >= 0) {
    const e = events[open]
    events[open] = {
      ...e,
      status: isAbnormal(status) && RANK[status] > RANK[e.status] ? status : e.status,
      maxScore: Math.max(e.maxScore, score),
      window: [...e.window, point].slice(-80),
      clearedAt: isAbnormal(status) ? null : new Date(now).toISOString(),
    }
  }

  emit({
    v,
    i,
    p: v * i,
    expected,
    score,
    status,
    estLit,
    zones,
    diagnosis,
    lastPacketAt: source === 'SERIAL' ? latest!.at : now,
    packets: snap.packets + 1,
    history: [...snap.history, { ...point, p: v * i }].slice(-HISTORY),
    events: events.slice(0, 40),
  })
}

function subscribe(l: () => void) {
  listeners.add(l)
  if (!timer) {
    tick()
    timer = setInterval(tick, TICK_MS)
  }
  return () => {
    listeners.delete(l)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** 화면 밖(채널 점검 등)에서 현재 상태를 읽을 때 */
export function getVillage(): VillageSnapshot {
  return snap
}

export function useVillage(): VillageSnapshot {
  return useSyncExternalStore(subscribe, () => snap)
}

function fail(message: string) {
  lastError = message
  emit()
}

/** 정전 직전의 채널 상태. 복구할 때 이대로 되돌린다 */
let blackoutSaved: Record<ChannelId, boolean> | null = null

/**
 * 웹 → 장치 릴레이 명령 (마을 전체 전원). 장치가 보고한 상태로 확인될 때까지 '전송 중'.
 * 실측 장치는 전체 릴레이(D2)가 LED 전원 경로에 없어도 정전이 되도록, 채널 릴레이 5개도 함께 끄고(복구 때 원래 상태로 켠다).
 */
export function setRelay(on: boolean) {
  if (!connected) return
  relayPending = on
  lastError = null
  clearTimeout(commandTimer)
  emit()
  if (source === 'SERIAL') {
    const write = (line: string) => link?.write(line).catch((e: Error) => fail(`명령 전송 실패: ${e.message}`))
    write(`RELAY ${on ? 1 : 0}`)
    if (canControlChannels()) {
      if (!on) {
        // 정전: 지금 켜진 채널을 기억해 두고 모두 끈다
        if (!blackoutSaved) blackoutSaved = { ...enabled }
        IOT_CHANNELS.forEach((c) => write(`CH ${c.ch} 0`))
      } else if (blackoutSaved) {
        // 복구: 정전 직전에 켜져 있던 채널만 다시 켠다
        const saved = blackoutSaved
        blackoutSaved = null
        IOT_CHANNELS.forEach((c) => saved[c.id] && write(`CH ${c.ch} 1`))
      }
    }
    commandTimer = setTimeout(() => {
      if (relayPending === null) return
      relayPending = null
      fail('릴레이 명령에 장치가 응답하지 않았습니다.')
    }, 4500) // 스케치 v3.1 은 명령 뒤 2.0초 녹화하는 동안 측정 줄을 쉰다
    return
  }
  commandTimer = setTimeout(() => {
    relay = on
    relayPending = null
    emit()
  }, COMMAND_LATENCY_MS)
}

/** 웹 → 장치 채널 명령 (LED 하나 끄기·켜기). 장치가 보고한 채널 상태로 확인될 때까지 '전송 중'. */
export function setChannel(id: ChannelId, on: boolean) {
  if (!connected || !canControlChannels()) return
  const def = IOT_CHANNELS.find((c) => c.id === id)!
  chPending[id] = on
  lastError = null
  clearTimeout(chTimers[id])
  emit()
  if (source === 'SERIAL') {
    link?.write(`CH ${def.ch} ${on ? 1 : 0}`).catch((e: Error) => fail(`명령 전송 실패: ${e.message}`))
    chTimers[id] = setTimeout(() => {
      if (chPending[id] === undefined) return
      delete chPending[id]
      fail(`${def.name}(채널 ${def.ch}) 명령에 장치가 응답하지 않았습니다.`)
    }, 4500) // 스케치 v3.1 은 명령 뒤 2.0초 녹화하는 동안 측정 줄을 쉰다
    return
  }
  chTimers[id] = setTimeout(() => {
    enabled[id] = on
    delete chPending[id]
    emit()
  }, COMMAND_LATENCY_MS)
}

function onSerialLine(line: string) {
  rawLines++
  lastLine = line.slice(0, 200)
  // 스케치가 시작 상황을 알리는 안내 줄 (측정값이 아니므로 형식 오류로 세지 않음)
  if (line.startsWith('#')) {
    lastNote = line.slice(1, 160)
    const sensors = line.match(/INA219 house\(0x40\)=(OK|NOT FOUND) lamp\(0x41\)=(OK|NOT FOUND)/)
    if (sensors) {
      const houseOk = sensors[1] === 'OK'
      const lampOk = sensors[2] === 'OK'
      measurementScope = houseOk && lampOk ? 'BOTH' : houseOk ? 'HOUSE' : lampOk ? 'LAMP' : 'UNKNOWN'
    }
    // Older UNO firmware says a single INA219 is the village total. Correct that diagnostic text
    // from the address discovery above so the UI never repeats the incorrect scope claim.
    if (/sensor 1개만 감지.*마을 전체 값/i.test(lastNote)) {
      lastNote = measurementScope === 'HOUSE'
        ? '구형 펌웨어 안내 보정: 주택 0x40 실측만 사용 · 가로등 전류 미측정'
        : measurementScope === 'LAMP'
          ? '구형 펌웨어 안내 보정: 가로등 0x41 실측만 사용 · 주택 전류 미측정'
          : lastNote
    }
    emit()
    return
  }
  // 스케치 v3.1 의 사건 파형 (사건이 날 때만 옴): 원인 분석으로 넘긴다
  if (line.startsWith('{"ev"')) {
    const ev = parseEventLine(line)
    if (ev) {
      pushVillageEvent({ ...ev, sensorScope: measurementScope })
      // 녹화 중(뒤 2.0초)에는 측정 줄이 쉬므로, 사건 줄의 채널 상태로 명령 확인을 대신한다
      if (ev.ch.length === 5) {
        IOT_CHANNELS.forEach((c) => {
          enabled[c.id] = ev.ch[c.ch - 1] === 1
          if (chPending[c.id] === enabled[c.id]) {
            delete chPending[c.id]
            clearTimeout(chTimers[c.id])
          }
        })
      }
    } else badFrames++
    emit()
    return
  }
  const frame = parseFrame(line)
  if (!frame) {
    badFrames++
    emit()
    return
  }
  latest = { at: Date.now(), frame }
  relay = frame.relay
  if (relayPending === relay) {
    relayPending = null
    clearTimeout(commandTimer)
  }
  if (frame.ch) {
    IOT_CHANNELS.forEach((c) => {
      enabled[c.id] = frame.ch![c.ch - 1]
      if (chPending[c.id] === enabled[c.id]) {
        delete chPending[c.id]
        clearTimeout(chTimers[c.id])
      }
    })
  }
}

/** 포트가 열린 뒤 상태를 실측 모드로 맞춘다 */
async function attach(next: SerialLink) {
  await link?.close()
  link = next
  source = 'SERIAL'
  connected = true
  latest = null
  badFrames = 0
  rawLines = 0
  lastLine = null
  lastNote = null
  measurementScope = 'UNKNOWN'
  lastError = null
  scenario = null
  IOT_CHANNELS.forEach((c) => (enabled[c.id] = true))
  clearFault()
  emit({ history: [] })
}

/** 장치가 사라졌을 때(USB 분리·재시작 등) */
function onLost(reason: string) {
  link = null
  connected = false
  fail(autoPref() ? `${reason} 자동으로 다시 연결합니다.` : reason)
  scheduleRetry()
}

/** 실제 모형 연결 (브라우저가 포트 선택 창을 띄움). 성공하면 다음부터 자동으로 다시 연결 */
export async function connectSerial() {
  // 이미 연결돼 있으면 다시 열지 않는다 (같은 포트를 두 번 열면 'Port is already open'으로 끊김)
  if (link && connected && source === 'SERIAL') return
  // 자동 재연결이 열고 있는 중이면 끝나기를 기다린 뒤, 그래도 안 열렸을 때만 직접 연다
  const waitStart = Date.now()
  while (trying && Date.now() - waitStart < 4000) await new Promise((r) => setTimeout(r, 100))
  if (link && connected && source === 'SERIAL') return
  trying = true
  try {
    const next = await openSerial(onSerialLine, onLost, 'ask')
    setAutoPref(true)
    setSimPref(false)
    await attach(next)
    stopRetry()
  } finally {
    trying = false
  }
}

// ── 자동 재연결: 이전에 허용한 포트를 허용 창 없이 다시 연다 ──
let retryTimer: ReturnType<typeof setInterval> | null = null
let trying = false
let noGrant = false

async function tryAutoConnect() {
  if (trying || link || !autoPref() || (typeof document !== 'undefined' && document.hidden)) return
  trying = true
  try {
    await attach(await openSerial(onSerialLine, onLost, 'granted'))
    noGrant = false
    stopRetry()
  } catch (e) {
    const msg = (e as Error).message
    // 허용된 포트가 아직 없으면(다른 브라우저로 처음 연 경우 등) 조용히 기다린다
    if (msg === NO_GRANTED_PORT) {
      if (!noGrant) {
        noGrant = true
        emit()
      }
    } else {
      const text = /busy|in use|Failed to open|already/i.test(msg) ? '포트를 다른 프로그램(시리얼 모니터 등)이 쓰고 있습니다. 닫으면 자동으로 연결됩니다.' : `다시 연결하지 못했습니다: ${msg}`
      if (lastError !== text) {
        lastError = text
        emit()
      }
    }
  } finally {
    trying = false
  }
}

function scheduleRetry() {
  if (retryTimer || !autoPref()) return
  retryTimer = setInterval(() => void tryAutoConnect(), 3000)
}
function stopRetry() {
  if (retryTimer) clearInterval(retryTimer)
  retryTimer = null
}

/** 시뮬레이터로 전환 (자동 재연결도 끔) */
export async function switchToMock() {
  setAutoPref(false)
  setSimPref(true)
  stopRetry()
  await link?.close()
  link = null
  source = 'MOCK'
  connected = true
  lastError = null
  IOT_CHANNELS.forEach((c) => {
    enabled[c.id] = true
    delete chPending[c.id]
    clearTimeout(chTimers[c.id])
  })
  emit({ history: [] })
}

if (typeof window !== 'undefined' && autoPref()) {
  // 앱을 열자마자 한 번 시도하고, 안 되면 3초마다. USB가 꽂히면 바로 다시 시도한다
  void tryAutoConnect()
  scheduleRetry()
  onSerialPlug(() => void tryAutoConnect())
}

/** 고장 주입 (Mock 전용). LED 위치 고장은 id, 전원 고장은 id 무시 */
export function injectFault(id: ChannelId, kind: FaultKind) {
  if (source !== 'MOCK') return
  if (FAULT_AT_LED[kind]) faults[id] = kind
  else supplyFault = kind
  lastInjectedAt = new Date().toISOString()
  emit()
}

/** 시연용 순간 과전류(돌입전류 흉내): 잠깐 전류가 튀었다가 저절로 돌아옴. 고장표시가 떠도 실제 고장은 아님 */
export function injectTransient(id: ChannelId, ms = 1500) {
  if (source !== 'MOCK') return
  faults[id] = 'GROUND'
  lastInjectedAt = new Date().toISOString()
  emit()
  setTimeout(() => { if (faults[id] === 'GROUND') { delete faults[id]; emit() } }, ms)
}

export function clearFault(id?: ChannelId) {
  if (id) delete faults[id]
  else {
    for (const k of Object.keys(faults)) delete faults[k as ChannelId]
    supplyFault = null
  }
  emit()
}

export function clearSupplyFault() {
  supplyFault = null
  emit()
}

/** 시뮬레이터 연결 끊김 재현 (Mock 전용) */
export function setConnected(on: boolean) {
  if (source !== 'MOCK') return
  connected = on
  emit()
}

/** 공공데이터 시간대 패턴으로 켜진 부하 수를 바꿔 재생. 실측 장치는 실제 채널 릴레이를 켜고 끔 */
export function startScenario(label: string, profile: number[]) {
  if (!canControlChannels()) return
  // 전원이 끊긴 채로는 켜지는 LED 수가 장면에 보이지 않으므로 재생과 함께 전력 복구
  if (source === 'MOCK') {
    clearTimeout(commandTimer)
    relay = true
    relayPending = null
    connected = true
  } else if (!relay) setRelay(true)
  scenario = { label, profile, hour: -1 }
  t = 3 // 다음 tick에서 바로 0시 적용
  emit()
}

export function stopScenario() {
  const was = scenario !== null
  scenario = null
  if (source === 'MOCK') IOT_CHANNELS.forEach((c) => (enabled[c.id] = true))
  else if (was) IOT_CHANNELS.forEach((c) => !enabled[c.id] && setChannel(c.id, true))
  emit()
}

export function linkEventToCase(eventId: number, caseId: string) {
  snap = { ...snap, events: snap.events.map((e) => (e.id === eventId ? { ...e, caseId } : e)) }
  listeners.forEach((l) => l())
}

/** 3D·목록에서 LED 하나를 어떻게 보여줄지 (상태 색 + 짧은 설명) */
export function lightView(led: LedState, snap: VillageSnapshot): { status: NodeStatus; text: string } {
  if (snap.status === 'NO_DATA') return { status: 'NO_DATA', text: '데이터 없음' }
  if (led.fault) return { status: led.fault === 'OPEN' ? 'WARNING' : 'FAULT', text: FAULT_LABEL[led.fault] }
  if (!snap.relay) return led.lit ? { status: 'FAULT', text: '차단했는데 켜짐' } : { status: 'OFF', text: '차단됨' }
  if (snap.status === 'OUTAGE') return { status: 'OUTAGE', text: '정전' }
  if (!led.channelOn) return { status: 'OFF', text: snap.scenario ? '꺼짐 · 시나리오' : '꺼짐 · 채널 OFF' }
  if (!led.lit) return { status: 'OFF', text: snap.scenario ? '꺼짐 · 시나리오' : snap.source === 'SERIAL' ? '꺼짐 (추정)' : '꺼짐' }
  // 전체 전류 이상(LED 하나가 끊긴 경우 등)이 멀쩡한 LED의 색까지 바꾸면 고장 난 곳을 구분할 수 없으므로, 전원 쪽 고장일 때만 전체 색을 따른다
  const status = snap.supplyFault && (snap.status === 'WARNING' || snap.status === 'FAULT') ? snap.status : 'NORMAL'
  return { status, text: snap.source === 'SERIAL' ? '켜짐 (추정)' : '켜짐' }
}

/** 집·가로등이 상황에 따라 하는 말. 정전이나 고장일 때만 나옴 */
const HOUSE_LINES = {
  outage: ['큰일났다! 정전이야! 😱', '불이 다 꺼졌어요! 😰', '냉장고 어떡해… 😭'],
  noPower: ['전기가 안 들어와요! 😱', '갑자기 캄캄해졌어요 😨', '누가 전기 좀 살려줘요 🆘'],
  open: ['우리 집 불만 나갔어요! 😭', '내 전구가 끊어졌어요 💡'],
  ground: ['찌릿! 전기가 이상해요 ⚡', '무서워요, 전기가 새는 것 같아요 😨'],
  sag: ['불빛이 어두워졌어요 😟', '전기가 약해졌어요… 🥺'],
  stuck: ['정전이라더니 불이 켜져 있네? 🤔', '차단됐다는데 왜 켜져 있죠? 😮'],
  sleep: ['쿨쿨… 자는 중 😴', '불 끄고 자요 🌙'],
}
const LAMP_LINES = {
  outage: ['캄캄해요… 🌑', '가로등도 꺼졌어요 😢'],
  open: ['내 전구가 나갔어요 💡'],
  ground: ['깜빡깜빡… ⚡'],
  sag: ['어두워졌어요 😟'],
}

export function speech(led: LedState, snap: VillageSnapshot): string | null {
  if (snap.status === 'NO_DATA') return null
  const house = led.kind === 'HOUSE'
  const pick = (arr: string[]) => arr[led.ch % arr.length]
  const L = (house ? HOUSE_LINES : LAMP_LINES) as Record<string, string[] | undefined>
  if (led.fault === 'OPEN') return pick(L.open ?? [])
  if (led.fault === 'GROUND') return pick(L.ground ?? [])
  if (snap.supplyFault === 'STUCK' && !snap.relay) return house ? pick(HOUSE_LINES.stuck) : null
  if (!snap.relay) return pick(L.outage ?? [])
  if (snap.supplyFault === 'OUTAGE') return house ? pick(HOUSE_LINES.noPower) : pick(LAMP_LINES.outage)
  if (snap.supplyFault === 'SAG') return pick(L.sag ?? [])
  // 공공데이터 시나리오나 채널로 끈 집은 잠든 것으로 표현
  if (house && !led.channelOn) return pick(HOUSE_LINES.sleep)
  return null
}
