import { useSyncExternalStore } from 'react'
import { expectedDrop, getVillage, IOT_CHANNELS, ledA, setChannel, type ChannelDef, type ChannelId } from './village'

// 채널 점검: 켜져 있는 채널을 하나씩 잠깐 꺼서 그 구간 전류가 얼마나 줄어드는지 본다.
//   LED 1개 분량(기준 전류)쯤 줄면 정상 · 거의 안 줄면 단선·접촉 불량 · 훨씬 많이 줄면 누설·단락.
// INA219가 구간(주택/가로등)마다 하나라 평소에는 구간까지만 알 수 있는데, 이렇게 하면 LED 하나까지 짚을 수 있다.

export type CheckVerdict = 'OK' | 'NO_CURRENT' | 'OVER' | 'SKIPPED' | 'UNMEASURED' | 'ERROR'

export const VERDICT_TEXT: Record<CheckVerdict, string> = {
  OK: '정상',
  NO_CURRENT: '전류 없음 (단선·접촉 불량 의심)',
  OVER: '과전류 (누설·단락 의심)',
  SKIPPED: '꺼져 있어 건너뜀',
  UNMEASURED: '전류 미측정 · 릴레이만 제어',
  ERROR: '측정 실패',
}

export interface CheckResult {
  id: ChannelId
  /** 끄기 전·끈 뒤 구간 전류 (A) */
  before: number | null
  after: number | null
  /** 끄면서 줄어든 전류 (A) */
  drop: number | null
  verdict: CheckVerdict
  note?: string
}

interface CheckState {
  running: boolean
  current: ChannelId | null
  results: CheckResult[]
  error: string | null
  finishedAt: number | null
}

let state: CheckState = { running: false, current: null, results: [], error: null, finishedAt: null }
const listeners = new Set<() => void>()
const set = (next: Partial<CheckState>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export function useChannelCheck(): CheckState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeout: number): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(100)
  }
  return cond()
}

/** 실제 센서가 측정한 구간의 최근 전류 평균. 다른 구간/전체값으로 대체하지 않음. */
async function zoneCurrent(c: ChannelDef, samples = 4): Promise<number> {
  const since = Date.now()
  await waitFor(() => getVillage().history.filter((h) => h.t > since).length >= samples, 4000)
  const pts = getVillage().history.filter((h) => h.t > since).slice(-samples)
  const values = pts.map((h) => c.kind === 'HOUSE' ? h.ih : h.il).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  if (values.length < samples) throw new Error(`${c.kind === 'HOUSE' ? '주택' : '가로등'} 구간 실측 표본이 없어 채널 전류를 비교할 수 없습니다.`)
  return values.reduce((s, x) => s + x, 0) / values.length
}

/** 줄어든 전류를 '지금 조합에서 이 채널을 끄면 줄어야 할 양'(실측 조합표)과 비교.
 *  USB 전원은 많이 켤수록 전압이 내려가 한 채널 몫이 작아진다 (실측: 1개 켤 때 11 mA, 5개 중 하나 끌 때 2~4 mA) */
function judge(drop: number, expected: number | null): CheckVerdict {
  const e = expected ?? ledA()
  if (drop < e * 0.5) return 'NO_CURRENT'
  if (drop > e * 2 + 0.003) return 'OVER'
  return 'OK'
}

let cancelled = false
export function cancelChannelCheck() {
  cancelled = true
}

/** 채널 점검 실행. 켜져 있던 채널은 점검 뒤 다시 켠다 */
export async function runChannelCheck() {
  if (state.running) return
  const snap = getVillage()
  if (!snap.canControl) return set({ error: '이 장치는 채널을 조종할 수 없습니다 (채널 상태를 보고하지 않는 예전 스케치).' })
  if (!snap.relay || snap.status === 'NO_DATA') return set({ error: '마을 전원이 들어와 있고 계측이 수신될 때만 점검할 수 있습니다.' })
  cancelled = false
  set({ running: true, current: null, results: [], error: null, finishedAt: null })
  const results: CheckResult[] = []
  try {
    for (const c of IOT_CHANNELS) {
      if (cancelled) break
      if (getVillage().source === 'SERIAL' && getVillage().measurementScope === 'HOUSE' && c.kind === 'LAMP') {
        results.push({ id: c.id, before: null, after: null, drop: null, verdict: 'UNMEASURED', note: '가로등은 릴레이 상태만 표시하며 전류를 측정하지 않습니다.' })
        set({ results: [...results] })
        continue
      }
      if (!getVillage().channels[c.id]) {
        results.push({ id: c.id, before: null, after: null, drop: null, verdict: 'SKIPPED' })
        set({ results: [...results] })
        continue
      }
      set({ current: c.id })
      const exp = expectedDrop(c.id)
      const before = await zoneCurrent(c)
      setChannel(c.id, false)
      const off = await waitFor(() => !getVillage().channels[c.id] && getVillage().channelPending[c.id] === undefined, 3000)
      if (!off) {
        results.push({ id: c.id, before, after: null, drop: null, verdict: 'ERROR', note: '채널을 끄라는 명령이 확인되지 않았습니다.' })
        setChannel(c.id, true)
        set({ results: [...results] })
        continue
      }
      await sleep(600) // 릴레이 접점·전류가 안정될 때까지
      const after = await zoneCurrent(c)
      setChannel(c.id, true)
      await waitFor(() => getVillage().channels[c.id] && getVillage().channelPending[c.id] === undefined, 3000)
      const drop = before - after
      const reference = getVillage().source === 'SERIAL' && getVillage().measurementScope === 'HOUSE' ? '주택 LED 기준 전류' : '실측 조합표'
      results.push({ id: c.id, before, after, drop, verdict: judge(drop, exp), note: exp != null ? `예상 감소 ${(exp * 1000).toFixed(0)} mA (${reference})` : undefined })
      set({ results: [...results] })
      await sleep(400)
    }
  } catch (e) {
    set({ error: (e as Error).message })
  } finally {
    // 중간에 멈춰도 점검하느라 끈 채널은 다시 켬
    for (const r of results) if (r.verdict !== 'SKIPPED' && !getVillage().channels[r.id]) setChannel(r.id, true)
    if (state.current && !getVillage().channels[state.current] && !results.some((r) => r.id === state.current)) setChannel(state.current, true)
    set({ running: false, current: null, finishedAt: Date.now(), error: cancelled ? '점검을 중간에 멈췄습니다.' : state.error })
  }
}
