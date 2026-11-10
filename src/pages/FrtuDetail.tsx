import { Link, useSearchParams } from 'react-router-dom'
import { CsvAnalysis, FaultLocationBox, FrtuStrip, LiveWave } from '../components/AiPanel'
import VillageStatusChat from '../components/VillageStatusChat'
import { LiveAnalysis } from './LiveData'
import EventCausePanel from '../components/EventCausePanel'
import { Badge, NODE_TONE, Status } from '../components/ui'
import { FI_LABEL, frtuViews, isFrtuId, locateFault, type FrtuId } from '../lib/frtu'
import { inspectionCandidate } from '../lib/gis'
import SingleLineDiagram, { InspectionCard } from '../components/SingleLineDiagram'
import { connectSerial, DEVICE_INFO, IOT_CHANNELS, STATUS_LABEL, THRESHOLDS, useVillage } from '../lib/village'
import { useVillageEvents } from '../lib/villageEvents'

type Tab = 'overview' | 'live'
const TABS: [Tab, string][] = [
  ['overview', 'FRTU 요약'],
  ['live', '실시간 분석'],
]

function Bar({ value, tone }: { value: number; tone: 'ok' | 'warn' | 'err' }) {
  return <div className="meter"><i className={tone} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} /></div>
}

/** FRTU 상세: FRTU 3대(인입·주택 분기·가로등 분기) 중 하나를 골라 파형 추이 · 고장표시 · 고장 구간 · 대화 도우미 */
export default function FrtuDetail() {
  const [params, setParams] = useSearchParams()
  const id: FrtuId = isFrtuId(params.get('id')) ? (params.get('id') as FrtuId) : 'inlet'
  const tab: Tab = params.get('tab') === 'live' ? 'live' : 'overview'
  const setQuery = (next: { id?: FrtuId; tab?: Tab }) => {
    const q: Record<string, string> = {}
    const nid = next.id ?? id
    const ntab = next.tab ?? tab
    if (nid !== 'inlet') q.id = nid
    if (ntab !== 'overview') q.tab = ntab
    setParams(q, { replace: true })
  }
  const pick = (next: FrtuId) => setQuery({ id: next })
  const snap = useVillage()
  const events = useVillageEvents()
  const views = frtuViews(snap)
  const f = views[id]
  const fiAll = f.available ? { inlet: views.inlet.fi, house: views.house.fi, lamp: views.lamp.fi } : {}
  const cand = inspectionCandidate(locateFault(snap, views).scope)
  const last = events[0]
  const v = last?.verdict
  const alarm = f.fi !== 'NONE' || ['WARNING', 'FAULT', 'OUTAGE'].includes(f.status)
  const scoreTone = f.score >= THRESHOLDS.fault ? 'err' : f.score >= THRESHOLDS.warn ? 'warn' : 'ok'
  const ratio = f.expected > 0 ? f.i / f.expected : 0
  const suspects = id === 'inlet' ? snap.diagnosis?.candidates.map((c) => snap.leds[c].name).join(', ') : undefined
  const mine = IOT_CHANNELS.filter((c) => f.def.channels.includes(c.id))
  const on = mine.filter((c) => snap.leds[c.id].channelOn)
  const sensorSource = !snap.connected
    ? '장치 연결 끊김'
    : snap.source === 'MOCK'
      ? '브라우저 시뮬레이터 데이터'
      : id === 'inlet'
        ? snap.zones ? 'INA219 두 구간 실측값의 합' : '응답한 INA219 센서의 실측 전체값'
        : snap.zones ? `${f.def.sensor} 실측` : `${f.def.sensor} 미응답 · 분기값 없음`
  // 장치가 끊기면 값이 0으로 남아 정상처럼 보이므로 숫자 대신 안내를 보여 줌
  const offline = !snap.connected
  const dash = (text: string) => (offline ? '—' : text)
  // 화면에 보이는 값만으로 만든 근거 문장 (지어내지 않음)
  const reasons = offline
    ? ['장치가 연결되지 않아 지금 계측값이 없어서 판단할 수 없어요.']
    : !f.available
    ? [f.unavailableReason ?? '계측값이 없어요.']
    : [
        `이 FRTU가 맡은 LED 중 켜 둔 것은 ${on.length}개(${on.map((c) => c.name).join(', ') || '없음'})예요.`,
        `측정 전류 ${(f.i * 1000).toFixed(1)} mA, 정상 전류 ${(f.expected * 1000).toFixed(1)} mA로 ${Math.round(ratio * 100)}%예요.`,
        `전압은 ${f.v.toFixed(2)} V예요${f.v < THRESHOLDS.vMin ? ` (기준 ${THRESHOLDS.vMin} V 아래)` : ''}.`,
        `이상 점수 ${f.score.toFixed(2)} → 고장표시: ${FI_LABEL[f.fi]} (주의 ${THRESHOLDS.warn} · 이상 ${THRESHOLDS.fault}).`,
        ...(suspects ? [`조합표 판정 · 의심: ${suspects}.`] : []),
      ]

  return (
    <div className="dash frtu">
      <div className="dash-head">
        <div>
          <h1>{f.def.name}</h1>
          <p>{f.def.role} FRTU · {f.def.sensor} · 0.5초 간격 계측</p>
        </div>
        <Status tone={f.fi !== 'NONE' ? 'err' : NODE_TONE[f.status]} live={alarm}><strong>{STATUS_LABEL[f.status]}</strong></Status>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setQuery({ tab: k })}>{label}</button>
        ))}
      </div>

      {offline && (
        <div className="alert alert-warn" role="status">
          <span>
            <strong>장치가 연결되지 않아 지금 들어오는 계측값이 없어요.</strong>{' '}
            파형과 측정값이 비어 있는 건 고장이 아니라 값이 안 들어와서예요.{' '}
            {snap.source === 'SERIAL' ? (
              <button className="btn btn-sm btn-primary" onClick={() => void connectSerial().catch(() => {})}>장치 다시 연결</button>
            ) : null}{' '}
            <Link to="/settings" className="btn btn-sm">설정에서 데이터 출처 바꾸기</Link>
          </span>
        </div>
      )}

      {tab === 'live' ? (
        <div className="tab-panel"><LiveAnalysis /></div>
      ) : (
      <>
      <section className="dash-card frtu-overview">
        <FrtuStrip snap={snap} value={id} onPick={pick} />
        <div className="frtu-topo">
          <SingleLineDiagram highlight={cand?.branches} fi={fiAll} candidate={cand} />
          <div className="stack" style={{ gap: 10 }}>
            <FaultLocationBox snap={snap} />
            <InspectionCard candidate={cand} />
          </div>
        </div>
        <p className="xs muted">
          {snap.source === 'MOCK' ? '시뮬레이터 데이터입니다. ' : 'Arduino에서 받은 값입니다. '}
          {snap.zones ? '두 INA219 구간 실측으로 분기 FRTU를 표시하고, 인입값은 두 구간의 합입니다.' : '현재 응답한 INA219 한 개로 전체 전류만 측정합니다. 주택·가로등 분기값과 분기 파형은 측정되지 않아 표시하지 않습니다.'}
          {' '}직류 모형 계측이며 교류 고장파형 분석과는 별도입니다.
        </p>
      </section>

      <div className="dash-cols">
        <div className="stack" style={{ gap: 14 }}>
          <section className="dash-card">
            <div className="dash-card-head"><h2>파형 추이</h2><span className="small muted">최근 1분</span></div>
            {offline ? (
              <p className="muted small" style={{ padding: '48px 0', textAlign: 'center' }}>장치 연결 끊김 · 들어오는 계측값이 없어 파형을 그릴 수 없어요.</p>
            ) : (
              <LiveWave snap={snap} frtu={id} />
            )}
          </section>

          <section className="dash-card">
            <div className="dash-card-head"><h2>상태 판정 (임계값 기반)</h2><span className="small muted">{last ? `사건 #${last.e.ev} 기준` : 'AI 모델 판정이 아닌 계측 임계값 판정'}</span></div>
            <div className="judge-row">
              <div className="judge">
                <span>현재 상태</span>
                <Badge tone={NODE_TONE[f.status]}>{STATUS_LABEL[f.status]}</Badge>
              </div>
              <div className="judge">
                <span>고장표시</span>
                <strong>{FI_LABEL[f.fi]}</strong>
              </div>
              {f.available && <div className="judge">
                <span>이상 점수</span>
                <strong>{dash(f.score.toFixed(2))}</strong>
              </div>}
              <div className="judge">
                <span>마지막 사건 판정</span>
                <strong>{!v ? '—' : v.kind === 'ANSWERED' ? v.labelKo : v.kind === 'WITHHELD' ? '보류' : v.kind === 'NO_MODEL' ? '모델 학습 전' : '입력 거부'}</strong>
              </div>
            </div>
            {v && (v.kind === 'ANSWERED' || v.kind === 'WITHHELD') && (
              <div className="evidence">
                <div className="small muted" style={{ marginBottom: 8 }}>판단 근거 (기여도 큰 순)</div>
                {v.evidence.map((e) => (
                  <div key={e.name} className="evidence-row">
                    <span>{e.label}</span>
                    <div className="meter"><i className={e.contribution >= 0 ? 'ok' : 'err'} style={{ width: `${Math.min(100, Math.abs(e.contribution) * 300)}%` }} /></div>
                    <span className="num small">{e.value.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
            <h3 className="ai-h">판단 근거</h3>
            <ul className="reasons">
              {reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
            <div style={{ marginTop: 16 }}><EventCausePanel /></div>
          </section>

          <section className="dash-card">
            <div className="dash-card-head"><h2>CSV 고장파형 분석</h2><span className="small muted">지원 모델의 채널 형식에 맞는 파형을 넣으면 분석</span></div>
            <CsvAnalysis />
          </section>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <section className="dash-card">
            <div className="dash-card-head"><h2>정보</h2></div>
            {!f.available ? <div className="alert alert-warn small">{f.unavailableReason} 측정값·예상값·점수는 만들지 않습니다.</div> : <>
            <div className="info-box">
              <span>측정 전류</span>
              <strong>{dash(`${(f.i * 1000).toFixed(1)} mA`)}</strong>
              {!offline && <Bar value={ratio / 1.5} tone={Math.abs(ratio - 1) > 0.3 ? 'err' : 'ok'} />}
              <small>{offline ? '장치 연결 끊김 · 계측값 없음' : `예상 ${(f.expected * 1000).toFixed(1)} mA 대비 ${Math.round(ratio * 100)}%`}</small>
            </div>
            <div className="info-box">
              <span>이상 점수</span>
              <strong>{dash(`${Math.round(f.score * 100)}%`)}</strong>
              {!offline && <Bar value={f.score} tone={scoreTone} />}
              <small>주의 {THRESHOLDS.warn} · 이상 {THRESHOLDS.fault} 기준</small>
            </div>
            <dl className="kv info-kv">
              <div><dt>전압</dt><dd>{dash(`${f.v.toFixed(2)} V`)}</dd></div>
              <div><dt>전력</dt><dd>{dash(`${(f.v * f.i).toFixed(2)} W`)}</dd></div>
              <div><dt>맡은 LED</dt><dd>{mine.filter((c) => snap.leds[c.id].lit).length} / {mine.length} 켜짐</dd></div>
              <div><dt>마을 전원</dt><dd>{snap.relay ? '켜짐' : '차단'}</dd></div>
              <div><dt>값 출처</dt><dd>{sensorSource}</dd></div>
              <div><dt>장치</dt><dd>{snap.connected ? DEVICE_INFO[snap.source].deviceId : '연결 끊김'}</dd></div>
            </dl>
            </>}
          </section>

          <section className="dash-card">
            <div className="dash-card-head"><h2>상태 도우미</h2><span className="small muted">글 또는 음성 · 조회 전용</span></div>
            <VillageStatusChat />
          </section>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
