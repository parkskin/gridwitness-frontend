import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import { fmtTime, getActor } from '../lib/actor'
import { approvalLog, approvalStatus, noteReviewAdded, useApprovals } from '../lib/approval'
import ApprovalPanel from './ApprovalPanel'
import { VERDICT_LABEL, type AnyCase, type Review } from '../types'
import { Badge, Section, Segmented } from './ui'

const VERDICT_TONE: Record<Review['verdict'], 'ok' | 'warn' | 'accent'> = { AGREE: 'ok', DISAGREE: 'warn', NEEDS_INVESTIGATION: 'accent' }

/** 사람 검토 — AI 출력과 사람 판단을 분리해 기록 (사건 유형 공통) */
export default function ReviewPanel({ c, aiSummary, onChange, locked }: { c: AnyCase; aiSummary: ReactNode; onChange: (c: AnyCase) => void; /** 검토를 막는 이유 */ locked?: ReactNode }) {
  const [verdict, setVerdict] = useState<Review['verdict']>('AGREE')
  const [finalJudgment, setFinal] = useState('')
  const [additionalInvestigation, setInv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const latest = c.reviews[c.reviews.length - 1]
  const approvals = useApprovals()
  // 확정된 사건은 검토를 더 받지 않음 (재검토 요청으로 다시 열어야 함)
  const lockedByApproval = approvalStatus(c, approvalLog(approvals, c.id)) === 'APPROVED'
    ? '최종 승인으로 확정된 사건이라 검토를 추가할 수 없어요. 고쳐야 하면 아래 최종 승인에서 재검토를 요청해 주세요.'
    : null

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const reviewer = getActor()
      onChange(await api.submitReview(c.id, { reviewer, verdict, finalJudgment, additionalInvestigation }))
      noteReviewAdded(c.id, reviewer)
      setFinal('')
      setInv('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2400)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="review-cols">
        <div>
          <h3>AI 결과 · 원본 보존</h3>
          {aiSummary}
        </div>
        <div>
          <h3>검토 의견 {c.reviews.length > 0 && <span className="count">{c.reviews.length}</span>}</h3>
          {c.reviews.length === 0 && <span className="muted">아직 없음</span>}
          {c.reviews.map((r) => (
            <div key={r.reviewedAt} className="review-item">
              <Badge tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Badge>
              <div className="xs muted num" style={{ marginTop: 4 }}>{r.reviewer} · {fmtTime(r.reviewedAt)}</div>
              {r.additionalInvestigation && <div className="small" style={{ marginTop: 2 }}>추가 조사: {r.additionalInvestigation}</div>}
            </div>
          ))}
        </div>
        <div>
          <h3>최종 판단 · 사람</h3>
          {latest?.finalJudgment ? <span>{latest.finalJudgment}</span> : <span className="muted">아직 없음</span>}
          <div className="xs muted" style={{ marginTop: 4 }}>최종 승인 전에는 확정이 아니에요</div>
        </div>
      </div>

      {locked || lockedByApproval ? (
        <Section title="검토 기록 추가">
          <div className="alert alert-warn" style={{ margin: 0 }}><span>{locked ?? lockedByApproval}</span></div>
        </Section>
      ) : (
        <Section title="검토 기록 추가" description="AI 결과는 바뀌지 않고, 사람의 판단이 별도로 쌓입니다.">
          <form className="form no-print" onSubmit={submit} style={{ maxWidth: 640 }}>
            <div className="field">
              AI 결과에 대한 판단
              <Segmented value={verdict} onChange={setVerdict} options={(Object.keys(VERDICT_LABEL) as Review['verdict'][]).map((v) => ({ value: v, label: VERDICT_LABEL[v] }))} />
            </div>
            <label className="field">
              최종 판단
              <textarea rows={2} value={finalJudgment} onChange={(e) => setFinal(e.target.value)} placeholder="AI 결과와 별개로 담당자가 내린 판단" />
            </label>
            <label className="field">
              추가 조사 <span className="field-hint">현장 조사, 설비 이력 확인 등</span>
              <textarea rows={2} value={additionalInvestigation} onChange={(e) => setInv(e.target.value)} />
            </label>
            {error && <div className="alert alert-err">{error}</div>}
            <div className="row gap">
              <button className="btn btn-primary" disabled={busy}>{busy ? '저장 중…' : '검토 저장'}</button>
              {saved && <span className="small" style={{ color: 'var(--ok)' }} role="status">저장했습니다</span>}
            </div>
          </form>
        </Section>
      )}

      <ApprovalPanel c={c} />

      <Section title="실행 이력" description="원본 등록부터 검토까지 이 사건에서 일어난 일">
        <ol className="timeline">
          {c.history.map((h, i) => (
            <li key={i}>
              <time>{fmtTime(h.at)}</time>
              <div>
                <strong className="strong">{h.action}</strong> <span className="muted small">{h.actor}</span>
                {h.detail && <div className="small muted">{h.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </>
  )
}
