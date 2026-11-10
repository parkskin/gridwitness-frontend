import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { FaultLocationBox, FrtuStrip } from '../components/AiPanel'
import { IconAlert, IconArrowRight, IconBrain, IconInbox, IconLive, IconVillage, IconWave } from '../components/Icons'
import { Badge, ErrorState, TableSkeleton, type Tone } from '../components/ui'
import { frtuViews, locateFault } from '../lib/frtu'
import { askAssistantAbout } from '../lib/panels'
import { API_CHANGED_EVENT } from '../lib/backend'
import { STAGE_LABEL, useLiveIncidents } from '../lib/liveIncident'
import { formatModelScore } from '../lib/modelScore'
import { STATUS_LABEL, useVillage } from '../lib/village'
import { useVillageEvents, type AnalyzedEvent } from '../lib/villageEvents'
import type { AnyCase, CaseStage, CaseSummary } from '../types'
import { DeviceConnectCard } from './LiveData'
import { KEPCO_OUTAGE_2025, KEPCO_OUTAGE_SOURCE, loadRegion, outageTotals, saveRegion } from '../data/kepcoOutage'

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/** 경과 시간을 '3일 4시간', '5시간 12분', '8분'처럼 */
function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}분`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간${m % 60 ? ` ${m % 60}분` : ''}`
  const d = Math.floor(h / 24)
  return `${d}일${h % 24 ? ` ${h % 24}시간` : ''}`
}
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const k = Math.floor(s.length / 2)
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}

function Kpi({ label, value, chip, icon, primary, onClick }: { label: string; value: ReactNode; chip: ReactNode; icon: ReactNode; primary?: boolean; onClick?: () => void }) {
  return (
    <div className={`kpi ${primary ? 'primary' : ''} ${onClick ? 'clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}>
      <div className="kpi-top">
        <span>{label}</span>
        <span className="kpi-icon">{icon}</span>
      </div>
      <div className="kpi-value">{value}</div>
      <span className="kpi-chip">{chip}</span>
    </div>
  )
}

function verdictOf(a: AnalyzedEvent): { tone: Tone; text: string; score: string } {
  const v = a.verdict
  if (v.kind === 'ANSWERED') return { tone: v.isFault ? 'err' : 'ok', text: v.labelKo, score: formatModelScore(v.score) }
  if (v.kind === 'WITHHELD') return { tone: 'warn', text: `보류 (1순위 ${v.labelKo})`, score: formatModelScore(v.score) }
  if (v.kind === 'NO_MODEL') return { tone: 'off', text: '모델 학습 전', score: '—' }
  return { tone: 'err', text: '입력 거부', score: '—' }
}

/** 검토 대기 사건을 할 일로: AI 결과와 우선순위 (사람 손이 먼저 필요한 것부터) */
const TODO: Partial<Record<CaseStage, { text: string; tone: Tone; rank: number }>> = {
  WITHHELD: { text: 'AI 판단 보류', tone: 'warn', rank: 0 },
  REGISTERED: { text: '분석 전', tone: 'neutral', rank: 1 },
  DIAGNOSED: { text: '분석 전', tone: 'neutral', rank: 1 },
  ANALYZED: { text: 'AI 답함 · 검토만', tone: 'accent', rank: 2 },
}

/** 사고 대응 흐름: 단계별 건수와 검토 완료까지 걸린 시간 */
const FLOW: { key: string; label: string; stages: CaseStage[]; color: string }[] = [
  { key: 'pre', label: '분석 전', stages: ['REGISTERED', 'DIAGNOSED'], color: '#c9ced8' },
  { key: 'held', label: 'AI 보류', stages: ['WITHHELD'], color: '#f0a43a' },
  { key: 'ans', label: 'AI 답함', stages: ['ANALYZED'], color: '#5b8cff' },
  { key: 'done', label: '검토 완료', stages: ['REVIEWED'], color: '#2fa36b' },
]

function ResponseCard({ cases, full, now }: { cases: CaseSummary[]; full: AnyCase[]; now: number }) {
  const total = cases.length || 1
  const done = full.filter((c) => c.reviews.length > 0).map((c) => new Date(c.reviews[0].reviewedAt).getTime() - new Date(c.createdAt).getTime()).filter((x) => x >= 0)
  const med = median(done)
  const pending = cases.filter((c) => c.stage !== 'REVIEWED')
  const oldest = pending.length ? Math.max(...pending.map((c) => now - new Date(c.createdAt).getTime())) : null
  return (
    <section className="dash-card">
      <div className="dash-card-head"><h2>대응 현황</h2><span className="small muted">사건 {cases.length}건</span></div>
      <div className="flow-bar" aria-label="단계별 사건 수">
        {FLOW.map((f) => {
          const n = cases.filter((c) => f.stages.includes(c.stage)).length
          return n ? <i key={f.key} style={{ width: `${(n / total) * 100}%`, background: f.color }} title={`${f.label} ${n}건`} /> : null
        })}
      </div>
      <ul className="flow-legend">
        {FLOW.map((f) => (
          <li key={f.key}><i style={{ background: f.color }} />{f.label}<b className="num">{cases.filter((c) => f.stages.includes(c.stage)).length}</b></li>
        ))}
      </ul>
      <div className="flow-stats">
        <div><span>검토 완료까지 (중앙값)</span><strong>{med == null ? '—' : fmtDur(med)}</strong><small>{done.length ? `완료 ${done.length}건 기준` : '아직 검토 완료 없음'}</small></div>
        <div><span>가장 오래 기다리는 사건</span><strong className={oldest != null && oldest > 86_400_000 ? 'warn' : ''}>{oldest == null ? '—' : fmtDur(oldest)}</strong><small>{pending.length ? `대기 ${pending.length}건` : '대기 없음'}</small></div>
      </div>
    </section>
  )
}

/** 오늘 생긴 실시간 사건 (발생 → 처리 단계 → 복구) */
function TodayIncidents() {
  const { incidents } = useLiveIncidents()
  const nav = useNavigate()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = incidents.filter((x) => x.startedAt >= start.getTime())
  return (
    <>
      <div className="dash-card-head" style={{ marginTop: 18 }}>
        <h2>오늘의 실시간 사건</h2>
        <span className="small muted">{today.length}건</span>
      </div>
      {today.length === 0 ? (
        <p className="muted small" style={{ margin: '4px 2px' }}>오늘은 고장표시가 없었어요.</p>
      ) : (
        <ol className="today-list">
          {today.slice(0, 6).map((x) => (
            <li key={x.id} className={x.clearedAt ? '' : 'live'}>
              <span className="today-time num">{new Date(x.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              <button type="button" className="today-main" onClick={() => nav(`/incidents/${x.recordId}`)}>
                <strong>{x.title.split(' (')[0]}</strong>
                <span>{x.clearedAt ? `${Math.round((x.clearedAt - x.startedAt) / 1000)}초 만에 복구` : '진행 중'} · {x.assignee ?? '담당자 미지정'}</span>
              </button>
              <Badge tone={x.stage === 'CLOSED' ? 'ok' : x.stage === 'RESTORED' ? 'accent' : 'warn'}>{STAGE_LABEL[x.stage]}</Badge>
              <Link to={`/report/live/${x.id}`} className="small">보고서</Link>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

/** 한전 공공데이터: 고른 지역본부의 2025년 정전 건수와 전국 대비 */
function RegionOutageCard() {
  const [region, setRegionState] = useState(loadRegion)
  const mine = KEPCO_OUTAGE_2025.find((r) => r.region === region)!
  const total = outageTotals()
  const rank = [...KEPCO_OUTAGE_2025].sort((a, b) => b.sustained - a.sustained).findIndex((r) => r.region === region) + 1
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>지역 정전 · 2025</h2>
        <select className="impact-select" value={region} onChange={(e) => (setRegionState(e.target.value), saveRegion(e.target.value))} aria-label="지역본부">
          {KEPCO_OUTAGE_2025.map((r) => <option key={r.region} value={r.region}>{r.region}</option>)}
        </select>
      </div>
      <div className="flow-stats">
        <div><span>일시정전 (원인 조사 대상)</span><strong>{mine.sustained}건</strong><small>전국 {total.sustained.toLocaleString('ko-KR')}건 중 {rank}위</small></div>
        <div><span>순시·순간정전</span><strong>{mine.momentary}건</strong><small>전국 {total.momentary.toLocaleString('ko-KR')}건</small></div>
      </div>
      <div className="region-foot">
        <a href={KEPCO_OUTAGE_SOURCE.url} target="_blank" rel="noreferrer" className="xs muted">출처: 한전 배전 정전통계종합 (공공데이터포털)</a>
        <Link to="/public-data#outage" className="small">공공데이터 분석 →</Link>
      </div>
    </section>
  )
}

export default function Dashboard() {
  const snap = useVillage()
  const events = useVillageEvents()
  const nav = useNavigate()
  const [cases, setCases] = useState<CaseSummary[] | null>(null)
  const [full, setFull] = useState<AnyCase[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const loadSequence = useRef(0)
  const load = useCallback(() => {
    const sequence = ++loadSequence.current
    setError(null)
    setNow(Date.now())
    api
      .listCases()
      .then(async (list) => {
        if (sequence !== loadSequence.current) return
        setCases(list)
        // 대시보드 지표를 읽을 때 전체 백업·보관 사건·원본 첨부까지 내려받지 않는다.
        const current = await Promise.all(list.map((c) => api.getCase(c.id)))
        if (sequence === loadSequence.current) setFull(current)
      })
      .catch((e: Error) => { if (sequence === loadSequence.current) setError(e.message) })
  }, [])
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') load() }
    refresh()
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    window.addEventListener(API_CHANGED_EVENT, refresh)
    return () => {
      loadSequence.current++
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener(API_CHANGED_EVENT, refresh)
    }
  }, [load])

  const open = snap.events.filter((e) => !e.clearedAt)
  const withheld = events.filter((a) => a.verdict.kind === 'WITHHELD').length
  const pending = cases?.filter((c) => c.stage !== 'REVIEWED') ?? []
  const todo = [...pending].sort((a, b) => (TODO[a.stage]?.rank ?? 3) - (TODO[b.stage]?.rank ?? 3) || a.createdAt.localeCompare(b.createdAt))
  const fv = frtuViews(snap)
  const fiCount = Object.values(fv).filter((f) => f.fi !== 'NONE').length
  const loc = locateFault(snap, fv)
  const live = snap.connected && snap.status !== 'NO_DATA'

  // AI 판정과 규칙 기반 이상을 한 표에 시간순으로
  const rows = [
    ...events.map((a) => ({ key: `a${a.e.ev}${a.e.receivedAt}`, at: a.e.receivedAt, name: `사건 #${a.e.ev} · ${a.e.src === 'cmd' ? '개폐 명령 직후' : '전류 급변'}`, by: 'AI', ...verdictOf(a) })),
    ...snap.events.map((e) => ({ key: `r${e.id}`, at: e.at, name: e.label ?? `마을 ${STATUS_LABEL[e.status]}`, by: '규칙', tone: (e.status === 'WARNING' ? 'warn' : 'err') as Tone, text: STATUS_LABEL[e.status], score: e.maxScore.toFixed(2) })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>오늘의 관제 현황</h1>
        </div>
        <div className="dash-head-actions">
          <span className="dash-stamp">기준 {new Date(now).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
          <Link to="/village" className="village-btn"><IconVillage /><span>3D 마을 보기</span></Link>
        </div>
      </div>

      <div className="kpi-row">
        <Kpi primary label="진행 중 이상" value={`${open.length}건`} chip={live ? `마을 ${STATUS_LABEL[snap.status]}` : '실측 장치 연결 끊김'} icon={<IconAlert />} />
        <Kpi label="AI 판정" value={`${events.length}건`} chip={`보류 ${withheld}건`} icon={<IconBrain />} />
        <Kpi label="검토 대기 사건" value={cases ? `${pending.length}건` : '—'} chip={cases ? `AI 보류 ${pending.filter((c) => c.stage === 'WITHHELD').length}건` : '불러오는 중'} icon={<IconInbox />} onClick={() => nav('/cases')} />
        <Kpi
          label="FRTU 고장표시"
          value={live ? `${fiCount}/3` : '—'}
          chip={!live ? '계측값 없음' : fiCount ? loc.title.split(' (')[0] : '모두 정상'}
          icon={<IconLive />}
          onClick={() => nav('/frtu')}
        />
      </div>

      <div className="dash-cols">
        <section className="dash-card">
          <div className="dash-card-head">
            <h2>마을 FRTU</h2>
            <Link to="/frtu" className="pill-link">FRTU 파형 분석 <IconArrowRight /></Link>
          </div>
          {!live ? (
            <DeviceConnectCard real={snap.source === 'SERIAL'} reconnecting={snap.reconnecting} />
          ) : (
            <div className="dash-sub">
              <FrtuStrip snap={snap} value="inlet" onPick={(id) => nav(`/frtu${id === 'inlet' ? '' : `?id=${id}`}`)} />
              <FaultLocationBox snap={snap} />
            </div>
          )}

          <TodayIncidents />

          <div className="dash-card-head" style={{ marginTop: 18 }}>
            <h2>최근 판정</h2>
          </div>
          {rows.length === 0 ? (
            <p className="muted small" style={{ margin: '4px 2px' }}>아직 판정한 마을 사건이 없어요.</p>
          ) : (
            <table className="dash-table">
              <thead><tr><th>사건</th><th>판정</th><th>판정 주체</th><th className="num">점수 (확률 아님)</th><th className="num">시각</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="clickable" onClick={() => nav('/frtu')}>
                    <td><span className="row-icon"><IconWave /></span>{r.name}</td>
                    <td><Badge tone={r.tone}>{r.text}</Badge></td>
                    <td className="muted">{r.by}</td>
                    <td className="num">{r.score}</td>
                    <td className="num muted">{hhmm(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div className="stack" style={{ gap: 14 }}>
          <RegionOutageCard />
          {cases && !error && <ResponseCard cases={cases} full={full} now={now} />}

          <section className="dash-card">
            <div className="dash-card-head">
              <h2>처리할 사건</h2>
              <Link to="/cases" className="pill-link">전체 보기 <IconArrowRight /></Link>
            </div>
            {error ? (
              <ErrorState message={error} onRetry={load} />
            ) : !cases ? (
              <TableSkeleton rows={4} />
            ) : todo.length === 0 ? (
              <p className="muted" style={{ margin: '8px 4px' }}>처리할 사건이 없어요.</p>
            ) : (
              <ul className="todo-list">
                {todo.slice(0, 6).map((c) => {
                  const t = TODO[c.stage] ?? { text: c.stage, tone: 'neutral' as Tone }
                  return (
                    <li key={c.id}>
                      <button type="button" className="todo-main" onClick={() => nav(`/cases/${c.id}`)}>
                        <strong>{c.title}</strong>
                        <span><span className="mono">{c.id}</span> · {fmtDur(now - new Date(c.createdAt).getTime())}째 대기</span>
                      </button>
                      <Badge tone={t.tone}>{t.text}</Badge>
                      {c.caseType === 'WAVEFORM' && (
                        <button type="button" className="btn btn-sm todo-ask" onClick={() => askAssistantAbout(c.id)} title="이 사건을 AI 도우미로 열기">AI에게 묻기</button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
