import { ApprovalBadge } from '../components/ApprovalPanel'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import AssistantChat from '../components/AssistantChat'
import FieldNotes from '../components/FieldNotes'
import { DiagnosisBadge, Steps, WAVEFORM_STEPS, waveformStepsDone } from '../components/Badges'
import FaultAnalysis from '../components/FaultAnalysis'
import IotCaseView from '../components/IotCaseView'
import IssueList from '../components/IssueList'
import ReviewPanel from '../components/ReviewPanel'
import TrustStrip from '../components/TrustStrip'
import { ErrorState, PageHeader, PageSkeleton, Section } from '../components/ui'
import { fmtTime, getActor } from '../lib/actor'
import { API_CHANGED_EVENT } from '../lib/backend'
import { needsWaveform, SOURCE_LABEL, type AnalysisType, type AnyCase, type ChannelFeatures, type IncidentCase } from '../types'

type Tab = 'analysis' | 'assistant' | 'diagnosis' | 'review' | 'source'
const TABS: [Tab, string][] = [
  ['analysis', '파형·AI 분석'],
  ['assistant', '현장 대응 AI'],
  ['diagnosis', '입력 진단'],
  ['review', '검토·이력'],
  ['source', '원본 정보'],
]

export default function CaseDetail() {
  const { id = '' } = useParams()
  const [c, setC] = useState<AnyCase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    setError(null)
    api.getCase(id).then(setC).catch((e: Error) => setError(e.message))
  }, [id])
  useEffect(() => {
    load()
    const refresh = () => { if (!document.hidden) load() }
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    window.addEventListener(API_CHANGED_EVENT, load)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener(API_CHANGED_EVENT, load) }
  }, [load])

  if (error) return <ErrorState message={error} onRetry={load} />
  if (!c) return <PageSkeleton />
  return c.caseType === 'IOT' ? <IotCaseView c={c} onChange={setC} /> : <WaveformCaseView c={c} onChange={setC} />
}

export function WaveformCaseView({ c, onChange }: { c: IncidentCase; onChange: (c: AnyCase) => void }) {
  const [tab, setTab] = useState<Tab>(c.diagnosis.status === 'REJECTED' ? 'diagnosis' : 'analysis')
  const ai = c.analysis
  const missing = needsWaveform(c)
  return (
    <>
      <PageHeader
        crumbs={[{ label: '고장파형 분석', to: '/cases' }, { label: c.id }]}
        title={c.title}
        meta={
          <>
            <span className="mono">{c.id}</span>
            <DiagnosisBadge status={c.diagnosis.status} />
            <ApprovalBadge c={c} />
            <span>{SOURCE_LABEL[c.source.sourceType]}</span>
            <span className="num">{fmtTime(c.createdAt)}</span>
          </>
        }
        actions={<><Link className="btn btn-primary no-print" to={`/report/case/${c.id}`}>사고조사 보고서</Link><button className="btn no-print" onClick={() => window.print()}>화면 인쇄</button></>}
      />
      <Steps steps={WAVEFORM_STEPS} done={waveformStepsDone(c.stage)} />
      <TrustStrip c={c} onGo={setTab} />
      {c.sync?.error && <div className="alert alert-warn" role="status">{c.sync.error}{c.sync.checkedAt && ` · 마지막 확인 ${fmtTime(c.sync.checkedAt)}`}</div>}
      {missing && (
        <div className="alert alert-warn no-print" style={{ marginTop: 20 }}>
          <span>
            <strong>서버에서 원본 파형을 불러오지 못했습니다.</strong> 다시 불러오거나 등록할 때 쓴 CSV를 연결하면 파형을 보고 분석·검토할 수 있습니다.{' '}
            {tab !== 'analysis' && <button className="btn btn-sm" onClick={() => setTab('analysis')}>원본 CSV 연결하기</button>}
          </span>
        </div>
      )}

      <div className="tabs no-print" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div key={tab} className="tab-panel">
        {tab === 'source' && <SourcePanel c={c} />}
        {tab === 'assistant' && (
          <Section
            title="현장 대응 AI"
            description="이 사건의 분석 결과·입력 적합성·모델 정보·검토 이력만 근거로 답해요. 기록에 없는 원인이나 위치는 판단을 보류하고, 설비는 조작하지 않아요."
            actions={<Link className="btn btn-sm" to={`/field/${c.id}`}>현장용 화면 열기</Link>}
          >
            <AssistantChat c={c} />
            <FieldNotes c={c} />
          </Section>
        )}
        {tab === 'diagnosis' && <DiagnosisPanel c={c} onNext={() => setTab('analysis')} />}
        {tab === 'analysis' && <AnalysisTab c={c} onChange={onChange} onReview={() => setTab('review')} />}
        {tab === 'review' && (
          <ReviewPanel
            c={c}
            onChange={onChange}
            locked={missing ? '원본 CSV를 연결해 파형을 확인한 뒤에 검토를 남길 수 있습니다. 파형·AI 분석 탭에서 원본 CSV를 선택하세요.' : undefined}
            aiSummary={
              !ai ? (
                <span className="muted">분석 기록 없음</span>
              ) : ai.kind === 'COMPLETED' ? (
                <>
                  <span className="pred-sm">{ai.predictedLabel}</span>
                  <div className="xs muted mono">{ai.modelVersion}</div>
                </>
              ) : (
                <>
                  <span className="pred-sm">판단 보류</span>
                  <div className="small muted">{ai.reasons[0]}</div>
                </>
              )
            }
          />
        )}
      </div>
    </>
  )
}

function SourcePanel({ c }: { c: IncidentCase }) {
  const s = c.source
  const rows: [string, React.ReactNode][] = [
    ['파일', s.fileName],
    ['크기', `${(s.fileSize / 1024).toFixed(1)} KB`],
    ['SHA-256', <span key="file-hash" className="mono break">{s.sha256}</span>],
    ['출처', SOURCE_LABEL[s.sourceType]],
    ['데이터셋 / 장비 ID', s.datasetId || '—'],
    ['채널 순서', s.channelOrder.join(', ')],
    ['샘플링', `${s.samplingRateHz} Hz`],
    ['계통 주파수', `${s.systemFrequencyHz} Hz`],
    ['라벨 의미', s.labelMeaning || '—'],
    ['원래 파일 해시', s.provenance?.originalSha256 ? <span key="original-hash" className="mono break">{s.provenance.originalSha256}</span> : '별도 원본 메타데이터 없음'],
    ['원본 파일', s.provenance?.originalFiles.map((f) => `${f.name} (${f.size.toLocaleString()} B · ${f.sha256.slice(0, 12)}…)`).join(' / ') || '—'],
    ['COMTRADE 기록 장치', s.comtrade ? `${s.comtrade.station} · ${s.comtrade.device} · ${s.comtrade.fileType} · ${s.comtrade.revYear}` : '해당 없음'],
    ['채널 매핑', s.comtrade ? Object.entries(s.comtrade.mapping).map(([ch, original]) => `${ch} ← ${original}`).join(' / ') : 'CSV 열 순서 사용'],
    ['등록 시각', fmtTime(c.createdAt)],
  ]
  return (
    <Section title="원본 기록" description="같은 사고를 다시 볼 때 어떤 자료로 분석했는지 확인할 수 있도록 보존합니다.">
      <dl className="dl-rows">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      {s.format === 'COMTRADE' && <p className="hint">위 SHA-256은 분석에 사용한 변환 CSV의 해시입니다. 원래 cfg/dat의 개별 해시와 채널 매핑은 별도로 보존합니다.</p>}
    </Section>
  )
}

const DIAG_SUMMARY = {
  ACCEPTED: ['ok', '분석 가능', '모델 학습 범위 안의 입력입니다. 지원하는 분석을 실행할 수 있습니다.'],
  LIMITED: ['warn', '분석 제한', '형식은 올바르지만 모델 학습 조건과 달라 결과를 내지 않고 보류합니다.'],
  REJECTED: ['err', '분석 불가', '형식 오류가 있어 분석하지 않습니다. 아래 수정 방법을 확인하세요.'],
} as const

function DiagnosisPanel({ c, onNext }: { c: IncidentCase; onNext: () => void }) {
  const d = c.diagnosis
  const [tone, head, body] = DIAG_SUMMARY[d.status]
  return (
    <>
      <div className={`verdict ${tone}`}>
        <span>
          <strong>{head}</strong> — {body}
        </span>
        <span className="spacer" />
        {d.status !== 'REJECTED' && <button className="btn btn-primary btn-sm" onClick={onNext}>AI 분석으로</button>}
      </div>
      <div className="stats">
        <div>행(샘플)<strong>{d.rows.toLocaleString()}</strong></div>
        <div>열(채널)<strong>{d.cols}</strong></div>
        <div>오류<strong>{d.issues.filter((i) => i.severity === 'error').length}</strong></div>
        <div>경고<strong>{d.issues.filter((i) => i.severity === 'warning').length}</strong></div>
      </div>
      {d.issues.length === 0 ? <p className="muted">발견된 문제가 없습니다.</p> : <IssueList issues={d.issues} />}
    </>
  )
}

function AnalysisTab({ c, onChange, onReview }: { c: IncidentCase; onChange: (c: AnyCase) => void; onReview: () => void }) {
  const [type, setType] = useState<AnalysisType>(c.analysis?.analysisType ?? 'EVENT_TYPE')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rejected = c.diagnosis.status === 'REJECTED' || !c.waveform

  async function run() {
    setBusy(true)
    setError(null)
    try {
      onChange(await api.runAnalysis(c.id, type, getActor()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!c.waveform) {
    return c.diagnosis.status === 'REJECTED' ? (
      <ErrorState message="입력 진단에서 거부된 자료라 파형을 표시하지 않습니다. 입력 진단 탭의 수정 방법을 확인하세요." />
    ) : (
      <AttachWaveform c={c} onChange={onChange} />
    )
  }
  const features = c.analysis?.features
  return (
    <>
      {error && <div className="alert alert-err" style={{ marginTop: 0 }}>{error}</div>}
      <FaultAnalysis
        matrix={c.waveform}
        fs={c.source.samplingRateHz}
        hz={c.source.systemFrequencyHz}
        analysis={c.analysis}
        blocked={rejected}
        busy={busy}
        analysisType={type}
        onType={setType}
        types={['EVENT_TYPE']}
        onRun={run}
        onReview={onReview}
      />
      {features && (
        <details className="fa-details" style={{ marginTop: 16 }}>
          <summary>채널별 특징값 (모델 입력에 쓰인 값)</summary>
          <FeatureTable features={features} />
        </details>
      )}
    </>
  )
}

function FeatureTable({ features }: { features: ChannelFeatures[] }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>채널</th><th className="num">RMS</th><th className="num">Peak</th><th className="num">Crest factor</th><th className="num">변화율 RMS</th></tr></thead>
          <tbody>
            {features.map((f) => (
              <tr key={f.channel}>
                <td className="mono">{f.channel}</td>
                <td className="num">{f.rms.toFixed(2)}</td>
                <td className="num">{f.peak.toFixed(2)}</td>
                <td className="num">{f.crestFactor.toFixed(3)}</td>
                <td className="num">{f.diffRms.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 원본 다운로드에 실패한 경우 동일한 CSV를 직접 연결할 수 있다. */
function AttachWaveform({ c, onChange }: { c: IncidentCase; onChange: (c: AnyCase) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function pick(f: File | undefined) {
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      onChange(await api.attachWaveform(c.id, f))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="이 브라우저에는 파형이 없습니다" description="서버에서 원본 파형을 받지 못했습니다 (서버 연결 또는 원본 파일 문제). 등록할 때 쓴 원본 CSV를 고르면 해시를 확인한 뒤 그래프를 볼 수 있습니다.">
      <div className="stack" style={{ gap: 12 }}>
        <dl className="dl-rows">
          <div><dt>파일명</dt><dd>{c.source.fileName}</dd></div>
          <div><dt>SHA-256</dt><dd><span className="mono break">{c.source.sha256}</span></dd></div>
        </dl>
        <div className="cluster">
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { onChange(await api.getCase(c.id)) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>서버에서 다시 불러오기</button>
          <label className="btn btn-primary" style={{ cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? '확인 중…' : '원본 CSV 선택'}
            <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <span className="small muted">선택한 파일의 해시가 위 값과 같을 때만 연결됩니다.</span>
        </div>
        {error && <div className="alert alert-err" style={{ margin: 0 }}>{error}</div>}
      </div>
    </Section>
  )
}
