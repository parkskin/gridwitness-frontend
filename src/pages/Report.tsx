import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { listFieldNotes, type FieldNote } from '../api/fieldNotes'
import SingleLineDiagram from '../components/SingleLineDiagram'
import { ErrorState, PageSkeleton } from '../components/ui'
import { fmtTime } from '../lib/actor'
import { FRTUS } from '../lib/frtu'
import { inspectionCandidate } from '../lib/gis'
import { buildIncidentContext, EVIDENCE_GROUP_LABEL, eventKo, type EvidenceGroup } from '../lib/incidentContext'
import { FI_SHORT, STAGE_LABEL, getLiveIncident, useLiveIncidents, type LiveIncident } from '../lib/liveIncident'
import { SOURCE_LABEL, type AnyCase, type IncidentCase } from '../types'
import { formatModelScore } from '../lib/modelScore'

// 사고조사 보고서: 기획서의 출력 형태(구간 → 유형 → 원인 가설 → 점검 목록 → 근거)를 한 장으로.
// 실시간 사건(마을 직류 계측)과 교류 고장파형 사건 모두 같은 틀. 인쇄·PDF 저장용.

const dt = (t: number | string) => new Date(t).toLocaleString('ko-KR', { hour12: false })
const secs = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}초` : `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`)

function Block({ no, title, children }: { no: number; title: string; children: ReactNode }) {
  return (
    <section className="rp-block">
      <h2><span>{no}</span>{title}</h2>
      {children}
    </section>
  )
}

function Frame({ id, kind, title, children }: { id: string; kind: string; title: string; children: ReactNode }) {
  return (
    <article className="report">
      <div className="rp-actions no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>인쇄 · PDF로 저장</button>
      </div>
      <header className="rp-head">
        <div>
          <span className="rp-kicker">GridWitness 사고조사 보고서</span>
          <h1>{title}</h1>
        </div>
        <dl>
          <div><dt>사건</dt><dd className="mono">{id}</dd></div>
          <div><dt>자료</dt><dd>{kind}</dd></div>
          <div><dt>작성</dt><dd>{dt(Date.now())}</dd></div>
        </dl>
      </header>
      {children}
      <footer className="rp-foot">
        <p>이 보고서의 판독·점검 순서는 GridWitness의 <b>제안</b>입니다. 최종 판단과 설비 조작은 담당자가 합니다. 근거가 부족한 항목은 판단 보류로 남겼습니다.</p>
        <div className="rp-sign"><span>담당자 ____________________</span><span>검토자 ____________________</span></div>
      </footer>
    </article>
  )
}

export default function Report() {
  const { kind = '', id = '' } = useParams()
  if (kind === 'live') return <LiveReport id={id} />
  return <CaseReport id={id} />
}

function LiveReport({ id }: { id: string }) {
  useLiveIncidents()
  const inc = getLiveIncident(id)
  if (!inc) return <ErrorState message={`실시간 사건 ${id}을 현재 서버의 기록에서 찾지 못했어요.`} />
  return <LiveBody inc={inc} />
}

function LiveBody({ inc }: { inc: LiveIncident }) {
  const cand = inspectionCandidate(inc.scope)
  const data = inc.points.map((p) => ({ s: +((p.t - inc.startedAt) / 1000).toFixed(1), inlet: inc.measurementScope === 'BOTH' ? p.i * 1000 : null, house: p.ih != null ? p.ih * 1000 : null, lamp: p.il != null ? p.il * 1000 : null }))
  return (
    <Frame id={`LIVE-${inc.id}`} kind={`마을 모형 직류 계측 · ${inc.source === 'MOCK' ? '시뮬레이터' : '실측 장치'}`} title={inc.title}>
      <Block no={1} title="요약">
        <p>{dt(inc.startedAt)}에 고장표시가 발생했고, {inc.clearedAt ? `${secs(inc.clearedAt - inc.startedAt)} 만에 복구됐어요` : '보고서 작성 시점까지 복구되지 않았어요'}. 처리 단계는 <b>{STAGE_LABEL[inc.stage]}</b>, 담당자는 <b>{inc.assignee ?? '미지정'}</b>입니다.</p>
      </Block>
      <Block no={2} title="고장 구간">
        <p><b>{cand?.section ?? '구간을 좁히지 못함 (판단 보류)'}</b>{cand && ` · ${cand.boundary} · 영향 고객 ${cand.customers}호`}</p>
        <SingleLineDiagram highlight={cand?.branches} fi={inc.fi} candidate={cand} />
      </Block>
      <Block no={3} title="고장 유형 · 고장표시">
        <table className="rp-table"><thead><tr><th>FRTU</th><th>고장표시</th></tr></thead>
          <tbody>{FRTUS.map((f) => <tr key={f.id}><td>{f.name}</td><td>{FI_SHORT[inc.fi[f.id]]}</td></tr>)}</tbody>
        </table>
      </Block>
      <Block no={4} title="원인 가설">
        <p>{inc.cause}</p>
        <p className="rp-note">계측값 규칙으로 낸 가설이에요. 분기 안의 어느 설비인지는 현장 점검으로 확인해야 해요.</p>
      </Block>
      <Block no={5} title="점검 목록">
        {cand ? (
          <ol className="rp-check">{cand.steps.map((s) => <li key={s.id}><span className="rp-box" />{s.label} <small>{s.detail}</small></li>)}</ol>
        ) : <p>점검 순서를 만들 근거가 없어요.</p>}
      </Block>
      <Block no={6} title="판단 근거">
        <ul>{inc.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <div className="rp-chart">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={data} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#e5e8ee" vertical={false} />
              <XAxis dataKey="s" type="number" domain={['dataMin', 'dataMax']} unit="s" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={40} />
              <ReferenceLine x={0} stroke="#d64545" strokeDasharray="4 3" />
              {inc.clearedAt && <ReferenceLine x={+((inc.clearedAt - inc.startedAt) / 1000).toFixed(1)} stroke="#1f9d55" strokeDasharray="4 3" />}
              <Line dataKey="inlet" name="인입" stroke="#2f6bff" dot={false} isAnimationActive={false} />
              <Line dataKey="house" name="주택 분기" stroke="#e08a1e" dot={false} isAnimationActive={false} connectNulls />
              <Line dataKey="lamp" name="가로등 분기" stroke="#24835a" dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
          <p className="rp-note">사건 전후 전류 (mA) · 파랑 인입, 주황 주택 분기, 초록 가로등 분기 · 빨간 선 발생, 초록 선 복구</p>
        </div>
      </Block>
      <Block no={7} title="처리 이력">
        <table className="rp-table"><thead><tr><th>단계</th><th>시각</th><th>처리자</th></tr></thead>
          <tbody>{inc.stageLog.map((l, k) => <tr key={k}><td>{STAGE_LABEL[l.stage]}</td><td>{dt(l.at)}</td><td>{l.by}</td></tr>)}</tbody>
        </table>
        {inc.caseId && <p>등록한 사건: <Link to={`/cases/${inc.caseId}`}>{inc.caseId}</Link></p>}
      </Block>
      <Block no={8} title="데이터 출처 · 한계">
        <p>{inc.measurementScope === 'HOUSE' ? '주택 분기 INA219 0x40 실측' : inc.measurementScope === 'BOTH' ? '주택·가로등 분기 INA219 두 개 및 합계 실측' : inc.measurementScope === 'LAMP' ? '가로등 분기 INA219 0x41 실측' : '센서 범위 미기록'}로 만든 직류 계측이에요. {inc.measurementScope === 'HOUSE' ? '가로등 전류는 측정하지 않았으며 주택 분기 안의 설비는 현장 점검이 필요합니다.' : inc.measurementScope === 'BOTH' ? '구간 안 설비는 현장 점검이 필요합니다.' : '측정하지 않은 분기의 상태를 판단하지 않습니다.'} 설비 정보는 모형 정보이며 실제 현장에서는 K-GIS 계통 추적 자료가 필요합니다.</p>
      </Block>
    </Frame>
  )
}

function CaseReport({ id }: { id: string }) {
  const [c, setC] = useState<AnyCase | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notes, setNotes] = useState<FieldNote[]>([])
  useEffect(() => {
    api.getCase(id).then((x) => {
      setC(x)
      if (x.caseType === 'WAVEFORM') listFieldNotes(x).then(setNotes)
    }).catch((e: Error) => setErr(e.message))
  }, [id])
  if (err) return <ErrorState message={err} />
  if (!c) return <PageSkeleton />
  if (c.caseType !== 'WAVEFORM') return <ErrorState message="IoT 사건은 실시간 사건 화면의 보고서를 쓰세요." />
  return <CaseBody c={c} notes={notes} />
}

function CaseBody({ c, notes }: { c: IncidentCase; notes: FieldNote[] }) {
  const ctx = buildIncidentContext(c)
  const a = ctx.analysis
  const groups = Object.entries(ctx.evidence.reduce<Record<string, typeof ctx.evidence>>((acc, e) => ((acc[e.group] ??= []).push(e), acc), {})) as [EvidenceGroup, typeof ctx.evidence][]
  const verdict = a.status === 'NONE' ? '분석 전' : a.status === 'COMPLETED' ? `${eventKo(a.label!)} · 모델 점수 ${formatModelScore(a.score)} (정답 확률 아님)` : '판단 보류'
  return (
    <Frame id={c.id} kind={`교류 고장파형 · ${SOURCE_LABEL[c.source.sourceType]}`} title={c.title}>
      {c.sync?.error && <p className="alert alert-warn">{c.sync.error}</p>}
      <Block no={1} title="요약">
        <p>{fmtTime(c.createdAt)}에 등록된 사건이에요. AI 판독 결과는 <b>{verdict}</b>, 입력 검사는 <b>{{ ACCEPTED: '통과', LIMITED: '제한 통과', REJECTED: '거부' }[ctx.diagnosis.status]}</b>, 담당자 검토는 <b>{ctx.reviews.length ? ctx.reviews.at(-1)!.verdict : '대기'}</b>입니다.</p>
      </Block>
      <Block no={2} title="고장 구간">
        <p><b>판단 보류</b> — 이 사건 자료에는 설비 위치·선로 구간 정보가 없어 특정 구간을 지목하지 않았어요.</p>
        <p className="rp-note">필요한 정보: 기록한 FRTU의 설치 위치와 담당 선로 구간 (K-GIS 등 전력 GIS의 계통 추적 결과), 같은 시각 인접 FRTU의 기록</p>
      </Block>
      <Block no={3} title="고장 유형">
        <p><b>{verdict}</b>{a.type ? ` · ${a.type}` : ''}</p>
        {a.ranking.length > 0 && <p className="rp-note">유형별 모델 점수 (정답 확률 아님): {a.ranking.map((r) => `${r.label} ${r.score.toFixed(2)}`).join(' / ')}</p>}
        {a.reasons.length > 0 && <p>보류·주의 사유: {a.reasons.join(' · ')}</p>}
      </Block>
      <Block no={4} title="원인 가설">
        <p><b>판단 보류</b> — 수목 접촉·절연 파괴 같은 물리적 원인은 이 AI의 분석 범위 밖이에요. 현장 점검 결과로 확정해야 해요.</p>
      </Block>
      <Block no={5} title="점검 목록">
        <ol className="rp-check">
          {(a.neededInfo.length ? a.neededInfo : ['기록한 FRTU 설치 위치·담당 구간 확인', '같은 시각 인접 FRTU 기록 확인', '현장 점검 후 원인 기록']).map((n) => <li key={n}><span className="rp-box" />{n}</li>)}
        </ol>
      </Block>
      <Block no={6} title="판단 근거">
        {groups.map(([g, items]) => (
          <div key={g} className="rp-ev"><h3>{EVIDENCE_GROUP_LABEL[g]}</h3>
            <table className="rp-table"><tbody>{items.map((e) => <tr key={e.id}><td>{e.label}</td><td>{e.value}</td></tr>)}</tbody></table>
          </div>
        ))}
      </Block>
      <Block no={7} title="현장 메모 · 담당자 검토">
        {notes.length === 0 && ctx.reviews.length === 0 && <p>아직 현장 메모와 검토가 없어요.</p>}
        {notes.length > 0 && <ul>{notes.map((n) => <li key={n.id}>{n.text} <small>— {n.actor}, {fmtTime(n.at)}</small></li>)}</ul>}
        {ctx.reviews.length > 0 && <ul>{ctx.reviews.map((r, k) => <li key={k}>{r.reviewer}: {r.verdict}{r.finalJudgment ? ` — ${r.finalJudgment}` : ''} <small>({fmtTime(r.at)})</small></li>)}</ul>}
      </Block>
      <Block no={8} title="데이터 출처 · 한계">
        <p>{SOURCE_LABEL[c.source.sourceType]}{c.source.datasetId ? ` · ${c.source.datasetId}` : ''} · {c.source.samplingRateHz} Hz · 계통 {c.source.systemFrequencyHz} Hz · 모델 {ctx.model.version ?? '미실행'}. {ctx.model.limitations[0] ?? ''}</p>
        <p>입력 채널: {c.source.channelOrder.join(', ')}. {c.source.labelMeaning}</p>
        {ctx.model.country === 'CN' && <p>CN 모델은 정상·개폐 사건을 학습하지 않아 정상/고장 여부를 확정하는 용도로 사용할 수 없습니다.</p>}
        {ctx.model.country === 'RU' && <p>RU 모델은 OscGrid의 NORMAL/SWITCHING/ABNORMAL/FAULT 분류입니다. 한국 현장의 검증 결과는 포함되지 않습니다.</p>}
      </Block>
    </Frame>
  )
}
