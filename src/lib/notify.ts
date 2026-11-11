// 실시간 사건 알림: 짧은 경고음 + (다른 탭을 보고 있을 때) 브라우저 알림.
// 브라우저는 사용자가 한 번 눌러 허락해야 소리·알림을 낼 수 있어서, 상단 바의 종 버튼으로 켠다.

import { useSyncExternalStore } from 'react'

const KEY = 'gridwitness.alerts.v1'
let on = (() => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
})()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
export const useAlertsOn = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => on)

let ctx: AudioContext | null = null
function beep() {
  try {
    ctx ??= new AudioContext()
    const t = ctx.currentTime
    for (const [k, f] of [[0, 880], [0.18, 660]] as const) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + k)
      g.gain.exponentialRampToValueAtTime(0.25, t + k + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + k + 0.16)
      o.connect(g).connect(ctx.destination)
      o.start(t + k)
      o.stop(t + k + 0.17)
    }
  } catch {
    // 소리를 낼 수 없는 환경
  }
}

/** 종 버튼: 켜면 알림 권한을 묻고 확인음을 한 번 낸다 (이 클릭으로 소리 재생이 허락됨) */
export async function toggleAlerts() {
  on = !on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // 저장 못 해도 이번 접속에서는 동작
  }
  emit()
  if (!on) return
  beep()
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      // 거절해도 소리 알림은 남음
    }
  }
}

/** 새 실시간 사건이 생기면 부른다 */
export function alertIncident(title: string) {
  if (!on) return
  beep()
  if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('GridWitness · 이상 감지', { body: title, tag: 'gw-incident' })
    } catch {
      // 알림을 띄울 수 없는 환경
    }
  }
}
