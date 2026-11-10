import type { VillageSnapshot } from './village'

type Live = 'ok' | 'warn' | 'down'
type HardwareSnapshot = Pick<VillageSnapshot, 'connected' | 'source' | 'zones' | 'lastNote'>

export interface UnoStatus {
  state: Live
  text: string
  detail: string
}

/** Report serial and per-zone sensor availability separately; simulator data is never labeled measured. */
export function unoStatus(snap: HardwareSnapshot): UnoStatus {
  if (!snap.connected) {
    return { state: 'down', text: '장치 연결 끊김', detail: '현재 UNO 계측 중지' }
  }

  if (snap.source === 'MOCK') {
    return { state: 'warn', text: '시뮬레이터', detail: '시뮬레이션 값 · 실측이 아님' }
  }

  const sensors = snap.lastNote?.match(/INA219 house\(0x40\)=(OK|NOT FOUND) lamp\(0x41\)=(OK|NOT FOUND)/)
  if (sensors) {
    const houseOk = sensors[1] === 'OK'
    const lampOk = sensors[2] === 'OK'
    const house = `주택 0x40 ${houseOk ? '인식' : '미응답'}`
    const lamp = `가로등 0x41 ${lampOk ? '인식' : '미응답'}`

    if (houseOk && lampOk && snap.zones) {
      return { state: 'ok', text: '두 구간 실측 수신', detail: `${house} · ${lamp} · 분기별 값 수신 중` }
    }
    if (houseOk && lampOk) {
      return { state: 'warn', text: '구간 계측 프레임 대기', detail: `${house} · ${lamp} · 구간별 측정값 없음` }
    }
    return { state: 'warn', text: `${house} · ${lamp}`, detail: '구간별 측정값 없음 · 센서 배선과 주소를 확인하세요' }
  }

  if (snap.zones) {
    return { state: 'ok', text: '두 구간 실측 수신', detail: '주택·가로등 분기별 값 수신 중' }
  }
  return { state: 'warn', text: 'UNO 연결 · 구간 센서 미확인', detail: '현재 구간별 측정값 없음' }
}
