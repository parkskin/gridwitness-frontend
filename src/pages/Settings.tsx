import { useState, type ReactNode } from 'react'
import { clearBackendCache } from '../api/backend'
import ChannelMap from '../components/ChannelMap'
import DevicePanel from '../components/DevicePanel'
import { PageHeader } from '../components/ui'
import { useActor } from '../lib/actor'
import { apiBase, assistantStatusLabel, checkCapabilities, checkHealth, DEFAULT_API, getApiToken, setApiBase, setApiToken, useBackendHealth, useCapabilities } from '../lib/backend'
import { AI_MODELS } from '../lib/models'
import { NOMINAL_V, useVillage } from '../lib/village'

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-row">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </section>
  )
}

export default function Settings() {
  const snap = useVillage()
  const [actor, setActor] = useActor()
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const health = useBackendHealth()
  const [url, setUrl] = useState(apiBase)
  const [token, setToken] = useState(getApiToken)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const capabilities = useCapabilities()

  function connect() {
    try {
      setApiBase(url)
      setToken(getApiToken())
      setConnectionError(null)
      void Promise.allSettled([checkHealth(), checkCapabilities()])
    } catch (error) { setConnectionError((error as Error).message) }
  }

  function reset() {
    clearBackendCache()
    setConfirming(false)
    setDone('이 브라우저에 보관한 사건 기록과 파형을 비웠습니다.')
  }

  return (
    <>
      <PageHeader title="설정" description="데이터 출처와 회로 구성, 분석 모델, 작업자 정보를 관리합니다." />

      <Row
        title="분석 서버"
        description="파일 등록·입력 진단·분석·검토 기록이 FastAPI 서버에 저장됩니다."
      >
        <div className="stack" style={{ gap: 14 }}>
          <label className="field" style={{ maxWidth: 480 }}>
            서버 주소
            <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          </label>
          <div className="cluster">
            <button className="btn btn-sm" onClick={connect} disabled={health.state === 'checking'}>{health.state === 'checking' ? '확인 중…' : '주소 적용·연결 확인'}</button>
            {health.state !== 'idle' && health.state !== 'checking' && (
              <span className="small" style={{ color: health.state === 'ok' ? 'var(--ok)' : 'var(--err)' }} role="status">{health.detail}</span>
            )}
            {url !== DEFAULT_API && <button className="btn btn-sm btn-ghost" onClick={() => setUrl(DEFAULT_API)}>기본 주소</button>}
          </div>
          {connectionError && <div className="alert alert-err" role="alert">{connectionError}</div>}
          <p className="hint">
            서버에 저장된 사건·원본 파형·분석·검토는 다른 기기에서도 불러옵니다. 데이터셋에 맞는 나라별 모델을 사용하며, 지원하지 않는 입력은 판단을 보류합니다. 서버에 전송되지 않은 기록은 이 브라우저에만 남을 수 있으므로 저장 상태를 확인하세요.
          </p>
        </div>
      </Row>

      <Row title="LLM·분석기 연결 상태" description="서버 연결, 고장파형 분류 모델, 대화 LLM의 준비 상태를 각각 확인합니다. 마을 상태 도우미는 실측 기록을 읽는 규칙 방식입니다.">
        <div className="stack">
          {capabilities.state === 'checking' && <p role="status">연결 상태를 확인하고 있어요…</p>}
          {capabilities.state === 'down' && <p className="text-bad" role="status">{capabilities.detail}</p>}
          {capabilities.data && <>
            <dl className="dl-rows">
              <div><dt>현장 대화</dt><dd>{assistantStatusLabel(capabilities.data.assistant)}</dd></div>
              <div><dt>대화 모델</dt><dd>{capabilities.data.assistant.model || '미설정'}</dd></div>
              {capabilities.data.models.map((m) => <div key={m.country}><dt>{m.country} 파형 모델</dt><dd>{m.available ? '사용 가능' : '연결 안 됨'} · {m.version || m.key || '버전 미확인'}<br /><span className="small muted">{m.rows}샘플 · {m.channels?.join(', ')} · {m.sampling_rate_hz}Hz · {m.labels?.join(' / ')}</span></dd></div>)}
              <div><dt>접근 권한</dt><dd>{capabilities.data.auth.required ? '접근 코드 필요' : '공개 시연 모드 · 로그인 신원 확인 없음'}</dd></div>
            </dl>
          </>}
          <label className="field" style={{ maxWidth: 480 }}>서버 접근 코드 (설정된 경우)<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
          <div><button className="btn btn-sm" onClick={() => { setApiToken(token); void Promise.allSettled([checkHealth(), checkCapabilities()]) }}>접근 코드 적용</button></div>
          <p className="hint">접근 코드는 서버별로 이 탭의 세션에 보관합니다. 작업자 이름은 로그인 신원을 대신하지 않습니다.</p>
        </div>
      </Row>

      <Row title="데이터 출처" description="실제 모형이 없으면 시뮬레이터 값으로 같은 화면을 시연할 수 있습니다. (사건 데이터가 아니라 마을 계측값입니다)">
        <DevicePanel snap={snap} />
      </Row>

      <Row
        title="회로 구성"
        description={<>설계는 INA219 두 개로 주택·가로등을 나눠 재는 구성입니다. 현재 {snap.source === 'MOCK' ? '시뮬레이터' : !snap.connected || snap.status === 'NO_DATA' ? '실측 센서 확인 전' : snap.zones ? '센서 2개 · 구간별 실측' : '센서 1개 · 전체 실측'} 상태입니다. 센서 1개일 때는 분기 실측값을 만들지 않습니다. LED 5개는 채널 릴레이(D3~D7)로 제어합니다 (설계 정격 {NOMINAL_V} V).</>}
      >
        <ChannelMap />
      </Row>

      <Row title="분석 모델" description="목적별로 분리된 두 모델입니다. 데이터를 섞어 학습하지 않습니다.">
        <div className="stack" style={{ gap: 28 }}>
          {AI_MODELS.map((m) => (
            <div key={m.name}>
              <div className="row gap" style={{ marginBottom: 8 }}>
                <strong>{m.name}</strong>
                <span className="mono xs faint">{m.version}</span>
              </div>
              <dl className="dl-rows">
                <div><dt>데이터</dt><dd>{m.data}</dd></div>
                <div><dt>입력</dt><dd>{m.input}</dd></div>
                <div><dt>출력</dt><dd>{m.output}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      </Row>

      <Row title="작업자" description="검토와 실행 이력에 이 이름이 기록됩니다.">
        <label className="field" style={{ maxWidth: 320 }}>
          이름
          <input value={actor} onChange={(e) => setActor(e.target.value)} />
        </label>
      </Row>

      <Row title="사건 데이터" description="서버 기록은 다른 기기에서도 불러오고, 이 브라우저에는 캐시와 전송 대기 기록을 보관합니다. 서버에 저장된 원본 파형은 캐시를 비운 뒤에도 다시 불러올 수 있습니다.">
        {confirming ? (
          <div className="alert alert-err" style={{ margin: 0, alignItems: 'center' }}>
            <span style={{ flex: 1 }}>이 브라우저의 사건 캐시를 지웁니다. 서버에 저장된 기록과 파형은 다시 불러옵니다. 서버에 저장하지 못한 로컬 사건은 잃을 수 있으므로 먼저 내보내기와 전송 상태를 확인하세요.</span>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>취소</button>
            <button className="btn btn-sm btn-danger on" onClick={reset}>진행</button>
          </div>
        ) : (
          <div className="cluster">
            <button className="btn btn-danger" onClick={() => setConfirming(true)}>보관본 비우기</button>
            {done && <span className="small" style={{ color: 'var(--ok)' }} role="status">{done}</span>}
          </div>
        )}
      </Row>
    </>
  )
}
