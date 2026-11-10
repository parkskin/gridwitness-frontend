import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { getVillagePersistence, listVillageRecords } from '../api/village'
import { Empty, ErrorState, Metric, Metrics, NODE_TONE, PageHeader, Section, Segmented, Status, TableSkeleton } from '../components/ui'
import { fmtTime } from '../lib/actor'
import { apiBase } from '../lib/backend'
import { calibrateLedA, DEFAULT_LED_A, DEFAULT_THRESHOLDS, DEVICE_INFO, IOT_CHANNELS, ledA, resetThresholds, setLedA, setThresholds, SOURCE_LABEL, STATUS_LABEL, TICK_MS, useVillage } from '../lib/village'
import { CASE_TYPE_LABEL, type ActivityItem, type CaseSummary, type CaseType } from '../types'

/** 슬라이더 + 숫자 + 설명이 한 줄인 설정 항목 */
function Setting({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="strong">{label}</div>
        <div className="small muted">{hint}</div>
      </div>
      <div className="setting-ctl">{children}</div>
    </div>
  )
}

export default function Admin() {
  const snap = useVillage()
  const [cases, setCases] = useState<CaseSummary[] | null>(null)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'ALL' | CaseType>('ALL')
  const [saved, setSaved] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [exporting, setExporting] = useState(false)
  const th = snap.thresholds

  const load = useCallback(() => {
    setError(null)
    Promise.all([api.listCases(), api.listActivity()])
      .then(([c, a]) => {
        setCases(c)
        setActivity(a)
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const flash = (msg: string) => {
    setSaved(msg)
    setTimeout(() => setSaved(null), 2200)
  }

  async function exportAll() {
    setExporting(true)
    setError(null)
    try {
      const all = await api.exportCases()
      const villageRecords = []
      for (const kind of ['event', 'incident', 'iot_case'] as const) {
        villageRecords.push(...await listVillageRecords(kind))
        if (getVillagePersistence().error) throw new Error(getVillagePersistence().error!)
      }
      const blob = new Blob([JSON.stringify({ schema: 'gridwitness-backup-v2', exportedAt: new Date().toISOString(), server: apiBase(), scope: '서버 사건(보관 포함)·원본 파형·진단·최신 분석·검토·감사·대화·현장 메모·COMTRADE 원본·마을 원시 사건·처리 단계 및 브라우저 전송 대기 기록', cases: all, villageRecords, pendingVillageRecords: getVillagePersistence().pending }, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `gridwitness-cases-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      flash(`사건 ${all.length}건·마을 기록 ${villageRecords.length}건을 내보냈습니다.`)
    } catch (e) { setError(`전체 내보내기를 완료하지 못했습니다. ${(e as Error).message}`) }
    finally { setExporting(false) }
  }

  const pending = cases?.filter((c) => c.stage !== 'REVIEWED').length ?? 0
  const openEvents = snap.events.filter((e) => !e.clearedAt).length
  const filtered = activity?.filter((a) => filter === 'ALL' || a.caseType === filter)
  const shown = more ? filtered : filtered?.slice(0, 12)
  const thInvalid = th.warn >= th.fault
  const changed = th.warn !== DEFAULT_THRESHOLDS.warn || th.fault !== DEFAULT_THRESHOLDS.fault || th.vMin !== DEFAULT_THRESHOLDS.vMin

  return (
    <>
      <PageHeader title="관리자" description="이상 탐지 기준, 활동 기록, 데이터를 관리합니다." actions={saved && <span className="small" style={{ color: 'var(--ok)' }} role="status">{saved}</span>} />

      <Metrics>
        <Metric label="장치" value={<Status tone={snap.connected ? 'ok' : 'err'} live={snap.connected}><span style={{ fontSize: 20, fontWeight: 600 }}>{snap.connected ? '연결됨' : '끊김'}</span></Status>} foot={`${SOURCE_LABEL[snap.source]} · ${DEVICE_INFO[snap.source].deviceId}`} />
        <Metric label="마을 상태" value={<Status tone={NODE_TONE[snap.status]}><span style={{ fontSize: 20, fontWeight: 600 }}>{STATUS_LABEL[snap.status]}</span></Status>} foot={`수신 ${snap.packets.toLocaleString()}회 · ${1000 / TICK_MS} Hz`} />
        <Metric label="진행 중 이상" value={openEvents} unit="건" foot={`누적 ${snap.events.length}건`} />
        <Metric label="검토 대기 사건" value={cases ? pending : '–'} unit="건" foot={cases ? `전체 ${cases.length}건` : ' '} />
      </Metrics>

      <div className="section">
        <Section title="이상 탐지 기준" description="바꾸면 바로 실시간 판정과 새 사건에 적용됩니다. 이 브라우저에 저장됩니다." actions={changed && <button className="btn btn-sm" onClick={() => { resetThresholds(); flash('기본값으로 되돌렸습니다.') }}>기본값</button>}>
          <div className="stack" style={{ gap: 0 }}>
            <Setting label="주의 기준 (이상 점수)" hint="이 점수 이상이면 '주의'로 표시">
              <input type="range" min={0.05} max={0.95} step={0.05} value={th.warn} onChange={(e) => setThresholds({ warn: Number(e.target.value) })} aria-label="주의 기준" />
              <b className="num">{th.warn.toFixed(2)}</b>
            </Setting>
            <Setting label="이상 기준 (이상 점수)" hint="이 점수 이상이면 '이상'으로 표시하고 이벤트 기록">
              <input type="range" min={0.1} max={1} step={0.05} value={th.fault} onChange={(e) => setThresholds({ fault: Number(e.target.value) })} aria-label="이상 기준" />
              <b className="num">{th.fault.toFixed(2)}</b>
            </Setting>
            <Setting label="전압 하한 (V)" hint="릴레이가 닫혀 있는데 이 전압 아래면 점수 상승">
              <input type="range" min={2.5} max={5} step={0.05} value={th.vMin} onChange={(e) => setThresholds({ vMin: Number(e.target.value) })} aria-label="전압 하한" />
              <b className="num">{th.vMin.toFixed(2)}</b>
            </Setting>
          </div>
          {thInvalid && <div className="alert alert-err" role="alert">주의 기준({th.warn.toFixed(2)})이 이상 기준({th.fault.toFixed(2)})보다 작아야 합니다. 이 상태로는 저장되지 않습니다.</div>}
          <p className="hint">현재 이상 점수 <b className="num">{snap.score.toFixed(2)}</b> → {STATUS_LABEL[snap.status]} · 기준을 너무 낮추면 정상 변동도 이상으로 기록됩니다.</p>
        </Section>
      </div>

      <div className="section">
        <Section
          title="LED 기준 전류"
          description="LED 1개가 흘리는 전류입니다. 예상 전류·켜진 LED 수·채널 점검 판정이 모두 이 값을 기준으로 합니다. 실제 LED와 저항, 전원 전압에 따라 크게 달라서 실물에 맞춰야 합니다."
          actions={ledA() !== DEFAULT_LED_A && <button className="btn btn-sm" onClick={() => { setLedA(DEFAULT_LED_A); flash('기본값으로 되돌렸습니다.') }}>기본값</button>}
        >
          <div className="stack" style={{ gap: 0 }}>
            <Setting label="LED 1개 기준 전류 (mA)" hint={`기본 ${(DEFAULT_LED_A * 1000).toFixed(0)} mA. 220Ω 저항을 단 일반 LED는 보통 7~15 mA입니다.`}>
              <input type="number" min={2} max={300} step={0.5} value={Number((ledA() * 1000).toFixed(1))} onChange={(e) => setLedA(Number(e.target.value) / 1000)} aria-label="LED 1개 기준 전류" style={{ width: 96 }} />
              <b className="num">{(ledA() * 1000).toFixed(1)} mA</b>
            </Setting>
            <Setting label="지금 값으로 맞추기" hint="LED가 모두 정상으로 켜진 상태에서 누르세요. 현재 전류를 켜진 LED 수로 나눠 기준으로 삼고, 전원 전압이 하한보다 낮게 측정되면 하한도 맞춰 줍니다.">
              <button
                className="btn btn-primary"
                disabled={!snap.connected || snap.status === 'NO_DATA' || !snap.relay}
                onClick={() => {
                  const r = calibrateLedA()
                  flash(r.ok ? `LED 1개 ${(r.a * 1000).toFixed(1)} mA로 맞췄습니다 (LED ${r.n}개 기준).${r.vMin !== null ? ` 전압 하한도 ${r.vMin.toFixed(2)} V로 낮췄습니다.` : ''}` : r.reason)
                }}
              >
                지금 값으로 맞추기
              </button>
            </Setting>
          </div>
          <p className="hint">{snap.measurementScope === 'HOUSE' ? '주택 분기 실측 전류' : '지금 전류'} <b className="num">{snap.i.toFixed(3)} A</b> · {snap.measurementScope === 'HOUSE' ? '주택에서 켜진' : '켜진'} 채널 {snap.measurementScope === 'HOUSE' ? IOT_CHANNELS.filter((c) => c.kind === 'HOUSE' && snap.channels[c.id]).length : Object.values(snap.channels).filter(Boolean).length}개 → 예상 <b className="num">{snap.expected.toFixed(3)} A</b></p>
        </Section>
      </div>

      <Section
        title="활동 기록"
        description="모든 사건의 등록·진단·분석·검토 이력을 최신순으로 봅니다."
        actions={
          <Segmented value={filter} onChange={setFilter} options={[{ value: 'ALL', label: '전체' }, { value: 'IOT', label: 'IoT' }, { value: 'WAVEFORM', label: '고장파형' }]} />
        }
      >
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !shown ? (
          <TableSkeleton rows={5} />
        ) : shown.length === 0 ? (
          <Empty compact title="기록이 없습니다" description="사건을 등록하거나 검토하면 여기에 쌓입니다." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>시각</th><th>작업자</th><th>작업</th><th>사건</th></tr></thead>
              <tbody>
                {shown.map((a, k) => (
                  <tr key={`${a.caseId}-${a.at}-${k}`}>
                    <td className="small muted num" style={{ whiteSpace: 'nowrap' }}>{fmtTime(a.at)}</td>
                    <td>{a.actor}</td>
                    <td>
                      <span className="strong">{a.action}</span>
                      {a.detail && <div className="xs muted">{a.detail}</div>}
                    </td>
                    <td>
                      <Link to={`/cases/${a.caseId}`}>{a.caseTitle}</Link>
                      <div className="xs muted">{CASE_TYPE_LABEL[a.caseType]} · <span className="mono">{a.caseId}</span></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered && filtered.length > 12 && (
              <div style={{ textAlign: 'center', paddingTop: 12 }}>
                <button className="btn btn-sm" onClick={() => setMore(!more)}>{more ? '접기' : `더 보기 (${filtered.length - 12}건)`}</button>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="데이터 관리" description="서버에 보관된 사건과 원본 파형·분석·검토·대화·메모, 마을 사건의 원시 기록과 처리 단계를 함께 내보냅니다. 조회 실패 시 부분 백업을 전체 백업으로 저장하지 않습니다.">
        <div className="cluster">
          <button className="btn" onClick={exportAll} disabled={exporting}>{exporting ? '서버 전체 기록 확인 중…' : '사건 전체 내보내기 (JSON)'}</button>
          <Link to="/settings" className="btn btn-ghost">목록 비우기 (설정)</Link>
        </div>
      </Section>
    </>
  )
}
