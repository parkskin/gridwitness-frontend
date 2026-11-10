// 사건 기록 최종 승인. 검토(사람 판단)가 끝난 사건을 다른 사람이 한 번 더 확인해야 '확정'된다.
// 서버에 승인 API가 아직 없어 이 브라우저(localStorage)에 저장한다. 서버 연결 시 같은 모양으로 옮긴다.
import { useSyncExternalStore } from 'react'
import type { AnyCase, CaseSummary, Review } from '../types'

const KEY = 'gridwitness.approvals.v1'

export type ApprovalDecision = 'APPROVED' | 'REJECTED' | 'RESUBMITTED'

export interface ApprovalEntry {
  decision: ApprovalDecision
  /** 승인·반려한 사람 (재제출은 검토자) */
  by: string
  at: string
  /** 승인할 때 확정한 최종 원인 */
  finalCause?: string
  /** 의견 또는 반려 사유 */
  comment?: string
}

export type ApprovalStatus = 'NEEDS_REVIEW' | 'INVESTIGATING' | 'PENDING_APPROVAL' | 'REJECTED' | 'APPROVED'

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  NEEDS_REVIEW: '검토 대기',
  INVESTIGATING: '추가 조사 중',
  PENDING_APPROVAL: '승인 대기',
  REJECTED: '반려 · 재검토',
  APPROVED: '확정',
}

export const APPROVAL_TONE: Record<ApprovalStatus, 'neutral' | 'accent' | 'warn' | 'err' | 'ok'> = {
  NEEDS_REVIEW: 'neutral',
  INVESTIGATING: 'accent',
  PENDING_APPROVAL: 'warn',
  REJECTED: 'err',
  APPROVED: 'ok',
}

type Store = Record<string, ApprovalEntry[]>

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Store
  } catch {
    return {}
  }
}
let store: Store = read()
const listeners = new Set<() => void>()
function write(next: Store) {
  store = next
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // 저장 불가 환경은 이 탭에서만 유지
  }
  listeners.forEach((l) => l())
}
if (typeof window !== 'undefined') {
  // 다른 탭에서 승인해도 바로 반영
  window.addEventListener('storage', (e) => { if (e.key === KEY) { store = read(); listeners.forEach((l) => l()) } })
}

export function useApprovals(): Store {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => store)
}
export const approvalLog = (s: Store, id: string): ApprovalEntry[] => s[id] ?? []

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** 사건 상세에서 쓰는 상태 (검토 내용까지 보고 정함) */
export function approvalStatus(c: AnyCase, log: ApprovalEntry[]): ApprovalStatus {
  const last = log[log.length - 1]
  if (last?.decision === 'APPROVED') return 'APPROVED'
  if (c.reviews.length === 0) return 'NEEDS_REVIEW'
  if (last?.decision === 'REJECTED') return 'REJECTED'
  if (c.reviews[c.reviews.length - 1].verdict === 'NEEDS_INVESTIGATION') return 'INVESTIGATING'
  return 'PENDING_APPROVAL'
}

/** 목록에서 쓰는 상태 (목록에는 검토 내용이 없어 단계로만 판단) */
export function summaryStatus(c: CaseSummary, log: ApprovalEntry[]): ApprovalStatus {
  const last = log[log.length - 1]
  if (last?.decision === 'APPROVED') return 'APPROVED'
  if (c.stage !== 'REVIEWED') return 'NEEDS_REVIEW'
  if (last?.decision === 'REJECTED') return 'REJECTED'
  return 'PENDING_APPROVAL'
}

/** 승인할 수 없는 이유 (없으면 null) */
export function cannotApprove(c: AnyCase, log: ApprovalEntry[], approver: string): string | null {
  const status = approvalStatus(c, log)
  if (status === 'APPROVED') return '이미 확정된 사건이에요.'
  if (status === 'NEEDS_REVIEW') return '아직 검토 기록이 없어요. 담당자 검토를 먼저 남겨 주세요.'
  if (status === 'REJECTED') return '반려된 사건이에요. 검토를 다시 남기면 승인할 수 있어요.'
  if (status === 'INVESTIGATING') return '마지막 검토가 "추가 조사 필요"예요. 조사를 마친 뒤 검토를 다시 남겨 주세요.'
  if (!approver.trim()) return '승인자 이름을 적어 주세요.'
  const reviewer = (c.reviews[c.reviews.length - 1] as Review).reviewer
  if (same(reviewer, approver)) return `검토한 사람(${reviewer})은 스스로 승인할 수 없어요. 다른 사람이 승인해야 해요 (2인 확인).`
  return null
}

function push(id: string, entry: ApprovalEntry) {
  write({ ...store, [id]: [...(store[id] ?? []), entry] })
}

export function approveCase(id: string, by: string, finalCause: string, comment: string) {
  push(id, { decision: 'APPROVED', by: by.trim(), at: new Date().toISOString(), finalCause: finalCause.trim(), comment: comment.trim() || undefined })
}

/** 반려(승인 전) 또는 재검토 요청(확정 후). 사유 필수 */
export function rejectCase(id: string, by: string, reason: string) {
  push(id, { decision: 'REJECTED', by: by.trim(), at: new Date().toISOString(), comment: reason.trim() })
}

/** 반려된 사건에 검토가 다시 남으면 승인 대기로 되돌림 */
export function noteReviewAdded(id: string, by: string) {
  const log = store[id] ?? []
  if (log[log.length - 1]?.decision === 'REJECTED') push(id, { decision: 'RESUBMITTED', by, at: new Date().toISOString() })
}
