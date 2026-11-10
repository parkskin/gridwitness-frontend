import { frtuViews } from '../lib/frtu'
import { buildIncidentContext, EVIDENCE_GROUP_LABEL, eventKo, type EvidenceGroup } from '../lib/incidentContext'
import { STATUS_LABEL, useVillage } from '../lib/village'
import type { IncidentCase } from '../types'
import { LiveFrtuWaveAnalysis } from './FrtuWaveAnalysis'
import { NODE_TONE, Status } from './ui'

/** AI 도우미 전체화면 왼쪽: 마을 FRTU 실시간 계측 (대화하면서 값을 같이 봄) */
export function VillageLiveSide() {
  const snap = useVillage()
  const f = frtuViews(snap).inlet
  return (
    <div className="ga-side-inner">
      <div className="ga-side-head">
        <div>
          <span className="ga-side-kicker">실시간 · 0.5초 간격</span>
          <h2>마을 FRTU 파형 분석</h2>
        </div>
        <Status tone={f.fi !== 'NONE' ? 'err' : NODE_TONE[f.status]} live={f.fi !== 'NONE'}>{STATUS_LABEL[f.status]}</Status>
      </div>
      <LiveFrtuWaveAnalysis stacked compact />
    </div>
  )
}

/** AI 도우미 전체화면 왼쪽: 지금 묻고 있는 사건의 분석 근거 요약 (대화가 쓰는 것과 같은 근거) */
export function CaseBriefSide({ c }: { c: IncidentCase }) {
  const ctx = buildIncidentContext(c)
  const a = ctx.analysis
  const groups = Object.entries(
    ctx.evidence.reduce<Record<string, typeof ctx.evidence>>((acc, e) => ((acc[e.group] ??= []).push(e), acc), {}),
  ) as [EvidenceGroup, typeof ctx.evidence][]
  const last = ctx.reviews[ctx.reviews.length - 1]
  return (
    <div className="ga-side-inner">
      <div className="ga-side-head">
        <div>
          <span className="ga-side-kicker mono">{c.id}</span>
          <h2>{c.title}</h2>
        </div>
      </div>
      <div className="ga-stats three">
        <div><span>AI 결과</span><strong className={a.status === 'COMPLETED' ? '' : 'warn'}>{a.status === 'NONE' ? '분석 전' : a.status === 'COMPLETED' ? eventKo(a.label!) : '판단 보류'}</strong></div>
        <div><span>입력 검사</span><strong className={ctx.diagnosis.status === 'ACCEPTED' ? '' : ctx.diagnosis.status === 'LIMITED' ? 'warn' : 'err'}>{{ ACCEPTED: '통과', LIMITED: '제한', REJECTED: '거부' }[ctx.diagnosis.status]}</strong></div>
        <div><span>담당자 검토</span><strong>{last ? last.verdict : '대기'}</strong></div>
      </div>
      <div className="ga-evidence">
        {groups.map(([g, items]) => (
          <section key={g}>
            <h3>{EVIDENCE_GROUP_LABEL[g]}</h3>
            <dl>{items.map((e) => <div key={e.id}><dt>{e.label}</dt><dd>{e.value}</dd></div>)}</dl>
          </section>
        ))}
      </div>
    </div>
  )
}
