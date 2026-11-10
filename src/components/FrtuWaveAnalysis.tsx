import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { analyzeFrtuWave, buildFrtuWave, type FrtuWaveFeatures, type FrtuWaveKey, type FrtuWavePoint } from '../lib/frtuWave'
import { FI_LABEL, frtuViews, locateFault, type FaultScope } from '../lib/frtu'
import { inspectionCandidate } from '../lib/gis'
import { SOURCE_LABEL, STATUS_LABEL, THRESHOLDS, useVillage } from '../lib/village'
import { EVENT_MODEL, useVillageEvents, type AnalyzedEvent, type EventVerdict } from '../lib/villageEvents'
import { Evidence, Strip } from './FaultAnalysis'
import { IconBars, IconWave } from './Icons'
import { Segmented, Skeleton } from './ui'

const Waveform3D = lazy(() => import('./Waveform3D'))

const MAX_POINTS = 700
const fmtMa = (x: number) => `${x.toFixed(1)} mA`
const fmtPct = (x: number) => `${Math.abs(x * 100).toFixed(0)}%`

/** 몇 초/분/시간 전 */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.round(s / 60)}분 전`
  return `${Math.round(s / 3600)}시간 전`
}

export interface FrtuVerdictInfo {
  verdict: EventVerdict
  /** 판정한 사건 이름 (예: 사건 #3 · 개폐 명령 직후) */
  title: string
  /** 사건을 받은 시각 (ms) */
  at: number
}

/** 이상 점수 기반 규칙 판정 */
export interface FrtuRuleInfo {
  label: string
  lines: string[]
}

/** 같은 판정이 나온 지난 마을 사건 */
export interface FrtuSimilar {
  count: number
  lastAt: number | null
}

interface Props {
  points: FrtuWavePoint[]
  /** 출처 문구 (예: 실측 · INA219 2개 / 시뮬레이터) */
  sourceText: string
  verdict?: FrtuVerdictInfo | null
  rule?: FrtuRuleInfo | null
  /** 고장 구간 (FRTU 고장표시 조합으로 정한 것) */
  location?: { scope: FaultScope; title: string } | null
  similar?: FrtuSimilar | null
  /** 지금 FRTU가 정상인지 (실시간 화면에서 지난 판정을 지금 고장처럼 보이지 않게) */
  liveNormal?: boolean
  /** 강조할 FRTU (나머지 선은 흐리게) */
  focus?: FrtuWaveKey
  onReview?: () => void
  /** 카드 아래에 덧붙일 버튼 등 */
  actions?: ReactNode
  /** 좁은 칸에서 한 줄로 쌓아 보여 줌 */
  stacked?: boolean
  compact?: boolean
}

/** 마을 FRTU 파형 분석: 고장파형 분석 화면과 같은 틀(파형 · 2D/3D · AI 진단 보고서 · 파형 요약). 직류 계측이라 교류 3상과 섞지 않음 */
export default function FrtuWaveAnalysis({ points, sourceText, verdict, rule, location, similar, liveNormal, focus, onReview, actions, stacked, compact }: Props) {
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const wave = useMemo(() => buildFrtuWave(points), [points])
  const features = useMemo(() => analyzeFrtuWave(wave), [wave])
  const hz = wave.dt > 0 ? 1 / wave.dt : 0

  const data = useMemo(() => {
    const step = Math.max(1, Math.ceil(wave.t.length / MAX_POINTS))
    const rows: Record<string, number | null>[] = []
    for (let i = 0; i < wave.t.length; i += step) {
      rows.push({ t: wave.t[i], 전압: wave.v[i], ...Object.fromEntries(wave.series.map((s) => [s.label, s.mA[i]])) })
    }
    return rows
  }, [wave])

  // 3D는 빈 값을 앞 값으로 채워 그림 (재지 않은 값을 새로 만들지 않고 선만 잇기 위함)
  const matrix = useMemo(() => {
    const last = wave.series.map(() => 0)
    return wave.t.map((_, i) => wave.series.map((s, k) => (last[k] = s.mA[i] ?? last[k])))
  }, [wave])

  const onset = features.onset?.seconds ?? null
  const dom = features.dominant
  const keys = wave.series.map((s) => s.label)
  // 고른 FRTU만 진하게, 나머지는 흐리게
  const colors = wave.series.map((s) => (focus && s.key !== focus ? `${s.color}55` : s.color))
  const h = compact ? 118 : 158

  if (wave.t.length < 2) {
    return <div className="alert alert-warn small">아직 저장된 FRTU 계측 표본이 없어 파형을 그릴 수 없어요. 장치가 연결되면 0.5초마다 쌓여요.</div>
  }

  return (
    <div className={`fa ${compact ? 'compact' : ''}`} style={stacked ? { gridTemplateColumns: '1fr' } : undefined}>
      <div className="fa-main">
        <div className="fa-panel">
          <div className="fa-panel-head">
            <div className="row gap">
              <IconWave />
              <strong>FRTU 파형 분석</strong>
              <span className="small muted num">{wave.t.length.toLocaleString()} 샘플 · {hz ? `${hz.toFixed(hz < 10 ? 1 : 0)} Hz` : '—'} · 직류 모형 · {sourceText}</span>
            </div>
            <Segmented value={view} onChange={setView} options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }]} />
          </div>
          {view === '3d' ? (
            <Suspense fallback={<Skeleton h={460} style={{ borderRadius: 12 }} />}>
              <Waveform3D
                matrix={matrix}
                samplingRateHz={hz || 1}
                systemFrequencyHz={0}
                onsetSample={features.onset?.sample ?? null}
                recoverySeconds={features.recoverSeconds}
                channelNames={keys}
                channelColors={wave.series.map((s) => s.color)}
              />
            </Suspense>
          ) : (
            <>
              <Strip title="FRTU 전류" unit="mA" keys={keys} colors={colors} data={data} onset={onset} recovery={features.recoverSeconds} height={h} first />
              <Strip title="전압" unit="V" keys={['전압']} colors={['#14161b']} data={data} onset={onset} recovery={features.recoverSeconds} height={compact ? 96 : 120} last />
              {!wave.series.some((s) => s.key !== 'inlet') && <p className="hint">분기 INA219 값이 없는 기록이라 인입(마을 전체) 전류만 표시합니다.</p>}
              <div className="fa-xaxis">시간 (s)</div>
            </>
          )}
        </div>
        {/* 파형 요약은 파형 바로 아래에 둠 (왼쪽 칸이 비지 않게) */}
        <div style={{ marginTop: 14 }}>
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
                      <div className="fa-ev-sub">{dom.label} 전류</div>
                      <div className="fa-ev-val num">{fmtMa(dom.peakBefore)} → {fmtMa(dom.peakAfter)}</div>
                      <div className={`fa-ev-pct ${dom.peakPct >= 0 ? 'up' : 'down'}`}>{dom.peakPct >= 0 ? '▲' : '▼'} {fmtPct(dom.peakPct)}</div>
                    </>
                  ) : <div className="small muted">전류 변화 작음</div>}
                </Evidence>
                <Evidence icon={<IconWave />} label="RMS 변화">
                  {dom ? (
                    <>
                      <div className="fa-ev-sub">{dom.label} 전류</div>
                      <div className="fa-ev-val num">{fmtMa(dom.before)} → {fmtMa(dom.after)}</div>
                      <div className={`fa-ev-pct ${dom.rmsPct >= 0 ? 'up' : 'down'}`}>{dom.rmsPct >= 0 ? '▲' : '▼'} {fmtPct(dom.rmsPct)}</div>
                    </>
                  ) : <div className="small muted">전류 변화 작음</div>}
                </Evidence>
                <Evidence icon={<span className="fa-clock" />} label="급변 관측 시점">
                  <div className="fa-ev-val num big">{features.onset.seconds.toFixed(1)} s</div>
                  <div className="small muted num">샘플 {features.onset.sample.toLocaleString()} · {wave.dt ? `${wave.dt.toFixed(1)} s 간격` : ''}</div>
                </Evidence>
                <Evidence icon={<span className="fa-dotted" />} label="특징 패턴">
                  <ul className="fa-patterns">
                    {features.patterns.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                </Evidence>
              </div>
            )}
          </div>
        </div>
      </div>

      <aside className="fa-side">
        <DiagnosisReport verdict={verdict ?? null} rule={rule ?? null} location={location ?? null} similar={similar ?? null} liveNormal={liveNormal} features={features} onReview={onReview} actions={actions} compact={compact} />

      </aside>
    </div>
  )
}

/** 보고서 한 칸 */
function Block({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ paddingTop: 12, marginTop: 12, borderTop: '1px solid var(--line)' }}>
      <div className="small" style={{ fontWeight: 650, color: 'var(--ink)', marginBottom: 6 }}>
        <span className="num muted" style={{ marginRight: 6 }}>{n}</span>{title}
      </div>
      {children}
    </div>
  )
}

/** AI 진단 보고서: 진단 · 고장 구간 · 판단 근거 · 권고 조치 · 유사 사건 · 해설. 모두 화면에 있는 값만 씀 */
function DiagnosisReport({ verdict, rule, location, similar, liveNormal, features, onReview, actions, compact }: {
  verdict: FrtuVerdictInfo | null
  rule: FrtuRuleInfo | null
  location: { scope: FaultScope; title: string } | null
  similar: FrtuSimilar | null
  liveNormal?: boolean
  features: FrtuWaveFeatures
  onReview?: () => void
  actions?: ReactNode
  compact?: boolean
}) {
  const v = verdict?.verdict ?? null
  const scored = v && (v.kind === 'ANSWERED' || v.kind === 'WITHHELD') ? v : null
  const cand = location ? inspectionCandidate(location.scope) : null
  const stale = !!verdict && !!liveNormal && Date.now() - verdict.at > 60_000
  const steps = cand?.steps ?? []

  // 해설: 위 칸의 값만 이어 붙인 문장 (값이 없으면 그 문장은 빼고, 지어내지 않음)
  const commentary: string[] = []
  if (location && location.scope !== 'NONE' && location.scope !== 'OFF' && location.scope !== 'NO_DATA') commentary.push(`${location.title}.`)
  if (features.dominant && features.onset) commentary.push(`${features.dominant.label} 전류가 ${fmtMa(features.dominant.before)}에서 ${fmtMa(features.dominant.after)}로 ${features.dominant.rmsPct >= 0 ? '늘었어요' : '줄었어요'}${features.recoverSeconds !== null ? ` (${(features.recoverSeconds - features.onset.seconds).toFixed(1)}초 뒤 복귀)` : ' (복귀 안 됨)'}.`)
  if (scored?.kind === 'ANSWERED') commentary.push(`AI 모델은 ${verdict!.title}을 '${scored.labelKo}'(점수 ${scored.score.toFixed(2)})로 판정했고, 가장 큰 근거는 ${scored.evidence[0]?.label ?? '—'} 값이에요.`)
  if (scored?.kind === 'WITHHELD') commentary.push(`AI 모델은 근거가 부족해 원인을 정하지 않았어요 (1순위 후보 '${scored.labelKo}' ${scored.score.toFixed(2)}).`)
  if (steps[0]) commentary.push(`${steps[0].label}부터 점검하는 것을 권해요.`)
  if (stale) commentary.push(`이 판정은 ${ago(Date.now() - verdict!.at)} 사건 기준이고, 지금 FRTU는 정상이에요.`)

  const badge = !v ? null : v.kind === 'ANSWERED' ? <span className="badge accent">진단 완료</span> : v.kind === 'WITHHELD' ? <span className="badge warn">판단 보류</span> : <span className="badge">{v.kind === 'NO_MODEL' ? '모델 학습 전' : '입력 거부'}</span>
  let n = 0

  return (
    <div className="fa-card">
      <div className="fa-card-head">
        <strong>AI 진단 보고서</strong>
        {badge}
      </div>
      {verdict && (
        <div className="small muted">
          {verdict.title} · {ago(Date.now() - verdict.at)}
          {stale && <span className="badge" style={{ marginLeft: 6 }}>지난 사건 · 지금은 정상</span>}
        </div>
      )}

      <Block n={++n} title="진단">
        {!v ? (
          <p className="small muted">아직 AI가 판정한 마을 사건이 없어요. 전류가 갑자기 바뀌면 장치가 사건 파형을 녹화해 보내고, 그때 진단해요.</p>
        ) : !scored ? (
          <>
            <p className="fa-withheld">{v.kind === 'NO_MODEL' ? '원인 분류 모델이 아직 학습되지 않았습니다.' : '입력 점검에서 거부된 기록이라 진단하지 않았습니다.'}</p>
            <ul className="small">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </>
        ) : scored.kind === 'ANSWERED' ? (
          <div className="fa-result" style={{ marginBottom: 0 }}>
            <div className="pred" style={{ fontSize: 28 }}>{scored.labelKo}</div>
            <div className="fa-score">
              <span className="small muted">모델 점수 · 기준 {EVENT_MODEL.thresholds.score}</span>
              <strong className="num">{scored.score.toFixed(2)}</strong>
            </div>
          </div>
        ) : (
          <>
            <p className="fa-withheld">결과를 내지 않았습니다. 근거가 부족한 상태에서 원인을 추정하지 않습니다.</p>
            <ul className="small">{scored.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </>
        )}
        {scored && !compact && (
          <div className="scores" style={{ marginTop: 10 }}>
            {scored.ranking.slice(0, 3).map((r) => (
              <div key={r.label} className={`score ${r.label === scored.label ? 'hl' : ''}`} style={{ gridTemplateColumns: '96px 1fr 40px' }}>
                <span>{r.labelKo}</span>
                <div className="bar"><div style={{ width: `${r.score * 100}%` }} /></div>
                <span className="num" style={{ textAlign: 'right' }}>{r.score.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
        {scored && <p className="hint">보정되지 않은 점수입니다. 정답일 확률(신뢰도)이 아닙니다.</p>}
      </Block>

      <Block n={++n} title="고장 구간">
        {location ? (
          <>
            <div className="small" style={{ color: 'var(--ink)', fontWeight: 600 }}>{location.title}</div>
            {cand && <div className="small muted">{cand.section} · {cand.boundary} · 영향 고객 {cand.customers}호</div>}
          </>
        ) : (
          <p className="small muted">이 기록에는 FRTU별 고장표시가 없어 구간을 좁히지 않았어요.</p>
        )}
        {rule && (
          <div className="small muted" style={{ marginTop: 6 }}>
            규칙 판정 · <b style={{ color: 'var(--ink)' }}>{rule.label}</b>
            <ul className="small">{rule.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          </div>
        )}
      </Block>

      {scored && scored.evidence.length > 0 && (
        <Block n={++n} title="판단 근거 (기여도 큰 순)">
          <div className="evidence">
            {scored.evidence.slice(0, compact ? 3 : 5).map((e) => (
              <div key={e.name} className="evidence-row">
                <span>{e.label}</span>
                <div className="meter"><i className={e.contribution >= 0 ? 'ok' : 'err'} style={{ width: `${Math.min(100, Math.abs(e.contribution) * 300)}%` }} /></div>
                <span className="num small">{e.value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </Block>
      )}

      <Block n={++n} title="권고 조치">
        {steps.length ? (
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            {steps.slice(0, compact ? 3 : 6).map((s) => <li key={s.id}><b>{s.label}</b> <span className="muted">· {s.detail}</span></li>)}
          </ol>
        ) : (
          <p className="small muted">{location && location.scope === 'NONE' ? '지금은 점검이 필요한 구간이 없어요.' : '구간이 정해지지 않아 점검 순서를 내지 않았어요. 현장 확인 후 검토 기록을 남겨 주세요.'}</p>
        )}
        {cand && <div className="xs muted" style={{ marginTop: 4 }}>설비 정보 출처: {cand.source}</div>}
      </Block>

      {similar && (
        <Block n={++n} title="유사 사건">
          <p className="small">{similar.count ? <>같은 판정이 나온 지난 마을 사건 <b>{similar.count}건</b>{similar.lastAt ? ` · 마지막 ${ago(Date.now() - similar.lastAt)}` : ''}</> : <span className="muted">같은 판정이 나온 지난 사건이 없어요.</span>}</p>
        </Block>
      )}

      {commentary.length > 0 && (
        <Block n={++n} title="AI 해설">
          <p className="small" style={{ lineHeight: 1.6 }}>{commentary.join(' ')}</p>
          <div className="xs muted">위 칸의 값만 이어 쓴 근거 기반 요약이에요. 없는 사실은 만들지 않아요.</div>
        </Block>
      )}

      {(onReview || actions) && (
        <div className="fa-actions">
          {actions}
          {onReview && <button className="btn btn-sm btn-primary" onClick={onReview}>검토 기록</button>}
        </div>
      )}
    </div>
  )
}

/** AI가 판정한 마을 사건을 화면 문구로 */
export function verdictInfo(a: AnalyzedEvent | undefined): FrtuVerdictInfo | null {
  if (!a) return null
  return {
    verdict: a.verdict,
    title: `사건 #${a.e.ev} · ${a.e.src === 'cmd' ? '개폐 명령 직후' : '전류 급변'}`,
    at: Date.parse(a.e.receivedAt),
  }
}

/** 같은 판정이 나온 다른 마을 사건 수 */
export function similarOf(events: AnalyzedEvent[], a: AnalyzedEvent | undefined): FrtuSimilar | null {
  const v = a?.verdict
  if (!a || !v || (v.kind !== 'ANSWERED' && v.kind !== 'WITHHELD')) return null
  const same = events.filter((x) => x.recordId !== a.recordId && (x.verdict.kind === 'ANSWERED' || x.verdict.kind === 'WITHHELD') && x.verdict.label === v.label)
  return { count: same.length, lastAt: same[0] ? Date.parse(same[0].e.receivedAt) : null }
}

/** 실시간 마을 FRTU 값(최근 1분)으로 그리는 파형 분석. 3D 마을·AI 도우미 옆칸에서 씀 */
export function LiveFrtuWaveAnalysis(props: Pick<Props, 'stacked' | 'compact' | 'actions' | 'focus'>) {
  const snap = useVillage()
  const events = useVillageEvents()
  if (!snap.connected) {
    return <div className="alert alert-warn small">장치가 연결되지 않아 지금 들어오는 FRTU 계측값이 없어요. 설정에서 장치를 다시 연결하거나 시뮬레이터로 바꿔 주세요.</div>
  }
  const views = frtuViews(snap)
  const f = views.inlet
  const loc = locateFault(snap, views)
  const rule: FrtuRuleInfo = {
    label: `${STATUS_LABEL[f.status]} · ${FI_LABEL[f.fi]}`,
    lines: [`인입 이상 점수 ${f.score.toFixed(2)} (주의 ${THRESHOLDS.warn} · 이상 ${THRESHOLDS.fault})`],
  }
  return (
    <FrtuWaveAnalysis
      points={snap.history}
      sourceText={SOURCE_LABEL[snap.source]}
      verdict={verdictInfo(events[0])}
      similar={similarOf(events, events[0])}
      rule={rule}
      location={{ scope: loc.scope, title: loc.title }}
      liveNormal={loc.scope === 'NONE'}
      {...props}
    />
  )
}
