import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { getActor } from '../lib/actor'
import { FRTUS } from '../lib/frtu'
import { assignIncident, dismissIncident, FI_SHORT, markIncidentRegistered, observeVillage, openIncident, setIncidentStage, STAGE_LABEL, STAGES, useLiveIncidents, type LiveIncident } from '../lib/liveIncident'
import { ASSISTANT_OPEN_EVENT, askAssistantVillage, INCIDENT_OPEN_EVENT, PANEL_OPEN_EVENT } from '../lib/panels'
import { getVillage, linkEventToCase, useVillage } from '../lib/village'
import { useVillageEvents, type AnalyzedEvent } from '../lib/villageEvents'
import { inspectionCandidate } from '../lib/gis'
import { alertIncident } from '../lib/notify'
import { formatModelScoreWithCaveat } from '../lib/modelScore'
import { IconX } from './Icons'
import WaveCompare, { incidentRows } from './WaveCompare'
import FiCheckBox from './FiCheckBox'
import { fiCrossCheck } from '../lib/fiCheck'
import SingleLineDiagram from './SingleLineDiagram'
import { Badge } from './ui'

const secs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** 화면에는 안 보이고 계측을 지켜보다 고장표시가 뜨면 사건을 만든다. 3D 마을에서는 사건 화면을 바로 띄움 */
export function IncidentWatcher() {
  const snap = useVillage()
  const { pathname } = useLocation()
  const { incidents } = useLiveIncidents()
  // 저장돼 있던 지난 사건은 새 사건으로 치지 않음 (새로고침해도 다시 울리지 않게)
  const seen = useRef(new Set(incidents.map((x) => x.recordId)))
  const [mountedAt] = useState(() => Date.now())
  useEffect(() => observeVillage(snap), [snap])
  useEffect(() => {
    const top = incidents[0]
    if (!top || seen.current.has(top.recordId)) return
    seen.current.add(top.recordId)
    if (top.startedAt < mountedAt) return
    alertIncident(top.title)
    if (pathname === '/village') openIncident(top.recordId)
  }, [incidents, pathname, mountedAt])
  // 사건 기록 자동 등록: 이 화면을 연 뒤 생긴 사건은 사람이 누르지 않아도 사건 기록으로 넘김.
  // 이상 전후 계측이 기록에 담기도록 복구되거나 15초가 지난 뒤 한 번만 등록 (같은 사건은 다시 등록하지 않음)
  const tried = useRef(new Map<string, number>())
  const latest = useRef(incidents)
  latest.current = incidents
  useEffect(() => {
    const tick = () => {
      for (const inc of latest.current) {
        if (inc.caseId || inc.startedAt < mountedAt || (tried.current.get(inc.recordId) ?? 0) >= 3) continue
        if (!inc.clearedAt && Date.now() - inc.startedAt < 15_000) continue
        const ev = getVillage().events.find((e) => e.id === inc.ruleEventId)
        if (!ev) continue
        if (ev.caseId) { markIncidentRegistered(inc.recordId, ev.caseId); continue }
        if (tried.current.get(inc.recordId) === -1) continue
        const n = (tried.current.get(inc.recordId) ?? 0) + 1
        tried.current.set(inc.recordId, -1)
        api.registerIotEvent({ event: ev, actor: getActor() })
          .then((c) => { tried.current.set(inc.recordId, 3); linkEventToCase(ev.id, c.id); markIncidentRegistered(inc.recordId, c.id) })
          // 실패하면 최대 3번까지 다시 시도
          .catch(() => tried.current.set(inc.recordId, n))
      }
    }
    const t = setInterval(tick, 2000)
    return () => clearInterval(t)
  }, [mountedAt])
  return null
}

/** 어느 화면에서든 위쪽에 뜨는 사건 알림 */
export function IncidentBanner() {
  const { incidents, openId, dismissed } = useLiveIncidents()
  const top = incidents[0]
  const now = useNow(!!top)
  if (!top || openId === top.recordId || dismissed.includes(top.recordId)) return null
  if (top.clearedAt && now - top.clearedAt > 60_000) return null
  const live = !top.clearedAt
  return (
    <div className={`incident-banner ${live ? 'live' : 'ok'} no-print`} role="alert">
      <span className="ib-dot" />
      <strong>{live ? top.title : `복구됨 · ${secs(top.clearedAt! - top.startedAt)} 만에`}</strong>
      <span className="ib-time">{live ? `${secs(now - top.startedAt)} 전 발생` : top.title}</span>
      <button type="button" className="btn btn-sm" onClick={() => openIncident(top.recordId)}>보기</button>
      <button type="button" className="ib-x" onClick={() => dismissIncident(top.recordId)} aria-label="알림 닫기"><IconX /></button>
    </div>
  )
}

/** 처리 단계(접수 → 출동 → 점검 → 복구 → 종결)와 담당자. 담당자가 직접 단계를 넘긴다 */
export function StageBar({ inc }: { inc: LiveIncident }) {
  const [name, setName] = useState(inc.assignee ?? '')
  const at = STAGES.indexOf(inc.stage)
  const next = STAGES[at + 1]
  return (
    <div className="stagebar">
      <ol>
        {STAGES.map((s, k) => {
          const log = [...inc.stageLog].reverse().find((l) => l.stage === s)
          return (
            <li key={s} className={k < at ? 'done' : k === at ? 'now' : ''}>
              <b>{STAGE_LABEL[s]}</b>
              <span>{log ? new Date(log.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</span>
            </li>
          )
        })}
      </ol>
      <div className="stagebar-ctl">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => assignIncident(inc.recordId, name)} placeholder="담당자 이름" aria-label="담당자" />
        {next && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => { assignIncident(inc.recordId, name); setIncidentStage(inc.recordId, next, name.trim() || getActor()) }}>
            {STAGE_LABEL[next]}(으)로
          </button>
        )}
      </div>
    </div>
  )
}

/** 실시간 사건 화면: 사건 전후 파형 · 고장 구간 · 원인 판정 · 진행 · 등록/AI */
export function IncidentSheet() {
  const { incidents, openId } = useLiveIncidents()
  const inc = incidents.find((x) => x.recordId === openId) ?? null

  // 열리면 다른 패널을 비키게 하고, AI·마을 패널이 열리면 접힘
  useEffect(() => {
    if (inc) window.dispatchEvent(new Event(INCIDENT_OPEN_EVENT))
  }, [inc?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const close = () => openIncident(null)
    window.addEventListener(ASSISTANT_OPEN_EVENT, close)
    window.addEventListener(PANEL_OPEN_EVENT, close)
    return () => {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, close)
      window.removeEventListener(PANEL_OPEN_EVENT, close)
    }
  }, [])

  if (!inc) return null
  return <SheetBody inc={inc} />
}

/** 이 사건 시각 근처에 우노가 녹화해 보낸 사건 파형(AI 판정)이 있으면 찾음 */
export function findRecorded(inc: LiveIncident, events: AnalyzedEvent[]): AnalyzedEvent | undefined {
  return events.find((a) => a.recordId === inc.rawEventRecordId) ?? events.find((a) => (a.e.source ?? 'SERIAL') === inc.source && Math.abs(new Date(a.e.receivedAt).getTime() - inc.startedAt) < 8000)
}

/** 사건 경과(시간순) · 단선도 */
export function IncidentTrail({ inc, recorded }: { inc: LiveIncident; recorded?: AnalyzedEvent }) {
  const live = !inc.clearedAt
  const cand = inspectionCandidate(inc.scope)
  return (
    <>
      <ol className="is-timeline">
        <li className="err"><b>{new Date(inc.startedAt).toLocaleTimeString('ko-KR', { hour12: false })}</b> 고장표시 발생</li>
        {recorded && <li><b>{new Date(recorded.e.receivedAt).toLocaleTimeString('ko-KR', { hour12: false })}</b> FRTU가 사건 파형 녹화·전송</li>}
        {inc.caseId && <li><b>등록</b> 사건 기록 {inc.caseId} (자동)</li>}
        <li className={live ? 'wait' : 'ok'}>{live ? <><b>대기</b> 아직 복구되지 않음</> : <><b>{new Date(inc.clearedAt!).toLocaleTimeString('ko-KR', { hour12: false })}</b> 복구 ({secs(inc.clearedAt! - inc.startedAt)})</>}</li>
      </ol>
      <SingleLineDiagram highlight={cand?.branches} fi={inc.fi} candidate={cand} />
    </>
  )
}

/** 사건 알림 시트: 핵심만 보여 주고 자세한 내용은 상세 원인 분석 페이지로 */
function SheetBody({ inc }: { inc: LiveIncident }) {
  const live = !inc.clearedAt
  const now = useNow(live)
  const events = useVillageEvents()
  const nav = useNavigate()
  const rec = findRecorded(inc, events)
  const v = rec?.verdict
  const open = () => { openIncident(null); nav(`/incidents/${inc.recordId}`) }

  return (
    <section className="incident-sheet no-print" role="dialog" aria-label="실시간 사건">
      <header className="is-head">
        <div style={{ minWidth: 0 }}>
          <span className="is-kicker">실시간 사건 #{inc.id} · {inc.source === 'MOCK' ? '시뮬레이터' : '실측'} · 마을 직류 계측</span>
          <h2>{inc.title}</h2>
        </div>
        <Badge tone={live ? 'err' : 'ok'}>{live ? `진행 중 · ${secs(now - inc.startedAt)}` : `복구됨 · ${secs(inc.clearedAt! - inc.startedAt)} 만에`}</Badge>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => openIncident(null)} aria-label="닫기"><IconX /></button>
      </header>
      <div className="is-side" style={{ gap: 10 }}>
        <div className="is-card">
          <span>원인 판정 <small>계측값 규칙</small></span>
          <strong>{inc.cause}</strong>
        </div>
        {v && (
          <div className="is-card">
            <span>사건 파형 AI <small>우노 녹화</small></span>
            <strong>{v.kind === 'ANSWERED' ? `${v.labelKo} · 점수 ${formatModelScoreWithCaveat(v.score)}` : v.kind === 'WITHHELD' ? `판단 보류 (1순위 ${v.labelKo})` : v.kind === 'NO_MODEL' ? '모델 학습 전' : '입력 거부'}</strong>
          </div>
        )}
        <FiCheckBox check={fiCrossCheck(inc, rec)} compact />
        <div className="is-fi">
          {FRTUS.map((f) => (
            <div key={f.id} className={inc.fi[f.id] !== 'NONE' ? 'hit' : ''}>
              <span>{f.short}</span>
              <b>{FI_SHORT[inc.fi[f.id]]}</b>
            </div>
          ))}
        </div>
        <WaveCompare rows={incidentRows(inc)} />
        <div className="is-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={open}>상세 원인 분석 보기</button>
          <button type="button" className="btn btn-sm" onClick={askAssistantVillage}>AI에게 묻기</button>
        </div>
      </div>
    </section>
  )
}
