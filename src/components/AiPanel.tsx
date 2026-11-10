import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { useActor } from '../lib/actor'
import { CHART } from '../lib/chart'
import { FI_LABEL, FRTUS, frtuHistory, frtuViews, locateFault, type FrtuId } from '../lib/frtu'
import { SOURCE_LABEL, STATUS_LABEL, type VillageSnapshot } from '../lib/village'
import { MODEL_SCOPES, parseCsv, diagnose } from '../lib/waveform'
import type { AnalysisResult, InputDiagnosis, ModelCountry } from '../types'
import { useVillageEvents } from '../lib/villageEvents'
import FaultAnalysis from './FaultAnalysis'
import { IconArrowRight, IconX } from './Icons'
import { Badge, NODE_TONE, Status } from './ui'

/** FRTU가 보내는 실시간 계측 (최근 1분). 인입은 마을 전체, 분기 FRTU는 그 구간 전류 (구간 전압은 기록하지 않아 전체 전압) */
export function LiveWave({ snap, frtu = 'inlet' }: { snap: VillageSnapshot; frtu?: FrtuId }) {
  const series = frtuHistory(snap, frtu)
  if (!series.available) return <div className="alert alert-warn small">{series.reason} 이 FRTU의 파형은 표시하지 않습니다.</div>
  const t0 = series.points[series.points.length - 1].t
  const data = series.points.map((p) => ({ t: (p.t - t0) / 1000, mA: p.mA, v: p.v }))
  return (
    <>
      <div className="small muted">출처: {SOURCE_LABEL[snap.source]} · 저장된 실측 표본 {data.length}개</div>
      <div className="ai-sub">전류 (mA)</div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 0]} tick={CHART.tick} axisLine={false} tickLine={false} unit="s" />
          <YAxis tick={CHART.tick} axisLine={false} tickLine={false} width={40} domain={['auto', 'auto']} />
          <Tooltip formatter={(x) => (typeof x === 'number' ? x.toFixed(1) : x)} labelFormatter={(t) => `${Number(t).toFixed(1)} s`} />
          <Line dataKey="mA" stroke="#3157e0" dot={false} strokeWidth={1.6} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="ai-sub">전압 (V)</div>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 0]} hide />
          <YAxis tick={CHART.tick} axisLine={false} tickLine={false} width={40} domain={['auto', 'auto']} />
          <Line dataKey="v" stroke="#24835a" dot={false} strokeWidth={1.6} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </>
  )
}

/** CSV 고장파형을 넣으면 바로 그려 보고, 서버 AI 분석을 요청 */
export function CsvAnalysis() {
  const [actor] = useActor()
  const [file, setFile] = useState<File | null>(null)
  const [matrix, setMatrix] = useState<number[][] | null>(null)
  const [diag, setDiag] = useState<InputDiagnosis | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [country, setCountry] = useState<ModelCountry>('CN')
  const scope = MODEL_SCOPES[country]

  async function load(f: File | undefined, selected: ModelCountry = country) {
    setFile(f ?? null)
    setMatrix(null)
    setDiag(null)
    setAnalysis(null)
    setErr(null)
    if (!f) return
    const parsed = parseCsv(await f.text())
    const selectedScope = MODEL_SCOPES[selected]
    const r = diagnose(parsed, f.size, { samplingRateHz: selectedScope.samplingRateHz, systemFrequencyHz: selectedScope.systemFrequencyHz, sourceType: 'PUBLIC_DATASET' })
    setDiag(r.diagnosis)
    setMatrix(r.matrix)
  }

  async function run() {
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      const c = await api.registerCase({ title: file.name, file, sourceType: 'PUBLIC_DATASET', datasetId: country === 'CN' ? 'Xiong-public-fault-dataset' : 'oscgrid_ru', samplingRateHz: scope.samplingRateHz, systemFrequencyHz: scope.systemFrequencyHz, labelMeaning: country === 'CN' ? 'SIF/MIF/PF/TD' : 'NORMAL/SWITCHING/ABNORMAL/FAULT', actor })
      const done = await api.runAnalysis(c.id, 'EVENT_TYPE', actor)
      setAnalysis(done.analysis)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <label className="field">공개 자료 입력 조건<select value={country} disabled={busy} onChange={(e) => { const next = e.target.value as ModelCountry; setCountry(next); void load(file ?? undefined, next) }}><option value="CN">중국 Xiong · CN</option><option value="RU">러시아 OscGrid · RU</option></select></label>
      <label className="ai-drop">
        <input type="file" accept=".csv,text/csv" onChange={(e) => void load(e.target.files?.[0])} />
        <strong>{file ? file.name : '고장파형 CSV 넣기'}</strong>
        <span className="small muted">{scope.channels.join(' ')} · {scope.rows}개 · {scope.samplingRateHz} Hz</span>
      </label>
      {diag && (
        <div className="row gap" style={{ flexWrap: 'wrap' }}>
          <Badge tone={diag.status === 'ACCEPTED' ? 'ok' : diag.status === 'LIMITED' ? 'warn' : 'err'}>
            입력 검사 {diag.status === 'ACCEPTED' ? '통과' : diag.status === 'LIMITED' ? '제한' : '거부'}
          </Badge>
          {diag.issues.slice(0, 2).map((i) => <span key={i.code} className="small muted">{i.message}</span>)}
        </div>
      )}
      {err && <div className="alert alert-err small">{err}</div>}
      {matrix && (
        <FaultAnalysis matrix={matrix} fs={scope.samplingRateHz} hz={scope.systemFrequencyHz} analysis={analysis} blocked={diag?.status === 'REJECTED'} busy={busy} types={['EVENT_TYPE']} onRun={run} compact />
      )}
    </div>
  )
}

/** FRTU 3대를 나란히 보여 주고 고르게 하는 줄 */
export function FrtuStrip({ snap, value, onPick }: { snap: VillageSnapshot; value: FrtuId; onPick: (id: FrtuId) => void }) {
  const views = frtuViews(snap)
  return (
    <div className="frtu-strip" role="tablist" aria-label="FRTU 선택">
      {FRTUS.map((f) => {
        const fv = views[f.id]
        const tone = fv.fi !== 'NONE' ? 'err' : NODE_TONE[fv.status]
        return (
          <button key={f.id} type="button" role="tab" aria-selected={value === f.id} className={`frtu-tab ${value === f.id ? 'on' : ''} ${fv.fi !== 'NONE' ? 'fi' : ''}`} onClick={() => onPick(f.id)}>
            <Status tone={tone}>{f.short}</Status>
            <span className="num">{fv.available ? `${(fv.i * 1000).toFixed(1)} mA` : '—'}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 고장표시(FI)로 좁힌 고장 구간 */
export function FaultLocationBox({ snap }: { snap: VillageSnapshot }) {
  const loc = locateFault(snap)
  const tone = loc.scope === 'NONE' || loc.scope === 'OFF' ? 'ok' : loc.scope === 'NO_DATA' ? 'off' : 'err'
  return (
    <div className={`fault-loc ${tone}`}>
      <div className="fault-loc-head"><span>고장 구간</span><strong>{loc.title}</strong></div>
      {loc.reasons.length > 0 && <ul>{loc.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  )
}

/** 화면 오른쪽에 붙는 FRTU 요약 패널 (FRTU를 누르면 열림). 자세한 분석·대화는 상세 화면에서 */
export default function AiPanel({ snap, frtu, onPick, onClose }: { snap: VillageSnapshot; frtu: FrtuId; onPick: (id: FrtuId) => void; onClose: () => void }) {
  const events = useVillageEvents()
  const f = frtuViews(snap)[frtu]
  const sensorSource = !snap.connected
    ? '장치 연결 끊김'
    : snap.source === 'MOCK'
      ? '시뮬레이터 생성값'
      : frtu === 'inlet'
        ? snap.zones ? '두 INA219 구간 실측 합' : '응답 센서 1개의 전체 실측값'
        : snap.zones ? `${f.def.sensor} 실측` : `${f.def.sensor} 미응답`
  const alarm = f.fi !== 'NONE' || ['WARNING', 'FAULT', 'OUTAGE'].includes(f.status)
  const v = events[0]?.verdict
  return (
    <aside className="ai-panel" aria-label="FRTU 요약">
      <div className="ai-head">
        <div style={{ minWidth: 0 }}>
          <strong className="ai-title">{f.def.name}</strong>
          <div className="small muted">{f.def.role} FRTU · {sensorSource}</div>
        </div>
        <button className="btn btn-ghost btn-icon ai-close" onClick={onClose} aria-label="닫기"><IconX /></button>
      </div>
      <div className="ai-body">
        <FrtuStrip snap={snap} value={frtu} onPick={onPick} />
        <span className={`ai-chip ${alarm ? 'alarm' : ''}`}>
          <Status tone={f.fi !== 'NONE' ? 'err' : NODE_TONE[f.status]} live={alarm}>{STATUS_LABEL[f.status]} · {FI_LABEL[f.fi]}</Status>
        </span>
        {f.available ? (
          <dl className="ai-kv">
            <div><dt>측정 전류</dt><dd>{(f.i * 1000).toFixed(1)} mA</dd></div>
            <div><dt>예상 전류</dt><dd>{(f.expected * 1000).toFixed(1)} mA</dd></div>
            <div><dt>전압</dt><dd>{f.v.toFixed(2)} V</dd></div>
            <div><dt>이상 점수</dt><dd>{f.score.toFixed(2)}</dd></div>
            <div><dt>마지막 AI 판정</dt><dd>{!v ? '—' : v.kind === 'ANSWERED' ? v.labelKo : v.kind === 'WITHHELD' ? '보류' : v.kind === 'NO_MODEL' ? '모델 학습 전' : '입력 거부'}</dd></div>
          </dl>
        ) : (
          <p className="small muted">{f.unavailableReason}</p>
        )}
        <FaultLocationBox snap={snap} />
        {frtu === 'inlet' && <p className="xs muted">{snap.source === 'MOCK' ? '시뮬레이터 값입니다.' : snap.zones ? '인입값은 두 분기 실측값을 합산한 값입니다.' : '인입값은 응답한 센서 하나의 실측값입니다.'} 직류 모형 계측이며 교류 고장파형 분석과는 별도입니다.</p>}
      </div>
      <Link to={`/frtu?id=${frtu}`} className="ai-more">FRTU 상세 열기 <IconArrowRight /></Link>
    </aside>
  )
}
