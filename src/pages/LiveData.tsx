import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Channels from '../components/Channels'
import EventList from '../components/EventList'
import HardwareFlow from '../components/HardwareFlow'
import { Badge, Metric, Metrics, NODE_TONE, Section, Status } from '../components/ui'
import { CHART } from '../lib/chart'
import { connectSerial, IOT_CHANNELS, ledA, NOMINAL_V, STATUS_LABEL, switchToMock, THRESHOLDS, TICK_MS, useVillage, ZONE_LABEL, ZONE_SENSOR, zoneChannels } from '../lib/village'

/** 예전 주소(/live)는 FRTU 상세의 실시간 분석 탭으로 */
export default function LiveData() {
  return <Navigate to="/frtu?tab=live" replace />
}

/** 장치 값이 없을 때: 0과 빈 그래프 대신 연결 방법만 보여줌 */
export function DeviceConnectCard({ real, reconnecting, scopeUnknown = false }: { real: boolean; reconnecting: boolean; scopeUnknown?: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="live-empty">
      <div>
          <strong>{real ? reconnecting ? '장치를 다시 찾는 중이에요' : scopeUnknown ? '센서 측정 범위를 확인하지 못했어요' : '장치에서 측정값을 받지 못하고 있어요' : '시뮬레이터 통신이 끊긴 상태예요'}</strong>
          <p>{real ? scopeUnknown ? 'UNO의 INA219 주소 안내가 필요합니다. 최신 GridWitness 스케치를 올리고 다시 연결하세요. 범위가 확인될 때까지 분석과 사건 저장을 보류합니다.' : 'USB 케이블과 Arduino 전원을 확인하고 다시 연결하세요. 모형 없이 화면만 보려면 시뮬레이터를 쓰면 돼요.' : '마을 화면 제어판의 고장 시뮬레이션에서 전체 복구를 누르세요.'}</p>
      </div>
      {real && (
        <div className="live-empty-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => { setBusy(true); void connectSerial().finally(() => setBusy(false)) }}>{busy ? '연결 중…' : '실측 장치 연결'}</button>
          <button className="btn" onClick={() => void switchToMock()}>시뮬레이터로 보기</button>
          <Link to="/settings" className="small">연결 진단 →</Link>
        </div>
      )}
    </div>
  )
}

/** 실시간 분석: 판정, 전류·전압 추이, 채널 상태, 점수가 나온 이유, 경고 이력. FRTU 상세의 탭으로 보여줌.
 *  compact: 3D 마을 제어판용. 제어판에 이미 있는 채널 제어·이상 이벤트와 전압 그래프·판정 근거는 빼고 한 줄로 쌓음 */
export function LiveAnalysis({ compact = false }: { compact?: boolean }) {
  const snap = useVillage()
  const t0 = snap.history[0]?.t ?? 0
  const data = snap.history.map((h) => ({
    s: +((h.t - t0) / 1000).toFixed(1),
    i: +h.i.toFixed(3),
    expected: +h.expected.toFixed(3),
    v: +h.v.toFixed(2),
    score: +h.score.toFixed(2),
  }))
  const unit = ledA()
  const residual = snap.i - snap.expected
  const ledUnits = residual / unit
  const axis = { tick: CHART.tick, axisLine: CHART.axisLine, tickLine: CHART.tickLine }
  const scoreColor = (s: number) => (s >= THRESHOLDS.fault ? CHART.err : s >= THRESHOLDS.warn ? CHART.warn : CHART.ink)
  const seconds = Math.round((snap.history.length * TICK_MS) / 1000)
  const noData = snap.status === 'NO_DATA'
  const real = snap.source === 'SERIAL'
  const onCount = Object.values(snap.channels).filter(Boolean).length
  const measuredOnCount = real && snap.measurementScope === 'HOUSE' ? IOT_CHANNELS.filter((c) => c.kind === 'HOUSE' && snap.channels[c.id]).length : onCount
  const lowV = snap.relay && snap.v < THRESHOLDS.vMin && !noData

  // 점수가 나온 이유: 전류 차이와 전압 강하 중 큰 쪽이 점수가 된다 (lib/village.ts anomalyScore와 같은 식)
  const byCurrent = Math.min(1, Math.abs(residual) / (unit * 2))
  const byVoltage = snap.expected > 0 ? Math.min(1, Math.max(0, THRESHOLDS.vMin - snap.v) / 0.75) : 0

  // 예상 전류가 계단처럼 바뀐 지점 = 채널을 켜거나 끈 순간. 그래프에 표시해서 전류가 왜 변했는지 알 수 있게 함
  const marks: { s: number; text: string }[] = []
  for (let k = 1; k < snap.history.length; k++) {
    const n = Math.round((snap.history[k].expected - snap.history[k - 1].expected) / unit)
    if (n !== 0 && Math.abs(n) <= 5) marks.push({ s: data[k].s, text: `${n > 0 ? '+' : ''}${n} LED` })
  }
  const recentMarks = marks.slice(-6)

  const tip = (unitText: string, digits: number) => ({
    formatter: (v: unknown, name: unknown) => [`${Number(v).toFixed(digits)} ${unitText}`, String(name)] as [string, string],
    labelFormatter: (l: unknown) => `${l}초`,
  })

  if (noData)
    return (
      <div className="live">
        <DeviceConnectCard real={real} reconnecting={snap.reconnecting} scopeUnknown={real && snap.connected && snap.measurementScope === 'UNKNOWN'} />
        {!compact && <HardwareFlow />}
      </div>
    )

  return (
    <div className="live">
      <div className="live-meta">
        <Badge tone={real ? 'accent' : 'neutral'}>{real ? '실측 장치' : '시뮬레이터'}</Badge>
        <span className="small muted">{real && snap.measurementScope === 'HOUSE' ? '주택 분기 실측과 주택 채널 기준을 비교합니다 · 가로등은 릴레이 상태만 표시하며 분석·전류 기록에서 제외' : '켜 둔 LED 조합의 정상 전류와 실제 전류를 비교해 이상 점수를 내요'} · 최근 {seconds}초</span>
      </div>

      <Metrics cols={compact ? 2 : 4}>
        <Metric
          label="판정"
          value={<Status tone={NODE_TONE[snap.status]} live={snap.status === 'WARNING' || snap.status === 'FAULT' || snap.status === 'OUTAGE'}><span style={{ fontSize: 22, fontWeight: 600 }}>{STATUS_LABEL[snap.status]}</span></Status>}
          foot={<>이상 점수 <b className="num" style={{ color: scoreColor(snap.score) }}>{snap.score.toFixed(2)}</b> · 주의 ≥ {THRESHOLDS.warn} · 이상 ≥ {THRESHOLDS.fault}</>}
        />
        <Metric
          label={real && snap.measurementScope === 'HOUSE' ? '주택 분기 실측 전류' : '전류'}
          value={snap.i.toFixed(3)}
          unit={`A / 예상 ${snap.expected.toFixed(3)}`}
          foot={<span className={Math.abs(residual) > unit * 0.6 ? 'bad' : ''}>차이 {residual >= 0 ? '+' : ''}{residual.toFixed(3)} A · LED {ledUnits >= 0 ? '+' : ''}{ledUnits.toFixed(1)}개 분량</span>}
        />
        <Metric
          label="전압"
          value={snap.v.toFixed(2)}
          unit="V"
          foot={<span className={lowV ? 'bad' : ''}>{lowV ? `하한 ${THRESHOLDS.vMin.toFixed(2)} V보다 낮음` : `하한 ${THRESHOLDS.vMin.toFixed(2)} V · 정격 ${NOMINAL_V} V`}</span>}
        />
        <Metric label="켜진 LED" value={snap.estLit} unit={real && snap.measurementScope === 'HOUSE' ? '/ 3 (주택 추정)' : '/ 5 (추정)'} foot={`릴레이 채널 ${onCount}개 켜짐 · ${snap.p.toFixed(2)} W${real && snap.measurementScope === 'HOUSE' ? ' · 전력은 주택 센서값 기준' : ''}`} />
      </Metrics>

      {!compact && <div className="section">
        <Section
          title="채널 현황"
          description={snap.canControl ? '스위치로 LED를 끄고 켜면 아래 그래프에 바로 나타나요.' : '이 장치는 채널 상태를 보고하지 않아 조종할 수 없어요.'}
          actions={<Link to="/village/loads" className="small">채널 점검 →</Link>}
        >
          <Channels snap={snap} controls />
        </Section>
      </div>}

      <div className={compact ? 'stack section' : 'grid-2 section'}>
        <Section title="예상 대비 실제 전류" description={real && snap.measurementScope === 'HOUSE' ? '주택 분기 실측 · 가로등 전류 미포함' : snap.zones && snap.measurementScope === 'BOTH' ? '마을 전체 합계' : '확인된 INA219 계측값'}>
          <div className="legend" style={{ marginBottom: 8 }}>
            <span><i style={{ background: CHART.ink }} />실제</span>
            <span style={{ color: CHART.secondary }}><i className="dash" />예상</span>
            {recentMarks.length > 0 && <span className="muted">세로선 = 채널을 켜거나 끈 시점</span>}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 14, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="s" unit="s" type="number" domain={['dataMin', 'dataMax']} {...axis} />
              <YAxis unit="A" domain={[0, (max: number) => Math.max(max * 1.25, unit * 2)]} tickFormatter={(x: number) => x.toFixed(3)} {...axis} width={58} />
              <Tooltip {...tip('A', 3)} />
              {recentMarks.map((m) => (
                <ReferenceLine key={m.s} x={m.s} stroke={CHART.secondary} strokeDasharray="2 3" label={{ value: m.text, position: 'top', fontSize: 10, fill: '#7b808b' }} />
              ))}
              <Line name="실제 전류" dataKey="i" stroke={CHART.ink} dot={false} strokeWidth={1.75} isAnimationActive={false} />
              <Line name="예상 전류" dataKey="expected" stroke={CHART.secondary} strokeDasharray="4 4" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Section>
        <Section title="이상 점수" description="0 = 예상대로, 1 = LED 2개 분량 이상 차이 또는 큰 전압 강하">
          <div className="legend" style={{ marginBottom: 8 }}>
            <span style={{ color: CHART.warn }}><i className="dash" />주의 {THRESHOLDS.warn}</span>
            <span style={{ color: CHART.err }}><i className="dash" />이상 {THRESHOLDS.fault}</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 14, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="s" unit="s" type="number" domain={['dataMin', 'dataMax']} {...axis} />
              <YAxis domain={[0, 1]} {...axis} width={58} />
              <Tooltip {...tip('', 2)} />
              <ReferenceLine y={THRESHOLDS.warn} stroke={CHART.warn} strokeDasharray="3 4" />
              <ReferenceLine y={THRESHOLDS.fault} stroke={CHART.err} strokeDasharray="3 4" />
              <Line name="이상 점수" dataKey="score" stroke={CHART.ink} dot={false} strokeWidth={1.75} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Section>
      </div>

      <div className={compact ? 'stack section' : 'grid-2 section'}>
        {!compact && <Section title="전압" description={`릴레이가 닫혀 있는데 ${THRESHOLDS.vMin.toFixed(2)} V 아래로 내려가면 점수가 오릅니다.`}>
          <div className="legend" style={{ marginBottom: 8 }}>
            <span><i style={{ background: CHART.ink }} />전압</span>
            <span style={{ color: CHART.err }}><i className="dash" />하한 {THRESHOLDS.vMin.toFixed(2)} V</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="s" unit="s" type="number" domain={['dataMin', 'dataMax']} {...axis} />
              <YAxis unit="V" domain={[0, (max: number) => Math.max(max * 1.1, NOMINAL_V + 0.5)]} tickFormatter={(x: number) => x.toFixed(1)} {...axis} width={52} />
              <Tooltip {...tip('V', 2)} />
              <ReferenceLine y={THRESHOLDS.vMin} stroke={CHART.err} strokeDasharray="3 4" />
              <Line name="전압" dataKey="v" stroke={CHART.ink} dot={false} strokeWidth={1.75} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Section>}
        <Section title="이상 점수가 나온 이유" description="전류 차이와 전압 강하 중 더 큰 쪽이 점수가 됩니다.">
          <div className="stack" style={{ gap: 14 }}>
            <Reason label="전류 차이" value={byCurrent} text={`실제와 예상이 ${Math.abs(residual).toFixed(3)} A 다름 (LED ${Math.abs(ledUnits).toFixed(1)}개 분량, 2개 분량이면 1.0)`} color={scoreColor(byCurrent)} />
            <Reason label="전압 강하" value={byVoltage} text={snap.expected > 0 ? `하한 ${THRESHOLDS.vMin.toFixed(2)} V 대비 ${snap.v.toFixed(2)} V` : '릴레이가 열려 있어 전압은 보지 않음'} color={scoreColor(byVoltage)} />
            <p className="hint" style={{ margin: 0 }}>
              LED 1개 기준 전류는 <b className="num">{(unit * 1000).toFixed(1)} mA</b>입니다. 실제와 다르면 <Link to="/admin">관리자</Link>에서 보정하세요.
            </p>
          </div>
        </Section>
      </div>

      {!compact && <>
      <Section title="판정 근거" description="장치와 구간별 측정 상태입니다.">
        <dl className="dl-rows">
          <div><dt>릴레이</dt><dd>{snap.relay ? '닫힘 — 마을에 전원 공급' : '열림 — 마을 전체 차단'}</dd></div>
          <div><dt>예상 전류</dt><dd className="num">{snap.expected.toFixed(3)} A <span className="muted">({real && snap.measurementScope === 'HOUSE' ? '주택에서 켜진' : '켜진'} 채널 {measuredOnCount}개 × {unit.toFixed(3)} A)</span></dd></div>
          {snap.zones &&
            (['HOUSE', 'LAMP'] as const).map((k) => {
              const z = snap.zones![k]
              if (!z) return null
              const d = z.i - z.expected
              return (
                <div key={k}>
                  <dt>{ZONE_LABEL[k]} <span className="muted xs">{ZONE_SENSOR[k]}</span></dt>
                  <dd className="num">
                    {z.i.toFixed(3)} A / 예상 {z.expected.toFixed(3)} A · <span className={Math.abs(d) > unit * 0.6 ? 'text-bad' : ''}>차이 {d >= 0 ? '+' : ''}{d.toFixed(3)} A</span> · LED {z.estLit}/{zoneChannels(k).length} · 점수 {z.score.toFixed(2)}
                  </dd>
                </div>
              )
            })}
          {!snap.zones && real && <div><dt>센서 범위</dt><dd>{snap.measurementScope === 'HOUSE' ? '주택 분기 실측만 분석합니다. 가로등은 전류 미측정이며 릴레이 상태만 표시합니다.' : snap.measurementScope === 'LAMP' ? '가로등 분기 실측만 분석합니다.' : '센서 주소를 확인할 수 없어 분기 판정을 보류합니다.'} <Link to="/village/loads">채널 점검</Link></dd></div>}
        </dl>
      </Section>

      <Section title="경고 이력" description="이상 구간을 사건으로 등록하면 계측 기록 그대로 검토 단계로 넘어갑니다.">
        <EventList events={snap.events} limit={20} />
      </Section>

      <HardwareFlow />
      </>}
    </div>
  )
}

function Reason({ label, value, text, color }: { label: string; value: number; text: string; color: string }) {
  return (
    <div>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="strong">{label}</span>
        <span className="num small" style={{ color }}>{value.toFixed(2)}</span>
      </div>
      <div className="bar"><div style={{ width: `${value * 100}%`, background: color }} /></div>
      <div className="small muted" style={{ marginTop: 4 }}>{text}</div>
    </div>
  )
}
