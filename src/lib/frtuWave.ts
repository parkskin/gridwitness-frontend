// 마을 FRTU 계측(직류, 0.5초 간격)을 고장파형 분석 화면과 같은 틀로 보여 주기 위한 계산.
// 교류 3상 파형(Va~Ic)과 섞지 않고, 실제로 잰 값만 씀. 값이 없는 분기는 그리지 않음.
import type { IotPoint } from '../types'
import { THRESHOLDS } from './village'

export type FrtuWaveKey = 'inlet' | 'house' | 'lamp'

export const FRTU_WAVE_META: Record<FrtuWaveKey, { label: string; color: string }> = {
  inlet: { label: '인입', color: '#3157e0' },
  house: { label: '주택 분기', color: '#c8462f' },
  lamp: { label: '가로등 분기', color: '#24835a' },
}

export type FrtuWavePoint = Pick<IotPoint, 't' | 'i' | 'v'> & { ih?: number | null; il?: number | null }

export interface FrtuWaveSeries {
  key: FrtuWaveKey
  label: string
  color: string
  /** mA. 그 시점에 재지 않았으면 null */
  mA: (number | null)[]
}

export interface FrtuWave {
  /** 기록 시작부터 초 */
  t: number[]
  /** 평균 샘플 간격 (초) */
  dt: number
  series: FrtuWaveSeries[]
  v: number[]
}

export interface FrtuWaveFeatures {
  onset: { sample: number; seconds: number } | null
  recoverSeconds: number | null
  dominant: {
    key: FrtuWaveKey
    label: string
    peakBefore: number
    peakAfter: number
    peakPct: number
    before: number
    after: number
    rmsPct: number
  } | null
  patterns: string[]
}

export function buildFrtuWave(points: FrtuWavePoint[]): FrtuWave {
  const t0 = points[0]?.t ?? 0
  const t = points.map((p) => (p.t - t0) / 1000)
  const dt = t.length > 1 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 0
  const pick = (key: FrtuWaveKey, p: FrtuWavePoint) => {
    const a = key === 'inlet' ? p.i : key === 'house' ? p.ih : p.il
    return typeof a === 'number' && Number.isFinite(a) ? a * 1000 : null
  }
  const series = (Object.keys(FRTU_WAVE_META) as FrtuWaveKey[])
    .map((key) => ({ key, ...FRTU_WAVE_META[key], mA: points.map((p) => pick(key, p)) }))
    .filter((s) => s.mA.some((x) => x !== null))
  return { t, dt, series, v: points.map((p) => p.v) }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const rms = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)))
const peak = (xs: number[]) => (xs.length ? Math.max(...xs.map(Math.abs)) : 0)
const nums = (xs: (number | null)[], from: number, to: number) => xs.slice(from, to).filter((x): x is number => x !== null)
const pct = (a: number, b: number) => (Math.abs(a) < 1e-9 ? (Math.abs(b) < 1e-9 ? 0 : 1) : (b - a) / Math.abs(a))

/** 기록 초반을 기준으로 급변 시점·복귀 시점·가장 크게 변한 FRTU·특징 패턴을 계산 (AI 판단과 별개) */
export function analyzeFrtuWave(w: FrtuWave): FrtuWaveFeatures {
  const n = w.t.length
  const empty: FrtuWaveFeatures = { onset: null, recoverSeconds: null, dominant: null, patterns: [] }
  if (n < 6 || !w.series.length) return empty

  const baseLen = Math.max(3, Math.floor(n * 0.2))
  const base = w.series.map((s) => {
    const b = mean(nums(s.mA, 0, baseLen))
    // 계측 잡음(수 mA)은 급변으로 보지 않음: 기준의 25% 또는 5 mA 이상 벗어나야 함
    return { b, thr: Math.max(0.25 * Math.abs(b), 5) }
  })
  const deviates = (i: number) => w.series.some((s, k) => {
    const x = s.mA[i]
    return x !== null && Math.abs(x - base[k].b) > base[k].thr
  })

  let onset = -1
  // 3샘플(약 1.5초) 연속으로 벗어나야 사건 시작으로 봄
  for (let i = baseLen; i < n - 2; i++) {
    if (deviates(i) && deviates(i + 1) && deviates(i + 2)) { onset = i; break }
  }
  if (onset < 0) return empty

  let recover = -1
  for (let j = onset + 2; j < n - 1; j++) {
    if (!deviates(j) && !deviates(j + 1)) { recover = j; break }
  }
  const end = recover > 0 ? recover : n

  const changes = w.series.map((s) => {
    const pre = nums(s.mA, 0, onset)
    const post = nums(s.mA, onset, end)
    const before = rms(pre)
    const after = rms(post)
    return {
      key: s.key,
      label: s.label,
      before,
      after,
      rmsPct: pct(before, after),
      peakBefore: peak(pre),
      peakAfter: peak(post),
      peakPct: pct(peak(pre), peak(post)),
      moved: Math.abs(after - before) > Math.max(0.25 * before, 5),
    }
  })
  const dominant = [...changes].sort((a, b) => Math.abs(b.rmsPct) - Math.abs(a.rmsPct))[0]

  const patterns: string[] = []
  const onsetSec = w.t[onset]
  if (recover > 0) patterns.push(`급변 후 ${(w.t[recover] - onsetSec).toFixed(1)} s에 기록 초반 수준 복귀`)
  else patterns.push('기록 끝까지 초반 수준으로 돌아오지 않음 (지속)')
  if (dominant.before > 2 && dominant.after < dominant.before * 0.1) patterns.push(`${dominant.label} 전류가 0 가까이 떨어짐 · 차단·정전 양상`)
  else if (dominant.after > dominant.before * 1.3) patterns.push(`${dominant.label} 전류 증가 · 과전류 양상`)
  else if (dominant.after < dominant.before) patterns.push(`${dominant.label} 전류 감소 · 부하 일부 탈락 양상`)
  const house = changes.find((c) => c.key === 'house')
  const lamp = changes.find((c) => c.key === 'lamp')
  if (house && lamp) {
    if (house.moved && !lamp.moved) patterns.push('주택 분기만 변함 · 주택 쪽 구간 의심')
    else if (lamp.moved && !house.moved) patterns.push('가로등 분기만 변함 · 가로등 쪽 구간 의심')
    else if (house.moved && lamp.moved) patterns.push('두 분기가 함께 변함 · 인입 쪽 의심')
  }
  const vMin = Math.min(...w.v.slice(onset, end).filter(Number.isFinite))
  if (Number.isFinite(vMin) && vMin < THRESHOLDS.vMin) patterns.push(`전압 ${vMin.toFixed(2)} V · 기준 ${THRESHOLDS.vMin} V 아래`)
  patterns.push('기록 초반을 비교 기준으로 사용 · 기록 시작 전 이상 여부는 확인 못함')

  return {
    onset: { sample: onset, seconds: onsetSec },
    recoverSeconds: recover > 0 ? w.t[recover] : null,
    dominant,
    patterns,
  }
}
