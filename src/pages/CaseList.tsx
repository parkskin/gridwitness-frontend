import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { DiagnosisBadge } from '../components/Badges'
import { IconAnalysis, IconPlus } from '../components/Icons'
import ModelCardPanel from '../components/ModelCardPanel'
import { Badge, Empty, ErrorState, PageHeader, Segmented, TableSkeleton } from '../components/ui'
import { fmtTime } from '../lib/actor'
import { API_CHANGED_EVENT } from '../lib/backend'
import { APPROVAL_LABEL, APPROVAL_TONE, approvalLog, summaryStatus, useApprovals, type ApprovalStatus } from '../lib/approval'
import type { CaseSummary } from '../types'

type Filter = 'ALL' | ApprovalStatus
const FILTER_LABEL: Record<Exclude<Filter, 'INVESTIGATING'>, string> = { ALL: '전체', NEEDS_REVIEW: '검토 대기', PENDING_APPROVAL: '승인 대기', REJECTED: '반려', APPROVED: '확정' }
type Kind = 'ALL' | 'WAVEFORM' | 'IOT'
const KIND_LABEL: Record<Kind, string> = { ALL: '모든 사건', WAVEFORM: '고장파형', IOT: '마을 FRTU' }

/** 사건 기록: 고장파형 사건과 마을 FRTU 사건(이상 감지 시 자동 등록)을 함께 보여 줌. 종류·검토 상태별로 걸러 볼 수 있음 */
export default function CaseList() {
  const nav = useNavigate()
  const [cases, setCases] = useState<CaseSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [kind, setKind] = useState<Kind>('ALL')
  const load = useCallback(() => {
    setError(null)
    api.listCases().then((all) => setCases(all)).catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    load()
    const refresh = () => { if (!document.hidden) load() }
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    window.addEventListener(API_CHANGED_EVENT, load)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener(API_CHANGED_EVENT, load) }
  }, [load])

  const approvals = useApprovals()
  const statusOf = (c: CaseSummary) => summaryStatus(c, approvalLog(approvals, c.id))
  const match = (c: CaseSummary, f: Filter) => (kind === 'ALL' || c.caseType === kind) && (f === 'ALL' || statusOf(c) === f)
  const shown = cases?.filter((c) => match(c, filter))
  const count = (f: Filter) => cases?.filter((c) => match(c, f)).length ?? 0
  const pathOf = (c: CaseSummary) => `/cases/${c.id}`

  return (
    <>
      <PageHeader
        title="사건 기록"
        description="지금까지의 사고를 정리하는 기록이에요. 사건은 등록 → 분석 → 담당자 검토 → 다른 사람의 최종 승인을 거쳐야 확정되고, 확정된 사건만 사고 기록과 AI 학습 데이터로 씁니다."
        actions={
          <Link to="/cases/new" className="btn btn-primary">
            <IconPlus />
            고장파형 등록
          </Link>
        }
      />
      {cases?.some((c) => c.sync?.error) && <div className="alert alert-warn" role="status">{cases.find((c) => c.sync?.error)?.sync?.error} <button className="btn btn-sm" onClick={load}>다시 불러오기</button></div>}

      <div className="row gap" style={{ marginBottom: 10 }}>
        <Segmented value={kind} onChange={setKind} options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: `${KIND_LABEL[k]} ${cases ? (k === 'ALL' ? cases.length : cases.filter((c) => c.caseType === k).length) : ''}` }))} />
      </div>
      <div className="tabs" role="tablist">
        {(Object.keys(FILTER_LABEL) as Exclude<Filter, 'INVESTIGATING'>[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]}
            <span className="count">{count(f)}</span>
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !shown ? (
        <TableSkeleton />
      ) : shown.length === 0 ? (
        <Empty
          icon={<IconAnalysis />}
          title={filter === 'ALL' ? '등록된 사건이 없습니다' : `${APPROVAL_LABEL[filter]} 사건이 없습니다`}
          description="CSV 파형을 올리면 해시를 남기고 입력 진단부터 시작합니다. 실제 공개 파형 샘플로 바로 시험해 볼 수도 있습니다."
          action={filter === 'ALL' ? <Link to="/cases/new" className="btn btn-primary">고장파형 등록</Link> : undefined}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>사건</th>
                <th>출처</th>
                <th>데이터 점검</th>
                <th>상태</th>
                <th className="num">등록</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(pathOf(c))}>
                  <td>
                    <Link to={pathOf(c)} className="strong" style={{ color: 'var(--ink)' }} onClick={(e) => e.stopPropagation()}>{c.title}</Link>
                    <div className="mono xs faint">{c.id}{c.needsWaveform && <> · <Badge tone="warn">원본 CSV 필요</Badge></>}</div>
                  </td>
                  <td className="muted"><Badge outline>{c.caseType === 'IOT' ? '마을 FRTU' : '고장파형'}</Badge> {c.source}</td>
                  <td><DiagnosisBadge status={c.diagnosisStatus} /></td>
                  <td><Badge tone={APPROVAL_TONE[statusOf(c)]}>{APPROVAL_LABEL[statusOf(c)]}</Badge></td>
                  <td className="num muted">{fmtTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="section">
        <ModelCardPanel />
      </div>
    </>
  )
}
