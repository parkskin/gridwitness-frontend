import { ApprovalBadge } from './ApprovalPanel'
import { useState } from 'react'
import { api } from '../api'
import { getVillageRecordState, retryVillageRecords, useVillagePersistence } from '../api/village'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CHART } from '../lib/chart'
import { fmtTime } from '../lib/actor'
import { STATUS_LABEL, THRESHOLDS } from '../lib/village'
import type { AnyCase, IotCase } from '../types'
import { DiagnosisBadge, Steps } from './Badges'
import FrtuWaveAnalysis, { similarOf, verdictInfo } from './FrtuWaveAnalysis'
import IssueList from './IssueList'
import { useVillageEvents } from '../lib/villageEvents'
import ReviewPanel from './ReviewPanel'
import { Badge, Metric, Metrics, NODE_TONE, PageHeader, Section, Status } from './ui'

type Tab = 'record' | 'detection' | 'review'

const STEPS = ['이상 감지', '계측 기록', '데이터 점검', '이상 점수', '사람 검토']

export default function IotCaseView({ c, onChange }: { c: IotCase; onChange: (c: AnyCase) => void }) {
  const [tab, setTab] = useState<Tab>('record')
  const persistence = useVillagePersistence()
  const [syncError, setSyncError] = useState<string | null>(null)
  const stored = getVillageRecordState(c.id)
  const d = c.detection
  // 이 사건 기록 구간(앞뒤 5초 포함)에 장치가 보낸 사건 녹화가 있으면 그 AI 판정을 같이 보여 줌
  const events = useVillageEvents()
  const from = (c.window[0]?.t ?? 0) - 5000
  const to = (c.window[c.window.length - 1]?.t ?? 0) + 5000
  const matched = events.find((a) => { const t = Date.parse(a.e.receivedAt); return t >= from && t <= to })
  const t0 = c.window[0]?.t ?? 0
  const data = c.window.map((p) => ({
    s: +((p.t - t0) / 1000).toFixed(1),
    v: +p.v.toFixed(2),
    i: +p.i.toFixed(3),
    expected: +p.expected.toFixed(3),
    score: +p.score.toFixed(2),
  }))
  const axis = { tick: CHART.tick, axisLine: CHART.axisLine, tickLine: CHART.tickLine }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '스마트 마을', to: '/village' }, { label: c.id }]}
        title={c.title}
        meta={
          <>
            <span className="mono">{c.id}</span>
            <Badge outline>IoT 이상 이벤트</Badge>
            <DiagnosisBadge status={c.diagnosis.status} />
            <ApprovalBadge c={c} />
            <span className="num">{fmtTime(c.createdAt)}</span>
          </>
        }
        actions={<button className="btn no-print" onClick={() => window.print()}>PDF로 내보내기</button>}
      />
      <div className="small muted">{stored === 'server' || (stored === 'missing' && c.persistence === 'server') ? '서버에 사건·검토 보존 완료' : stored === 'memory' ? '브라우저 저장 실패 · 이 탭에서만 유지' : '브라우저 보존 · 서버 전송 대기'} <button type="button" className="btn btn-sm no-print" disabled={persistence.syncing} onClick={() => { setSyncError(null); void retryVillageRecords().then(() => api.getCase(c.id)).then(onChange).catch((e: Error) => setSyncError(e.message)) }}>서버 저장 재시도</button></div>
      {(syncError || c.sync?.error || persistence.error) && <div className="alert alert-warn small" role="status">{syncError ?? c.sync?.error ?? persistence.error}</div>}
      <Steps steps={STEPS} done={c.stage === 'REVIEWED' ? 5 : 4} />

      <div className="tabs no-print" role="tablist">
        {([['record', '계측 기록'], ['detection', '이상 탐지 결과'], ['review', '검토·이력']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div key={tab} className="tab-panel">
        {tab === 'record' && (
          <>
            <Section title="FRTU 파형 분석" description={`${c.device.scope} · 릴레이 ${c.device.relayOn ? '켜짐' : '차단'} 상태에서 예상 ${c.device.expectedA.toFixed(2)} A`}>
              <FrtuWaveAnalysis
                points={c.window}
                sourceText={c.device.sensor}
                verdict={verdictInfo(matched)}
                similar={similarOf(events, matched)}
                rule={{ label: `${STATUS_LABEL[d.status]} · 최대 이상 점수 ${d.maxScore.toFixed(2)}`, lines: d.findings }}
                onReview={() => setTab('review')}
              />
            </Section>
            <div className="grid-2 section">
              <Section title="장치">
                <dl className="dl-rows">
                  <div><dt>장치</dt><dd className="mono">{c.device.deviceId}</dd></div>
                  <div><dt>센서</dt><dd>{c.device.sensor}</dd></div>
                  <div><dt>측정 범위</dt><dd>{c.device.scope}</dd></div>
                  <div><dt>정격</dt><dd>{c.device.nominalV} V DC</dd></div>
                  <div><dt>시뮬레이션 주입</dt><dd>{c.device.faultInjected ?? '없음'}</dd></div>
                </dl>
              </Section>
              <Section title="데이터 점검">
                <IssueList issues={c.diagnosis.issues} />
              </Section>
            </div>
          </>
        )}

        {tab === 'detection' && (
          <>
            <Metrics>
              <Metric label="판정" value={<Status tone={NODE_TONE[d.status]}><span style={{ fontSize: 20, fontWeight: 600 }}>{STATUS_LABEL[d.status]}</span></Status>} />
              <Metric label="최대 이상 점수" value={d.maxScore.toFixed(2)} foot={`주의 ≥ ${THRESHOLDS.warn} · 이상 ≥ ${THRESHOLDS.fault}`} />
              <Metric label="최대 잔차" value={d.maxResidualA.toFixed(2)} unit="A" foot="|실제 − 예상|" />
              <Metric label="최저 전압" value={d.minV.toFixed(2)} unit="V" />
            </Metrics>
            <Section title="이상 점수 추이">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="s" unit="s" type="number" domain={['dataMin', 'dataMax']} {...axis} />
                  <YAxis domain={[0, 1]} {...axis} width={52} />
                  <Tooltip />
                  <ReferenceLine y={THRESHOLDS.warn} stroke={CHART.warn} strokeDasharray="3 4" label={{ value: '주의', fontSize: 11, fill: CHART.warn, position: 'insideTopLeft' }} />
                  <ReferenceLine y={THRESHOLDS.fault} stroke={CHART.err} strokeDasharray="3 4" label={{ value: '이상', fontSize: 11, fill: CHART.err, position: 'insideTopLeft' }} />
                  <Line dataKey="score" name="이상 점수" stroke={CHART.ink} dot={false} strokeWidth={1.75} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </Section>
            <Section title="근거">
              <ul>{d.findings.map((f) => <li key={f}>{f}</li>)}</ul>
              <div className="alert alert-warn" style={{ marginTop: 16 }}>
                <div>
                  <strong>함께 확인할 제한사항</strong>
                  <ul>{d.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
              </div>
              <dl className="kv small">
                <div><dt>모델</dt><dd className="mono">{d.model}</dd></div>
                <div><dt>실행 시각</dt><dd className="num">{fmtTime(d.executedAt)}</dd></div>
              </dl>
            </Section>
          </>
        )}

        {tab === 'review' && (
          <ReviewPanel
            c={c}
            onChange={onChange}
            aiSummary={
              <>
                <span className="pred-sm">{STATUS_LABEL[d.status]}</span> <span className="muted num">점수 {d.maxScore.toFixed(2)}</span>
                <div className="xs muted mono">{d.model}</div>
              </>
            }
          />
        )}
      </div>
    </>
  )
}
