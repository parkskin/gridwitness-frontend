import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { buildIotCase } from '../api/iotCase'
import { Steps } from '../components/Badges'
import IssueList from '../components/IssueList'
import Sparkline from '../components/Sparkline'
import { Badge, DIAG_LABEL, DIAG_TONE, Metric, Metrics, NODE_TONE, Section, Status } from '../components/ui'
import { getActor } from '../lib/actor'
import { DEVICE_INFO, IOT_CHANNELS, IOT_MODEL, ledA, linkEventToCase, setChannel, setRelay, STATUS_LABEL, useVillage, ZONE_LABEL, type ChannelId, type VillageEvent } from '../lib/village'
import type { IotPoint } from '../types'

// 실제 하드웨어 분석 흐름:
//   시나리오 실행(전체 전원 차단 또는 LED 하나 끄기) → LED 소등 → INA219 측정값 변화 → 이상 사건 등록 → 입력 적합성 검사 → DC 데이터라 AI 고장파형 분석 보류
// 전체 릴레이(D2)로는 마을 전체를, 채널 릴레이(D3~D7)로는 LED 하나를 끄고, 해당 구간 INA219 전류 변화를 본다.

type Target = 'ALL' | ChannelId

const STEPS = ['장치 연결', '시나리오 실행', 'LED 소등', 'INA219 변화', '사건 등록', '적합성 검사', 'AI 분석 판단']
const BASELINE_SAMPLES = 4
const HOLD_MS = 6000
const RECOVER_SAMPLES = 4
const SETTLE_MS = 1500

type Phase = 'idle' | 'baseline' | 'cutting' | 'holding' | 'restoring' | 'recovering' | 'done' | 'failed'
interface Run {
  phase: Phase
  startedAt: number
  cutAt: number
  holdAt: number
  restoreAt: number
  recoverAt: number
  error: string | null
}
const L = { textAlign: 'left' } as const
const IDLE: Run = { phase: 'idle', startedAt: 0, cutAt: 0, holdAt: 0, restoreAt: 0, recoverAt: 0, error: null }

const phaseText = (one: boolean): Record<Phase, string> => ({
  idle: '대기 중',
  baseline: '차단 전 기준값 측정 중…',
  cutting: one ? '채널 소등 명령 전송, 장치 응답 대기 중…' : '릴레이 차단 명령 전송, 장치 응답 대기 중…',
  holding: one ? 'LED 소등 상태 측정 중…' : '전원 차단 상태 측정 중…',
  restoring: one ? '채널 복구 명령 전송, 장치 응답 대기 중…' : '릴레이 복구 명령 전송, 장치 응답 대기 중…',
  recovering: '복구 후 측정 중…',
  done: '시나리오 완료',
  failed: '시나리오 중단',
})
const RUNNING: Phase[] = ['baseline', 'cutting', 'holding', 'restoring', 'recovering']

interface Avg {
  v: number
  i: number
  p: number
  leds: number
}
/** 시나리오가 LED 하나면 그 LED가 속한 구간의 전류를, 전체면 마을 전체 전류를 봄 */
const pickI = (target: Target, p: IotPoint): number => {
  if (target === 'ALL') return p.i
  const kind = IOT_CHANNELS.find((c) => c.id === target)!.kind
  return (kind === 'HOUSE' ? p.ih : p.il) ?? (p.scope === 'BOTH' ? p.i : NaN)
}
const avg = (pts: IotPoint[], target: Target): Avg => {
  const n = Math.max(1, pts.length)
  const v = pts.reduce((s, x) => s + x.v, 0) / n
  const i = pts.reduce((s, x) => s + pickI(target, x), 0) / n
  const houseOnly = pts.some((x) => x.scope === 'HOUSE') && (target === 'ALL' || IOT_CHANNELS.find((c) => c.id === target)?.kind === 'HOUSE')
  return { v, i, p: v * i, leds: Math.max(0, Math.min(houseOnly ? 3 : 5, Math.round(i / ledA()))) }
}

interface Result {
  window: IotPoint[]
  before: Avg
  during: Avg
  after: Avg
  cutAt: number
  restoreAt: number
  target: Target
}

export default function HardwareFlow() {
  const snap = useVillage()
  const nav = useNavigate()
  const [target, setTarget] = useState<Target>('ALL')
  const targetRef = useRef<Target>('ALL')
  targetRef.current = target
  const [run, setRun] = useState<Run>(IDLE)
  const [result, setResult] = useState<Result | null>(null)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = run.phase

  const real = snap.source === 'SERIAL'
  const live = snap.connected && snap.status !== 'NO_DATA'
  const running = RUNNING.includes(run.phase)
  const channelMode = target !== 'ALL'
  const def = channelMode ? IOT_CHANNELS.find((c) => c.id === target)! : null
  const supportedTarget = !real || snap.measurementScope !== 'HOUSE' || target === 'ALL' || IOT_CHANNELS.find((c) => c.id === target)?.kind === 'HOUSE'
  useEffect(() => {
    if (real && snap.measurementScope === 'HOUSE' && target !== 'ALL' && IOT_CHANNELS.find((c) => c.id === target)?.kind === 'LAMP') setTarget('ALL')
  }, [real, snap.measurementScope, target])
  const canStart = live && supportedTarget && snap.relay && snap.relayPending === null && !running && (!channelMode || (snap.canControl && snap.channels[target]))

  // 시나리오가 끈 것(전체 또는 LED 하나)을 켜고 끔
  const cut = () => (targetRef.current === 'ALL' ? setRelay(false) : setChannel(targetRef.current as ChannelId, false))
  const restore = () => (targetRef.current === 'ALL' ? setRelay(true) : setChannel(targetRef.current as ChannelId, true))
  const isCut = () => {
    const t = targetRef.current
    return t === 'ALL' ? !snap.relay && snap.relayPending === null : !snap.channels[t] && snap.channelPending[t] === undefined
  }
  const isRestored = () => {
    const t = targetRef.current
    return t === 'ALL' ? snap.relay && snap.relayPending === null : snap.channels[t] && snap.channelPending[t] === undefined
  }

  function fail(message: string) {
    if (phaseRef.current === 'cutting' || phaseRef.current === 'holding' || phaseRef.current === 'restoring') restore()
    setRun((r) => ({ ...r, phase: 'failed', error: message }))
  }

  function start() {
    setResult(null)
    setCaseId(null)
    setError(null)
    setRun({ ...IDLE, phase: 'baseline', startedAt: Date.now() })
  }

  // 화면을 벗어나도 전원이 꺼진 채로 남지 않게 함
  useEffect(() => {
    return () => {
      const p = phaseRef.current
      if (p === 'cutting' || p === 'holding' || p === 'restoring') {
        const t = targetRef.current
        if (t === 'ALL') setRelay(true)
        else setChannel(t, true)
      }
    }
  }, [])

  // 계측이 들어올 때마다 시나리오를 한 단계씩 진행
  useEffect(() => {
    if (!RUNNING.includes(run.phase)) return
    const now = Date.now()
    if (!snap.connected || snap.status === 'NO_DATA') {
      fail('장치 수신이 끊겨 시나리오를 중단했습니다.')
      return
    }
    const since = (t: number) => now - t
    if (run.phase === 'baseline') {
      if (snap.history.filter((h) => h.t >= run.startedAt).length >= BASELINE_SAMPLES) {
        cut()
        setRun({ ...run, phase: 'cutting', cutAt: now })
      }
    } else if (run.phase === 'cutting') {
      if (isCut()) setRun({ ...run, phase: 'holding', holdAt: now })
      else if (since(run.cutAt) > 5000) fail('차단 명령을 장치가 확인하지 않았습니다.')
    } else if (run.phase === 'holding') {
      if (since(run.holdAt) >= HOLD_MS) {
        restore()
        setRun({ ...run, phase: 'restoring', restoreAt: now })
      }
    } else if (run.phase === 'restoring') {
      if (isRestored()) setRun({ ...run, phase: 'recovering', recoverAt: now })
      else if (since(run.restoreAt) > 5000) fail('복구 명령을 장치가 확인하지 않았습니다.')
    } else if (run.phase === 'recovering') {
      const after = snap.history.filter((h) => h.t >= run.recoverAt + SETTLE_MS)
      if (after.length >= RECOVER_SAMPLES) {
        const window: IotPoint[] = snap.history.filter((h) => h.t >= run.startedAt).map(({ p: _p, ...h }) => h)
        setResult({
          window,
          before: avg(window.filter((h) => h.t < run.cutAt).slice(-BASELINE_SAMPLES), targetRef.current),
          during: avg(window.filter((h) => h.t >= run.holdAt + SETTLE_MS && h.t < run.restoreAt), targetRef.current),
          after: avg(window.filter((h) => h.t >= run.recoverAt + SETTLE_MS), targetRef.current),
          cutAt: run.cutAt,
          restoreAt: run.restoreAt,
          target: targetRef.current,
        })
        setRun({ ...run, phase: 'done' })
      }
    }
    // 계측 패킷이 갱신될 때만 진행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.packets, run.phase])

  const event = useMemo<VillageEvent | null>(() => {
    if (!result) return null
    const { before, during, after } = result
    const where = real ? '실측 INA219' : '시뮬레이터'
    const one = result.target === 'ALL' ? null : IOT_CHANNELS.find((c) => c.id === result.target)!
    const unit = one ? `${ZONE_LABEL[one.kind]} 전류` : snap.measurementScope === 'HOUSE' ? '주택 분기 실측 전류' : '마을 전체 전류'
    return {
      id: Date.now() % 1_000_000_000,
      source: snap.source,
      label: one ? `${one.name} 소등 시험 (${where})` : `전원 차단 시험 (${where})`,
      at: new Date(result.cutAt).toISOString(),
      injected: null,
      injectedAt: new Date(result.cutAt).toISOString(),
      status: one ? 'WARNING' : 'OUTAGE',
      maxScore: Math.min(1, Math.max(0, (before.i - during.i) / (ledA() * 2))),
      relayOn: !!one,
      expected: before.i,
      window: result.window,
      clearedAt: new Date(result.restoreAt).toISOString(),
      caseId: null,
      notes: [
        one
          ? `시험 시나리오입니다. 웹에서 채널 릴레이(${one.relay})로 ${one.name}(LED ${one.ch}) 하나만 의도적으로 껐다가 켰습니다.`
          : '시험 시나리오입니다. 웹에서 릴레이(D2)로 마을 전체 전원을 의도적으로 차단했다가 복구했습니다.',
        `${unit}: 차단 전 ${before.i.toFixed(3)} A(LED 약 ${before.leds}개) → 차단 중 ${during.i.toFixed(3)} A(LED 약 ${during.leds}개) → 복구 후 ${after.i.toFixed(3)} A(LED 약 ${after.leds}개)`,
      ],
    }
  }, [result, real, snap.source])
  const resultTarget = result?.target ?? target

  // 등록 전에 미리 보는 입력 적합성 검사 (사건 등록 때와 같은 규칙)
  const diagnosis = useMemo(() => (event ? buildIotCase(event, getActor(), 'PREVIEW').diagnosis : null), [event])

  async function register() {
    if (!event) return
    setBusy(true)
    setError(null)
    try {
      const c = await api.registerIotEvent({ event, actor: getActor() })
      linkEventToCase(event.id, c.id)
      setCaseId(c.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const done = !live ? 0 : caseId ? 7 : result ? 4 : running ? 2 : 1
  const dropped = result ? result.before.leds - result.during.leds : 0
  const info = DEVICE_INFO[snap.source]

  return (
    <>
      <div className="section">
        <h2 className="page-title" style={{ fontSize: 18 }}>하드웨어 분석 흐름</h2>
        <p className="page-desc">모형에서 전원 차단 또는 LED 소등 시나리오를 실행하고, LED와 INA219 측정값 변화를 사건으로 남긴 뒤, 입력 적합성 검사와 AI 분석 판단까지 순서대로 확인합니다.</p>
      </div>

      <Steps steps={STEPS} done={done} />

      <Section
        title="① 장치 연결"
        description="실측 장치를 연결하면 실제 LED가 꺼지고 INA219가 잰 값으로 분석합니다."
        actions={<Status tone={live ? 'ok' : 'err'} live={live}>{live ? '수신 중' : snap.connected ? '데이터 없음' : '끊김'}</Status>}
      >
        {!real && (
          <div className="alert alert-warn" style={{ marginBottom: 16 }}>
            <span>
              지금은 <strong>시뮬레이터</strong> 값입니다. 실제 LED는 꺼지지 않고 사건 기록에도 시뮬레이터로 남습니다. Chrome·Edge에서 <Link to="/settings">설정 → 데이터 출처</Link>의 <strong>실측 장치</strong>로 Arduino를 연결하세요.
            </span>
          </div>
        )}
        <dl className="dl-rows">
          <div><dt>데이터 출처</dt><dd>{real ? '실측 장치' : '시뮬레이터'} · {info.deviceId}</dd></div>
          <div><dt>센서</dt><dd>{info.sensor} · 구간별 전압·전류를 측정</dd></div>
          <div><dt>릴레이</dt><dd>{snap.relay ? '닫힘 — 전원 공급 중' : '열림 — 마을 전체 차단'}</dd></div>
        </dl>
        <Metrics cols={4}>
          <Metric label="전압" value={snap.v.toFixed(2)} unit="V" />
          <Metric label="전류" value={snap.i.toFixed(3)} unit="A" />
          <Metric label="전력" value={snap.p.toFixed(2)} unit="W" />
          <Metric label="켜진 LED (추정)" value={snap.estLit} unit="/ 5" foot="전류 ÷ LED 1개 기준 전류" />
        </Metrics>
      </Section>

      <Section
        title={channelMode ? `② 시나리오 실행: ${def!.name} 소등 → 복구` : '② 시나리오 실행: 전원 차단 → 복구'}
        description={`${channelMode ? `채널 릴레이로 ${def!.name}(LED ${def!.ch}) 하나만` : '전체 릴레이로 마을 전체 전원을'} ${HOLD_MS / 1000}초간 ${channelMode ? '끄고' : '차단했다가'} 자동으로 복구합니다.`}
        actions={
          <button className="btn btn-primary" onClick={start} disabled={!canStart}>
            {running ? '실행 중…' : result ? '다시 실행' : '시나리오 실행'}
          </button>
        }
      >
        <div className="row gap" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>
            끌 대상
            <select value={target} onChange={(e) => setTarget(e.target.value as Target)} disabled={running}>
              <option value="ALL">{snap.measurementScope === 'HOUSE' ? '전체 전원 릴레이 · 주택 분기 실측' : '마을 전체 (전체 릴레이 D2)'}</option>
              {IOT_CHANNELS.map((c) => (
                <option key={c.id} value={c.id} disabled={!snap.canControl || (real && snap.measurementScope === 'HOUSE' && c.kind === 'LAMP')}>{c.name} · LED {c.ch} ({c.kind === 'LAMP' && real && snap.measurementScope === 'HOUSE' ? '전류 미측정' : c.relay})</option>
              ))}
            </select>
          </label>
          {!snap.canControl && <span className="small muted">채널 상태를 보고하는 새 스케치가 필요합니다.</span>}
        </div>
        {channelMode && !snap.channels[target] && !running && live && (
          <div className="alert alert-warn"><span>{def!.name} 채널이 꺼져 있습니다. 먼저 켜세요.</span></div>
        )}
        {!snap.relay && !running && live && (
          <div className="alert alert-warn"><span>릴레이가 열려 있습니다. 먼저 스마트 마을에서 <Link to="/village">전력 복구</Link>를 누르세요.</span></div>
        )}
        <div className="row gap" style={{ marginTop: 4 }}>
          <Status tone={run.phase === 'failed' ? 'err' : run.phase === 'done' ? 'ok' : running ? 'accent' : 'off'} live={running}>
            {phaseText(channelMode)[run.phase]}
          </Status>
          {running && <span className="small muted">화면을 벗어나면 전원을 자동으로 복구합니다.</span>}
        </div>
        {run.error && <div className="alert alert-err" style={{ marginTop: 12 }}>{run.error}</div>}
      </Section>

      {result && event && diagnosis && (
        <>
          <Section title="③ LED 소등과 INA219 측정값 변화" description={`차단 전 · 차단 중 · 복구 후의 평균값입니다.${resultTarget === 'ALL' ? snap.measurementScope === 'HOUSE' ? ' 주택 분기 INA219 실측 기준입니다.' : ' 확인된 마을 전체 전류 기준입니다.' : ` ${ZONE_LABEL[IOT_CHANNELS.find((c) => c.id === resultTarget)!.kind]} INA219 전류 기준입니다.`}`}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>구간</th><th>전압</th><th>전류</th><th>전력</th><th>켜진 LED (추정)</th></tr>
                </thead>
                <tbody>
                  {([['차단 전', result.before], ['차단 중', result.during], ['복구 후', result.after]] as const).map(([name, a]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="num" style={L}>{a.v.toFixed(2)} V</td>
                      <td className="num" style={L}>{a.i.toFixed(3)} A</td>
                      <td className="num" style={L}>{a.p.toFixed(2)} W</td>
                      <td className="num" style={L}>{a.leds} / {snap.measurementScope === 'HOUSE' ? 3 : 5}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid-2" style={{ marginTop: 20 }}>
              <div>
                <div className="small muted" style={{ marginBottom: 4 }}>전류 (A)</div>
                <Sparkline values={result.window.map((p) => p.i)} minSpan={0.1} height={56} />
              </div>
              <div>
                <div className="small muted" style={{ marginBottom: 4 }}>전압 (V)</div>
                <Sparkline values={result.window.map((p) => p.v)} minSpan={0.5} height={56} />
              </div>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              {dropped > 0 ? `전류가 LED ${dropped}개 분량 줄었습니다.` : '전류 변화가 작습니다. 릴레이와 배선을 확인하세요.'} {resultTarget === 'ALL' ? '전체 전류만 보므로 어느 LED가 꺼졌는지는 구분하지 않습니다.' : 'LED 하나를 직접 껐으므로 구간 전류 변화로 그 LED가 실제로 켜져 있었는지 확인합니다.'}
              {real && result.during.i > 0.03 ? ' 차단했는데도 전류가 흐릅니다. 릴레이 접점 고착이나 우회 배선을 확인하세요.' : ''}
            </p>
          </Section>

          <Section
            title="④ 이상 사건 등록"
            description="계측 기록을 DC 그대로 IoT 사건으로 저장합니다. 교류 파형으로 바꾸지 않습니다."
            actions={
              caseId ? (
                <button className="btn btn-primary" onClick={() => nav(`/cases/${caseId}`)}>사건 열기 · {caseId}</button>
              ) : (
                <button className="btn btn-primary" onClick={register} disabled={busy}>{busy ? '등록 중…' : '이상 사건 등록'}</button>
              )
            }
          >
            <dl className="dl-rows">
              <div><dt>제목</dt><dd>{event.label}</dd></div>
              <div><dt>판정</dt><dd><Status tone={NODE_TONE[event.status]}>{STATUS_LABEL[event.status]}</Status> <span className="muted">· 시험용으로 의도해서 만든 차단입니다</span></dd></div>
              <div><dt>기록 구간</dt><dd className="num">{result.window.length}개 샘플</dd></div>
            </dl>
            {error && <div className="alert alert-err" style={{ marginTop: 12 }}>{error}</div>}
          </Section>

          <Section
            title="⑤ GridWitness 입력 적합성 검사"
            description="등록할 계측 기록이 분석에 쓸 수 있는 상태인지 확인합니다."
            actions={<Badge tone={DIAG_TONE[diagnosis.status]}>{DIAG_LABEL[diagnosis.status]}</Badge>}
          >
            <IssueList issues={diagnosis.issues} />
            {diagnosis.issues.length === 0 && <p className="muted" style={{ margin: 0 }}>발견된 문제가 없습니다.</p>}
          </Section>

          <Section
            title="⑥ AI 고장파형 분석 판단"
            description="이 기록은 5V DC 계측이라 교류 고장파형 모델의 입력 조건과 맞지 않습니다."
            actions={<Badge tone="warn">분석 보류</Badge>}
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>항목</th><th>이 기록 (IoT)</th><th>고장파형 모델 입력</th></tr>
                </thead>
                <tbody>
                  <tr><td>전기 종류</td><td>DC 5V</td><td>AC 계통 50 Hz</td></tr>
                  <tr><td>채널</td><td>전압·전류 2개 (마을 전체)</td><td>Ia Ib Ic In Va Vb Vc 7채널</td></tr>
                  <tr><td>측정 주기</td><td>0.5초마다 1회</td><td>4096 Hz</td></tr>
                  <tr><td>길이</td><td className="num" style={L}>{result.window.length}개 샘플</td><td>1312개 샘플</td></tr>
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              그래서 고장파형 4종 분류(SIF·MIF·PF·TD)는 실행하지 않고 보류합니다. 이 기록은 별개 모델인 <strong>{IOT_MODEL}</strong>로 판단하고, 사람이 검토합니다.
            </p>
          </Section>
        </>
      )}
    </>
  )
}
