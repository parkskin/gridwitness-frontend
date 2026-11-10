import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CHART } from '../lib/chart'
import type { LiveIncident } from '../lib/liveIncident'

type Ch = 'inlet' | 'house' | 'lamp'
const CH: { key: Ch; label: string; color: string }[] = [
  { key: 'inlet', label: '인입', color: '#2f6bff' },
  { key: 'house', label: '주택 분기', color: '#e08a1e' },
  { key: 'lamp', label: '가로등 분기', color: '#24835a' },
]
// 중앙값: 잠깐 튄 값에 끌려가지 않게
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface CompareRow { s: number; inlet: number | null; house: number | null; lamp: number | null }

/** 사건 기록 → 비교용 행 (0초 = 고장표시 발생) */
export const incidentRows = (inc: LiveIncident): CompareRow[] =>
  inc.points.map((p) => ({ s: +((p.t - inc.startedAt) / 1000).toFixed(1), inlet: inc.measurementScope === 'BOTH' ? p.i * 1000 : null, house: p.ih != null ? p.ih * 1000 : null, lamp: p.il != null ? p.il * 1000 : null }))

/** 평소(0초 전) 파형과 지금(0초 후) 파형을 같은 눈금으로 나란히 비교 */
export default function WaveCompare({ rows, zeroLabel = '고장표시 발생' }: { rows: CompareRow[]; zeroLabel?: string }) {
  const before = rows.filter((r) => r.s < 0)
  const after = rows.filter((r) => r.s >= 0)
  const chs = CH.filter((c) => rows.some((r) => r[c.key] != null))
  const stat = (rs: typeof rows, k: Ch) => {
    const xs = rs.map((r) => r[k]).filter((x): x is number => x != null)
    return { mean: median(xs) }
  }
  const lines = chs.map((c) => ({ ...c, b: stat(before, c.key), a: stat(after, c.key) }))
  // 가장 크게 변한 채널 (평균 차이 기준)
  const top = lines
    .filter((l) => l.b.mean != null && l.a.mean != null)
    .sort((x, y) => Math.abs(y.a.mean! - y.b.mean!) - Math.abs(x.a.mean! - x.b.mean!))[0]
  const max = Math.max(10, ...rows.flatMap((r) => chs.map((c) => r[c.key] ?? 0)))
  const domain: [number, number] = [0, Math.ceil(max * 1.1)]

  const Mini = ({ data, title, sub }: { data: typeof rows; title: string; sub: string }) => (
    <div className="wc-pane">
      <div className="wc-head"><strong>{title}</strong><span className="xs muted">{sub}</span></div>
      {data.length < 2 ? (
        <p className="small muted" style={{ margin: '24px 0' }}>아직 표본이 부족해요.</p>
      ) : (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={data} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="s" type="number" domain={['dataMin', 'dataMax']} unit="s" tick={CHART.tick} axisLine={false} tickLine={false} />
            <YAxis tick={CHART.tick} axisLine={false} tickLine={false} width={40} domain={domain} />
            <Tooltip formatter={(x) => (typeof x === 'number' ? `${x.toFixed(1)} mA` : x)} labelFormatter={(t) => `${t} s`} />
            {chs.map((c) => <Line key={c.key} name={c.label} dataKey={c.key} stroke={c.color} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls />)}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )

  const fmt = (x: number | null) => (x == null ? '—' : `${x.toFixed(1)} mA`)
  return (
    <div className="wc">
      <div className="wc-title">
        <strong>평소 파형 vs 지금 파형</strong>
        <span className="xs muted" title="같은 눈금(mA) · 평소·지금 값은 중앙값">0초 = {zeroLabel}</span>
      </div>
      <div className="wc-grid">
        <Mini data={before} title="평소" sub={before.length ? `발생 전 ${Math.abs(before[0].s).toFixed(0)}초` : '기록 없음'} />
        <Mini data={after} title="지금" sub={`발생 후 ${after.length ? after[after.length - 1].s.toFixed(0) : 0}초`} />
      </div>
      <table className="wc-table">
        <thead><tr><th></th><th>평소</th><th>지금</th><th>변화</th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const d = l.b.mean != null && l.a.mean != null ? l.a.mean - l.b.mean : null
            const pct = d != null && l.b.mean! > 1 ? (d / l.b.mean!) * 100 : null
            return (
              <tr key={l.key} className={top?.key === l.key ? 'hl' : ''}>
                <th><i style={{ background: l.color }} />{l.label}</th>
                <td className="num">{fmt(l.b.mean)}</td>
                <td className="num">{fmt(l.a.mean)}</td>
                <td className={`num ${d != null && Math.abs(d) >= 5 ? (d > 0 ? 'up' : 'down') : ''}`}>{d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)} mA${pct != null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)` : ''}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {top && top.b.mean != null && top.a.mean != null && Math.abs(top.a.mean - top.b.mean) >= 5 && (
        <p className="small" style={{ margin: '8px 0 0' }}>
          가장 크게 바뀐 곳: <b>{top.label}</b> {fmt(top.b.mean)} → {fmt(top.a.mean)}
        </p>
      )}
    </div>
  )
}
