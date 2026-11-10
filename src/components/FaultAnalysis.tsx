import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { analyzeWaveform, fmtCurrent, fmtPct } from '../lib/faultAnalysis'
import { CHART } from '../lib/chart'
import { ANALYSIS_LABEL, channelsFor, type AnalysisResult, type AnalysisType, type EventLabel, type EventScores } from '../types'
import AiEvidence from './AiEvidence'
import { IconBars, IconWave } from './Icons'
import { Segmented, Skeleton } from './ui'

const Waveform3D = lazy(() => import('./Waveform3D'))

const PHASE_COLOR = ['#c8462f', '#24835a', '#3157e0']
const MAX_POINTS = 700

interface Props {
  matrix: number[][]
  fs: number
  hz: number
  analysis: AnalysisResult | null
  /** 입력 진단에서 거부되어 분석할 수 없음 */
  blocked?: boolean
  busy?: boolean
  analysisType?: AnalysisType
  onType?: (t: AnalysisType) => void
  /** 고를 수 있는 분석 종류 (기본: 전체) */
  types?: AnalysisType[]
  onRun?: () => void
  onReview?: () => void
  /** 소개 화면 등에서 조작 없이 작게 보여줄 때 */
  compact?: boolean
}

/** 한 종류의 파형(전압·전류·영상전류)을 그리는 칸 */
export function Strip({ title, unit, keys, colors, data, onset, recovery, height, first, last }: { title: string; unit: string; keys: string[]; colors: string[]; data: Record<string, number | null>[]; onset: number | null; recovery: number | null; height: number; first?: boolean; last?: boolean }) {
  return (
    <div className="fa-strip">
      <div className="fa-strip-head">
        <span className="fa-strip-title">{title} <span className="fa-unit-tag">{unit}</span></span>
        <span className="fa-legend">
          {keys.map((k, i) => (
            <span key={k}><i style={{ background: colors[i] }} />{k}</span>
          ))}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} syncId="fault" margin={{ top: first ? 20 : 6, right: 8, left: 0, bottom: last ? 4 : 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} hide={!last} tick={CHART.tick} axisLine={false} tickLine={false} tickFormatter={(v) => `${Number(v).toFixed(2)}`} />
          <YAxis tick={CHART.tick} axisLine={false} tickLine={false} width={44} unit={unit === 'kV' ? '' : ''} tickFormatter={(v) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toFixed(1))).toString()} />
          <Tooltip formatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)} labelFormatter={(t) => `${Number(t).toFixed(4)} s`} />
          {onset !== null && (
            <ReferenceLine
              x={onset}
              stroke="#cf3434"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={first ? { value: `급변 관측 (${onset.toFixed(3)} s)`, position: 'top', fill: '#cf3434', fontSize: 11, fontWeight: 600 } : undefined}
            />
          )}
          {recovery !== null && <ReferenceLine x={recovery} stroke="#24835a" strokeDasharray="4 3" label={first ? { value: '초반 수준 복귀', fill: '#24835a', fontSize: 11 } : undefined} />}
          {keys.map((k, i) => (
            <Line key={k} dataKey={k} stroke={colors[i]} dot={false} strokeWidth={1.3} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function Evidence({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="fa-ev">
      <div className="fa-ev-label">{icon}{label}</div>
      {children}
    </div>
  )
}

function ScoreBars({ scores, highlight }: { scores: EventScores; highlight?: EventLabel }) {
  return (
    <div className="scores">
      {Object.keys(scores).map((k) => (
        <div key={k} className={`score ${k === highlight ? 'hl' : ''}`}>
          <span className="mono">{k}</span>
          <div className="bar"><div style={{ width: `${scores[k] * 100}%` }} /></div>
          <span className="num" style={{ textAlign: 'right' }}>{scores[k].toFixed(2)}</span>
        </div>
      ))}
    </div>
  )
}

export default function FaultAnalysis({ matrix, fs, hz, analysis, blocked, busy, analysisType = 'EVENT_TYPE', onType, types, onRun, onReview, compact }: Props) {
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const features = useMemo(() => analyzeWaveform(matrix, fs, hz), [matrix, fs, hz])
  const channels = channelsFor(matrix[0]?.length ?? 0)
  const currentKeys = channels.filter((c) => /^I[abc]$/.test(c))
  const voltageKeys = channels.filter((c) => c.startsWith('V'))
  const phaseColors = (keys: readonly string[]) => keys.map((k) => PHASE_COLOR['abc'.indexOf(k[1])])
  const data = useMemo(() => {
    const measured = channelsFor(matrix[0]?.length ?? 0)
    const step = Math.max(1, Math.ceil(matrix.length / MAX_POINTS))
    const rows: Record<string, number>[] = []
    for (let i = 0; i < matrix.length; i += step) {
      const r = matrix[i]
      rows.push({ t: i / fs, ...Object.fromEntries(measured.map((ch, j) => [ch, ch.startsWith('V') ? r[j] / 1000 : r[j]])) })
    }
    return rows
  }, [matrix, fs])
  const onset = features.onset?.seconds ?? null
  const dom = features.dominant

  return (
    <div className={`fa ${compact ? 'compact' : ''}`}>
      <div className="fa-main">
        <div className="fa-panel">
          {!compact && (
            <div className="fa-panel-head">
              <div className="row gap">
                <IconWave />
                <strong>고장파형 분석</strong>
                <span className="small muted num">{matrix.length.toLocaleString()} 샘플 · {fs.toLocaleString()} Hz · 계통 {hz} Hz</span>
              </div>
              <Segmented value={view} onChange={setView} options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }]} />
            </div>
          )}
          {view === '3d' && !compact ? (
            <Suspense fallback={<Skeleton h={460} style={{ borderRadius: 12 }} />}>
              <Waveform3D matrix={matrix} samplingRateHz={fs} systemFrequencyHz={hz} onsetSample={features.onset?.sample ?? null} recoverySeconds={features.recoverSeconds} />
            </Suspense>
          ) : (
            <>
              <Strip title="전압 파형 (Voltage)" unit="kV" keys={voltageKeys} colors={phaseColors(voltageKeys)} data={data} onset={onset} recovery={features.recoverSeconds} height={compact ? 118 : 158} first />
              <Strip title="전류 파형 (Current)" unit="A" keys={currentKeys} colors={phaseColors(currentKeys)} data={data} onset={onset} recovery={features.recoverSeconds} height={compact ? 118 : 158} last={!channels.includes('In')} />
              {channels.includes('In') && <Strip title="중성선 전류 (In)" unit="A" keys={['In']} colors={['#14161b']} data={data} onset={onset} recovery={features.recoverSeconds} height={compact ? 96 : 120} last />}
              {!channels.includes('In') && <p className="hint">RU 입력에는 Ib·In 계측이 없어 표시하지 않습니다.</p>}
              <div className="fa-xaxis">시간 (s)</div>
            </>
          )}
        </div>
      </div>

      <aside className="fa-side">
        {/* AI 결과 */}
        <div className="fa-card">
          <div className="fa-card-head">
            <strong>AI 분석 결과</strong>
            {analysis?.kind === 'COMPLETED' && <span className="badge accent">예측 결과</span>}
            {analysis?.kind === 'WITHHELD' && <span className="badge warn">판단 보류</span>}
          </div>
          {!analysis ? (
            <div className="fa-empty">
              <p className="small muted">{blocked ? '입력 진단에서 거부된 자료라 분석할 수 없습니다.' : '아직 분석하지 않았습니다. 지원 여부를 확인한 뒤 실행합니다.'}</p>
              {!compact && (
                <>
                  <select value={analysisType} onChange={(e) => onType?.(e.target.value as AnalysisType)} disabled={blocked || busy}>
                    {(Object.entries(ANALYSIS_LABEL) as [AnalysisType, string][]).filter(([k]) => !types || types.includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button className="btn btn-primary" onClick={onRun} disabled={blocked || busy}>{busy ? '확인 중…' : '지원 여부 확인 후 실행'}</button>
                </>
              )}
            </div>
          ) : analysis.kind === 'COMPLETED' ? (
            <>
              <div className="fa-result">
                <div className="pred">{analysis.predictedLabel}</div>
                <div className="fa-score">
                  <span className="small muted">모델 점수</span>
                  <strong className="num">{analysis.scores[analysis.predictedLabel].toFixed(2)}</strong>
                </div>
              </div>
              <ScoreBars scores={analysis.scores} highlight={analysis.predictedLabel} />
              <p className="hint">보정되지 않은 점수입니다. 정답일 확률(신뢰도)이 아닙니다.</p>
              {!compact && (
                <div className="fa-actions">
                  <select value={analysisType} onChange={(e) => onType?.(e.target.value as AnalysisType)} disabled={busy}>
                    {(Object.entries(ANALYSIS_LABEL) as [AnalysisType, string][]).filter(([k]) => !types || types.includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button className="btn btn-sm" onClick={onRun} disabled={busy}>{busy ? '실행 중…' : '다시 실행'}</button>
                  {onReview && <button className="btn btn-sm btn-primary" onClick={onReview}>검토 기록</button>}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="fa-withheld">결과를 내지 않았습니다. 근거가 부족한 상태에서 원인을 추정하지 않습니다.</p>
              <ul className="small">{analysis.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              {!compact && analysis.neededInfo.length > 0 && (
                <>
                  <div className="small muted" style={{ marginTop: 10 }}>추가로 필요한 정보</div>
                  <ul className="small">{analysis.neededInfo.map((r) => <li key={r}>{r}</li>)}</ul>
                </>
              )}
              {!compact && (
                <div className="fa-actions">
                  <select value={analysisType} onChange={(e) => onType?.(e.target.value as AnalysisType)} disabled={busy}>
                    {(Object.entries(ANALYSIS_LABEL) as [AnalysisType, string][]).filter(([k]) => !types || types.includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button className="btn btn-sm" onClick={onRun} disabled={busy}>{busy ? '실행 중…' : '다시 실행'}</button>
                  {onReview && <button className="btn btn-sm btn-primary" onClick={onReview}>검토 기록</button>}
                </div>
              )}
            </>
          )}
        </div>

        {/* AI 판단 근거 (서버 AI 원문: 판단 기준 통과 여부 + TreeSHAP) */}
        {analysis?.ai && <AiEvidence ai={analysis.ai} compact={compact} />}

        {/* 파형 요약 (브라우저에서 직접 계산, AI 판단과 별개) */}
        <div className="fa-card">
          <div className="fa-card-head">
            <strong>파형 요약</strong>
            <span className="small muted">화면에서 직접 계산 · AI 판단과 별개</span>
          </div>
          {!features.onset ? (
            <p className="small muted">기록 안에서 뚜렷한 급변을 찾지 못했습니다. 기록 시작 전 이상 여부와 회복은 확인하지 못했습니다.</p>
          ) : (
            <div className="fa-ev-grid">
              <Evidence icon={<IconBars />} label="피크값 변화">
                {dom ? (
                  <>
                    <div className="fa-ev-sub">{dom.phase}상 전류</div>
                    <div className="fa-ev-val num">{fmtCurrent(dom.peakBefore)} → {fmtCurrent(dom.peakAfter)}</div>
                    <div className={`fa-ev-pct ${dom.peakPct >= 0 ? 'up' : 'down'}`}>{dom.peakPct >= 0 ? '▲' : '▼'} {fmtPct(dom.peakPct)}</div>
                  </>
                ) : (
                  <div className="small muted">전류 변화 작음</div>
                )}
              </Evidence>
              <Evidence icon={<IconWave />} label="RMS 변화">
                {dom ? (
                  <>
                    <div className="fa-ev-sub">{dom.phase}상 전류</div>
                    <div className="fa-ev-val num">{fmtCurrent(dom.before)} → {fmtCurrent(dom.after)}</div>
                    <div className={`fa-ev-pct ${dom.rmsPct >= 0 ? 'up' : 'down'}`}>{dom.rmsPct >= 0 ? '▲' : '▼'} {fmtPct(dom.rmsPct)}</div>
                  </>
                ) : (
                  <div className="small muted">전류 변화 작음</div>
                )}
              </Evidence>
              <Evidence icon={<span className="fa-clock" />} label="급변 관측 시점">
                <div className="fa-ev-val num big">{features.onset.seconds.toFixed(3)} s</div>
                <div className="small muted num">샘플 {features.onset.sample.toLocaleString()} · 계통 {hz} Hz</div>
              </Evidence>
              <Evidence icon={<span className="fa-dotted" />} label="특징 패턴">
                <ul className="fa-patterns">
                  {features.patterns.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </Evidence>
            </div>
          )}
        </div>

        {!compact && analysis?.kind === 'COMPLETED' && (
          <details className="fa-details">
            <summary>함께 확인할 제한사항</summary>
            <ul className="small">{analysis.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
            <div className="xs muted mono" style={{ marginTop: 6 }}>{analysis.modelVersion} · {analysis.preprocessVersion}</div>
          </details>
        )}
      </aside>
    </div>
  )
}
