import { useMemo, useState } from 'react'
import { useMedia } from '../lib/useMedia'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CHART } from '../lib/chart'
import { ErrorState, Section } from './ui'
import { getKepcoUsagePage } from '../api/kepcoUsage'

// 서버가 프록시하는 한전 공공데이터(15069679, 월별 판매량). 화면에서 직접 모아 보여주며, 값은 가공하지 않고 합산만 한다.

interface Loaded {
  rows: { period: string; region: string; district: string; contract: string; value: number }[]
  total: number
  blank: number
}

const PER_PAGE = 1000
const compact = (s: string) => s.replace(/\s+/g, '')
const fmt = (n: number) => Math.round(n).toLocaleString()

async function fetchAll(): Promise<Loaded> {
  const head = await getKepcoUsagePage(1, PER_PAGE)
  const pages = Math.ceil(head.total_count / PER_PAGE)
  const rest = await Promise.all(Array.from({ length: pages - 1 }, async (_, k) => (await getKepcoUsagePage(k + 2, PER_PAGE)).records))
  const all = [...head.records, ...rest.flat()]
  // 값이 빈 줄은 원본에 있는 빈 행이라 제외하고 개수만 알려준다
  const valid = all.filter((r) => r.period && r.sales_amount !== '' && Number.isFinite(Number(r.sales_amount.replace(/,/g, ''))))
  return {
    rows: valid.map((r) => ({ period: r.period, region: r.region, district: r.district, contract: compact(r.contract_type), value: Number(r.sales_amount.replace(/,/g, '')) })),
    total: head.total_count,
    blank: all.length - valid.length,
  }
}

export default function KepcoReal() {
  const narrow = useMedia('(max-width: 600px)')
  const [data, setData] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState('')
  const [contract, setContract] = useState('주택용')
  const [region, setRegion] = useState<string | null>(null)

  async function load() {
    setBusy(true)
    setError(null)
    try {
      const d = await fetchAll()
      setData(d)
      setPeriod([...new Set(d.rows.map((r) => r.period))].sort().at(-1) ?? '')
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? '서버에 연결할 수 없습니다. 설정에서 서버 주소와 상태를 확인하세요.' : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const periods = useMemo(() => (data ? [...new Set(data.rows.map((r) => r.period))].sort() : []), [data])
  const contracts = useMemo(() => (data ? [...new Set(data.rows.map((r) => r.contract))].sort() : []), [data])
  const byRegion = useMemo(() => {
    const m = new Map<string, number>()
    data?.rows.filter((r) => r.period === period && r.contract === contract).forEach((r) => m.set(r.region, (m.get(r.region) ?? 0) + r.value))
    return [...m].map(([name, total]) => ({ name, label: name.replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, ''), total })).sort((a, b) => b.total - a.total)
  }, [data, period, contract])
  const districts = useMemo(
    () => (data && region ? data.rows.filter((r) => r.period === period && r.contract === contract && r.region === region).sort((a, b) => b.value - a.value).slice(0, 8) : []),
    [data, period, contract, region],
  )

  return (
    <Section
      title="한전 공공데이터 (서버 연결)"
      description="서버가 한전 전력 판매량 공공데이터(월별·지역·계약종별)를 가져옵니다. 아래는 실제 공공데이터입니다."
      actions={<button className="btn btn-sm" onClick={load} disabled={busy}>{busy ? '불러오는 중…' : data ? '다시 불러오기' : '서버에서 불러오기'}</button>}
    >
      {error && <ErrorState message={error} onRetry={load} />}
      {!data && !error && <p className="muted small">버튼을 누르면 서버에서 약 11,000행을 받아옵니다 (수 초 걸릴 수 있음).</p>}
      {data && (
        <>
          <div className="cluster" style={{ marginBottom: 12 }}>
            <label className="field">기준월<select value={period} onChange={(e) => setPeriod(e.target.value)}>{periods.map((p) => <option key={p}>{p}</option>)}</select></label>
            <label className="field">계약종<select value={contract} onChange={(e) => setContract(e.target.value)}>{contracts.map((c) => <option key={c}>{c}</option>)}</select></label>
          </div>
          <div className="bar-chart">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={byRegion} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="label" interval={0} axisLine={false} tickLine={false} tick={{ ...CHART.tick, fontSize: 10.5 }} angle={narrow ? -90 : 0} textAnchor={narrow ? 'end' : 'middle'} height={narrow ? 40 : 30} />
                <YAxis axisLine={false} tickLine={false} tick={CHART.tick} width={64} tickFormatter={(v) => `${(Number(v) / 1e6).toFixed(0)}M`} />
                <Tooltip cursor={{ fill: 'rgba(49,87,224,0.07)' }} formatter={(v) => [fmt(Number(v)), '판매량']} labelFormatter={(_, p) => (p?.[0]?.payload as { name?: string })?.name ?? ''} />
                <Bar dataKey="total" radius={[4, 4, 0, 0]} isAnimationActive={false} cursor="pointer" onClick={(d: unknown) => setRegion((d as { name?: string })?.name ?? null)}>
                  {byRegion.map((d) => <Cell key={d.name} fill={d.name === region ? CHART.accent : '#e0e2e8'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {region ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>{region} · 시군구 상위 {districts.length}곳</th><th className="num">판매량</th></tr></thead>
                <tbody>{districts.map((d) => <tr key={d.district}><td>{d.district}</td><td className="num">{fmt(d.value)}</td></tr>)}</tbody>
              </table>
            </div>
          ) : (
            <p className="hint">막대를 누르면 그 지역의 시군구 순위가 나옵니다.</p>
          )}
          <p className="hint">
            전체 {data.total.toLocaleString()}행 중 값이 빈 행 {data.blank.toLocaleString()}개는 제외했습니다. 원본 자료에 월 6개(2020년 1·2·3·10·11·12월)만 있으며, 단위는 원본에 표기되지 않아 판매량 값 그대로 표시합니다(kWh로 추정되지만 확인하지 못함). 이상 탐지 근거로 쓰지 않습니다.
          </p>
        </>
      )}
    </Section>
  )
}
