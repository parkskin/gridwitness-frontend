import { useSyncExternalStore } from 'react'
import { COMBO, currentCommandKey, getVillage, IOT_CHANNELS, setChannel, setComboCalibration, type ChannelId } from './village'

// 기준 다시 맞추기: 32가지 채널 조합을 차례로 만들고 정상 전류를 재서, 이 PC의 조합별 기준으로 저장한다.
// 시연 전 준비용 (모형의 집·가로등을 잠깐씩 끄고 켠다). 고장이 있는 상태에서 하면 고장을 정상으로 배우므로 LED가 다 정상일 때만 한다.

interface CalState {
  running: boolean
  done: number
  total: number
  error: string | null
  finishedAt: number | null
}
let state: CalState = { running: false, done: 0, total: 32, error: null, finishedAt: null }
const listeners = new Set<() => void>()
const set = (next: Partial<CalState>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
export function useComboCalibrate(): CalState {
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
    await sleep(80)
  }
  return cond()
}
const idOf = (devCh: number): ChannelId => IOT_CHANNELS.find((c) => c.ch === devCh)!.id
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

let cancelled = false
export const cancelComboCalibrate = () => {
  cancelled = true
}

export async function runComboCalibrate(samples = 4) {
  if (state.running) return
  const snap = getVillage()
  if (snap.source === 'SERIAL' && snap.measurementScope !== 'BOTH') {
    set({ error: '5개 채널 조합표를 보정하려면 주택·가로등 INA219 두 센서가 모두 응답해야 합니다. 현재 센서 범위에서는 보정을 시작하지 않았습니다.' })
    return
  }
  if (snap.source !== 'SERIAL' || !snap.connected) return set({ error: '실측 장치(우노)가 연결돼 있을 때만 맞출 수 있습니다.' })
  if (!snap.canControl || !snap.relay) return set({ error: '마을 전원이 들어와 있고 채널을 조종할 수 있을 때만 맞출 수 있습니다.' })
  cancelled = false
  const original = { ...snap.channels }
  // 그레이 코드 순서: 한 번에 채널 하나만 바뀌어 릴레이를 덜 움직인다
  const keys = Array.from({ length: 32 }, (_, i) => (i ^ (i >> 1)).toString(2).padStart(5, '0'))
  set({ running: true, done: 0, total: keys.length, error: null, finishedAt: null })
  const mean_a: Record<string, number> = {}
  try {
    for (const key of keys) {
      if (cancelled) break
      for (let j = 0; j < 5; j++) {
        const id = idOf(j + 1)
        const want = key[j] === '1'
        if (getVillage().channels[id] !== want) setChannel(id, want)
      }
      const ok = await waitFor(() => currentCommandKey() === key && Object.keys(getVillage().channelPending).length === 0, 4000)
      if (!ok) throw new Error(`조합 ${key} 로 바꾸라는 명령이 확인되지 않았습니다.`)
      await sleep(900) // 릴레이·전원 안정
      const since = Date.now()
      await waitFor(() => getVillage().history.filter((h) => h.t > since).length >= samples, 5000)
      const xs = getVillage()
        .history.filter((h) => h.t > since)
        .slice(-samples)
        .map((h) => h.i)
      if (xs.length < 2) throw new Error('측정값이 들어오지 않습니다.')
      mean_a[key] = median(xs)
      set({ done: Object.keys(mean_a).length })
    }
    if (!cancelled && Object.keys(mean_a).length === keys.length) {
      const maxShiftA = Math.max(...keys.map((k) => Math.abs(mean_a[k] - (COMBO.mean_a[k] ?? mean_a[k]))))
      setComboCalibration({ at: new Date().toISOString(), mean_a, samplesPerCombo: samples, maxShiftA })
    }
  } catch (e) {
    set({ error: (e as Error).message })
  } finally {
    for (const c of IOT_CHANNELS) if (getVillage().channels[c.id] !== original[c.id]) setChannel(c.id, original[c.id])
    set({ running: false, finishedAt: Date.now(), error: cancelled ? '중간에 멈췄습니다 (기준은 바꾸지 않음).' : state.error })
  }
}
