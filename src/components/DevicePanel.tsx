import { useState } from 'react'
import { serialSupported } from '../lib/serial'
import { connectSerial, DEVICE_INFO, setConnected, switchToMock, TICK_MS, type VillageSnapshot } from '../lib/village'
import { Status } from './ui'

/** 데이터 출처(시뮬레이터 / 실측) 선택과 장치 연결 상태 */
export default function DevicePanel({ snap }: { snap: VillageSnapshot }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = serialSupported()
  const info = DEVICE_INFO[snap.source]

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      await connectSerial()
    } catch (e) {
      const msg = (e as Error).message
      // 포트 선택 창에서 취소한 경우는 오류로 보지 않음
      if (!/No port selected|cancel/i.test(msg)) setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="source-switch" role="radiogroup" aria-label="데이터 출처">
        <button role="radio" aria-checked={snap.source === 'MOCK'} className={`source-opt ${snap.source === 'MOCK' ? 'on' : ''}`} onClick={() => switchToMock()}>
          <strong>시뮬레이터</strong>
          <span>브라우저에서 계측값을 만들고 고장을 주입합니다</span>
        </button>
        <button role="radio" aria-checked={snap.source === 'SERIAL'} className={`source-opt ${snap.source === 'SERIAL' ? 'on' : ''}`} onClick={connect} disabled={!supported || busy}>
          <strong>{busy ? '포트 선택 중…' : snap.source === 'SERIAL' ? '실측 장치 (다른 포트 선택)' : '실측 장치'}</strong>
          <span>{supported ? 'Arduino를 USB로 연결하고 시리얼 포트를 고릅니다' : '이 브라우저는 Web Serial을 지원하지 않습니다 · Chrome 또는 Edge'}</span>
        </button>
      </div>

      {snap.reconnecting && <div className="alert alert-info"><span>실측 장치를 다시 찾는 중입니다. USB를 꽂으면 자동으로 연결됩니다.</span></div>}
      {(error || snap.lastError) && <div className="alert alert-err">{error ?? snap.lastError}</div>}

      <dl className="dl-rows" style={{ marginTop: 20 }}>
        <div>
          <dt>연결</dt>
          <dd className="row between">
            <Status tone={snap.connected ? 'ok' : 'err'} live={snap.connected}>{snap.connected ? '수신 중' : '끊김'}</Status>
            {snap.source === 'MOCK' && (
              <button className="btn btn-sm btn-ghost" onClick={() => setConnected(!snap.connected)}>
                {snap.connected ? '끊김 재현' : '다시 연결'}
              </button>
            )}
          </dd>
        </div>
        <div><dt>장치</dt><dd className="mono">{info.deviceId}</dd></div>
        <div><dt>센서</dt><dd>{snap.source === 'SERIAL' ? snap.measurementScope === 'BOTH' ? 'INA219 ×2 (주택·가로등 분기 실측)' : snap.measurementScope === 'HOUSE' ? 'INA219 0x40 (주택 분기 실측 · 가로등 미측정)' : snap.measurementScope === 'LAMP' ? 'INA219 0x41 (가로등 분기 실측 · 주택 미측정)' : 'INA219 범위 확인 중' : info.sensor}</dd></div>
        <div><dt>포트</dt><dd className="mono">{info.port}</dd></div>
        <div><dt>수신</dt><dd className="num">{snap.packets.toLocaleString()}회 · {1000 / TICK_MS} Hz{snap.source === 'SERIAL' && ` · 형식 오류 ${snap.badFrames}줄`}</dd></div>
      </dl>

      {snap.source === 'SERIAL' && (
        <div className="serial-diag">
          <div className="small muted" style={{ marginBottom: 6 }}>연결 진단 · 장치에서 받은 줄 {snap.rawLines.toLocaleString()}개 (형식 오류 {snap.badFrames}개)</div>
          {snap.lastNote && <div className="small" style={{ marginBottom: 6 }}>장치 안내: <span className="mono">{snap.lastNote}</span></div>}
          {snap.lastLine ? (
            <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{snap.lastLine}</pre>
          ) : (
            <p className="small" style={{ margin: 0 }}>아직 아무 줄도 받지 못했습니다. 장치가 켜질 때 '#GridWitness…' 안내 줄을 보내는 새 스케치가 올라가 있는지, 포트가 맞는지, 속도가 115200인지, 다른 프로그램(Arduino IDE 시리얼 모니터)이 포트를 쓰고 있지 않은지 확인하세요. USB를 꽂으면 Arduino가 다시 시작하므로 연결 직후 2~3초는 비어 있을 수 있습니다.</p>
          )}
          {snap.rawLines > 0 && snap.badFrames === snap.rawLines && <p className="small text-bad" style={{ margin: '8px 0 0' }}>받은 줄이 모두 형식 오류입니다. 위 줄이 {'{"v":…,"i":…,"relay":…}'} 모양인지 확인하세요 (다른 스케치가 올라가 있거나 속도가 다를 수 있습니다).</p>}
        </div>
      )}

      <details className="protocol">
        <summary>시리얼 프로토콜</summary>
        <pre>{`115200 baud, 줄 단위

장치 → 웹  0.5초마다 (전체 전압·전류, 채널 상태)
{"v":5.02,"i":0.033,"relay":1,"ch":[1,1,1,1,1]}
센서 2개일 때만 vh/ih/vl/il 구간 값 추가
사건 파형: dt=10ms, pre=60, 전류 260점

웹 → 장치  (D2 릴레이)
RELAY 0    → 정전 발생 (마을 전체 차단)
RELAY 1    → 전력 복구
CH 3 0     → 채널 3 끄기 (D5, 주택 2)
CH 3 1     → 채널 3 켜기`}</pre>
        <p className="small muted">Arduino 예제: <code>arduino/gridwitness_village/gridwitness_village.ino</code></p>
      </details>
    </div>
  )
}
