import { useEffect, useState, type FormEvent } from 'react'
import { fmtTime, getActor } from '../lib/actor'
import { APPROVAL_LABEL, APPROVAL_TONE, approvalLog, approvalStatus, approveCase, cannotApprove, rejectCase, useApprovals, type ApprovalEntry } from '../lib/approval'
import type { AnyCase } from '../types'
import { Badge, Section } from './ui'

const STEPS = ['등록', '분석', '담당자 검토', '최종 승인', '확정'] as const

/** 사건 상태 배지 (확정 / 승인 대기 / 반려 …) */
export function ApprovalBadge({ c }: { c: AnyCase }) {
  const s = useApprovals()
  const status = approvalStatus(c, approvalLog(s, c.id))
  return <Badge tone={APPROVAL_TONE[status]}>{APPROVAL_LABEL[status]}</Badge>
}

const ENTRY_LABEL: Record<ApprovalEntry['decision'], string> = { APPROVED: '승인 · 확정', REJECTED: '반려', RESUBMITTED: '검토 다시 제출' }

/** 최종 승인: 검토와 다른 사람이 최종 원인을 확정하거나 반려. 확정 후에는 재검토 요청으로만 다시 열 수 있음 */
export default function ApprovalPanel({ c }: { c: AnyCase }) {
  const s = useApprovals()
  const log = approvalLog(s, c.id)
  const status = approvalStatus(c, log)
  const latest = c.reviews[c.reviews.length - 1]
  const approved = status === 'APPROVED' ? log[log.length - 1] : null
  const [approver, setApprover] = useState(getActor)
  const [cause, setCause] = useState(latest?.finalJudgment ?? '')
  // 새 검토가 들어오면 그 최종 판단으로 채움
  useEffect(() => { setCause(latest?.finalJudgment ?? '') }, [latest?.reviewedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  const [comment, setComment] = useState('')
  const [mode, setMode] = useState<'approve' | 'reject'>('approve')
  const [error, setError] = useState<string | null>(null)
  const blocked = cannotApprove(c, log, approver)
  const stepAt = status === 'APPROVED' ? 5 : status === 'PENDING_APPROVAL' ? 3 : status === 'NEEDS_REVIEW' ? (c.stage === 'REGISTERED' || c.stage === 'DIAGNOSED' ? 1 : 2) : 2

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    // 확정된 사건에서는 이 양식이 재검토 요청이 됨
    if (mode === 'approve' && status !== 'APPROVED') {
      if (blocked) return setError(blocked)
      if (!cause.trim()) return setError('확정할 최종 원인을 적어 주세요.')
      approveCase(c.id, approver, cause, comment)
    } else {
      if (!approver.trim()) return setError('이름을 적어 주세요.')
      if (!comment.trim()) return setError(status === 'APPROVED' ? '재검토를 요청하는 이유를 적어 주세요.' : '반려 사유를 적어 주세요.')
      rejectCase(c.id, approver, comment)
    }
    setComment('')
  }

  return (
    <Section
      title="최종 승인"
      description="검토한 사람과 다른 사람이 최종 원인을 확정해요. 확정되기 전의 AI 결과와 검토는 참고 자료이고, 확정된 사건만 사고 기록과 AI 학습 데이터로 써요."
      actions={<Badge tone={APPROVAL_TONE[status]}>{APPROVAL_LABEL[status]}</Badge>}
    >
      <ol className="approval-steps" style={{ display: 'flex', gap: 6, listStyle: 'none', padding: 0, margin: '0 0 14px', flexWrap: 'wrap' }}>
        {STEPS.map((label, k) => (
          <li key={label} style={{ flex: '1 1 0', minWidth: 90, padding: '8px 10px', borderRadius: 10, fontSize: 13, fontWeight: 600, background: k < stepAt ? 'var(--ok-tint)' : k === stepAt ? 'var(--warn-tint)' : 'var(--fill)', color: k < stepAt ? '#135c34' : k === stepAt ? '#6a3a00' : 'var(--muted)' }}>
            <span className="num" style={{ marginRight: 6, opacity: 0.7 }}>{k + 1}</span>{label}
          </li>
        ))}
      </ol>

      {approved ? (
        <div className="alert alert-ok" style={{ margin: '0 0 12px' }}>
          <span>
            <strong>확정된 사건이에요.</strong> 최종 원인: <b>{approved.finalCause}</b>
            <br />승인 {approved.by} · {fmtTime(approved.at)} (검토 {latest?.reviewer ?? '—'}){approved.comment ? ` · ${approved.comment}` : ''}
          </span>
        </div>
      ) : status === 'REJECTED' ? (
        <div className="alert alert-err" style={{ margin: '0 0 12px' }}>
          <span><strong>반려됐어요.</strong> {log[log.length - 1].comment} ({log[log.length - 1].by}) — 위에서 검토를 다시 남기면 승인 대기로 돌아가요.</span>
        </div>
      ) : (
        <div className="alert alert-warn" style={{ margin: '0 0 12px' }}>
          <span><strong>아직 확정되지 않았어요.</strong> {status === 'PENDING_APPROVAL' ? `검토(${latest.reviewer})가 끝났어요. 다른 사람이 승인하면 확정돼요.` : status === 'INVESTIGATING' ? '추가 조사가 끝난 뒤 검토를 다시 남겨야 승인할 수 있어요.' : '담당자 검토가 먼저 필요해요.'}</span>
        </div>
      )}

      {(status === 'PENDING_APPROVAL' || status === 'APPROVED') && (
        <form className="form no-print" onSubmit={submit} style={{ maxWidth: 640 }}>
          {status === 'PENDING_APPROVAL' && (
            <div className="row gap" role="tablist">
              <button type="button" className={`btn btn-sm ${mode === 'approve' ? 'btn-primary' : ''}`} onClick={() => setMode('approve')}>승인</button>
              <button type="button" className={`btn btn-sm ${mode === 'reject' ? 'btn-primary' : ''}`} onClick={() => setMode('reject')}>반려</button>
            </div>
          )}
          <label className="field">
            {status === 'APPROVED' ? '요청자' : '승인자'} {status !== 'APPROVED' && <span className="field-hint">검토한 사람({latest?.reviewer ?? '—'})과 달라야 해요</span>}
            <input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="이름" />
          </label>
          {status === 'PENDING_APPROVAL' && mode === 'approve' && (
            <label className="field">
              최종 원인 <span className="field-hint">담당자 검토의 최종 판단을 그대로 쓰거나 고쳐서 확정</span>
              <textarea rows={2} value={cause} onChange={(e) => setCause(e.target.value)} />
            </label>
          )}
          <label className="field">
            {status === 'APPROVED' ? '재검토 요청 사유' : mode === 'approve' ? '승인 의견' : '반려 사유'}
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={status === 'APPROVED' ? '확정된 원인을 다시 봐야 하는 이유' : mode === 'approve' ? '선택' : '무엇을 다시 확인해야 하는지'} />
          </label>
          {mode === 'approve' && status === 'PENDING_APPROVAL' && blocked && <div className="alert alert-warn small" style={{ margin: 0 }}>{blocked}</div>}
          {error && <div className="alert alert-err small" style={{ margin: 0 }}>{error}</div>}
          <div className="row gap">
            {status === 'APPROVED' ? (
              <button className="btn">재검토 요청</button>
            ) : (
              <button className="btn btn-primary" disabled={mode === 'approve' && !!blocked}>{mode === 'approve' ? '승인하고 확정' : '반려'}</button>
            )}
          </div>
        </form>
      )}

      {log.length > 0 && (
        <ol className="timeline" style={{ marginTop: 14 }}>
          {log.map((e, i) => (
            <li key={i}>
              <time>{fmtTime(e.at)}</time>
              <div>
                <strong className="strong">{e.decision === 'REJECTED' && log[i - 1]?.decision === 'APPROVED' ? '재검토 요청' : ENTRY_LABEL[e.decision]}</strong> <span className="muted small">{e.by}</span>
                {e.finalCause && <div className="small">최종 원인: {e.finalCause}</div>}
                {e.comment && <div className="small muted">{e.comment}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}
