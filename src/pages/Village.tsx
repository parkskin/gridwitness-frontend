import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import AiPanel from '../components/AiPanel'
import Channels from '../components/Channels'
import EventList from '../components/EventList'
import { IconMoon, IconPower, IconSun, IconX } from '../components/Icons'
import PartPanel from '../components/PartPanel'
import SceneBoundary from '../components/SceneBoundary'
import Sparkline from '../components/Sparkline'
import { Badge, NODE_TONE, Section, Segmented, Status } from '../components/ui'
import VillageScene from '../components/village/VillageScene'
import { LiveFrtuWaveAnalysis } from '../components/FrtuWaveAnalysis'
import { isFrtuId, type FrtuId } from '../lib/frtu'
import { announcePanelOpen, ASSISTANT_OPEN_EVENT, INCIDENT_OPEN_EVENT } from '../lib/panels'
import { NET_COLOR, NET_KIND_LABEL, type NetKind, type PartId } from '../lib/hardware'
import {
  clearFault,
  FAULT_AT_LED,
  FAULT_LABEL,
  injectFault,
  IOT_CHANNELS,
  lightView,
  setChannel,
  setConnected,
  setRelay,
  STATUS_LABEL,
  stopScenario,
  useVillage,
  ZONE_LABEL,
  ZONE_SENSOR,
  zoneChannels,
  type ChannelId,
  type FaultKind,
  type VillageSnapshot,
} from '../lib/village'

/** 보기 설정은 브라우저별로 기억 */
function useStoredFlag(key: string, initial: boolean) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  const set = (next: boolean) => {
    setV(next)
    try {
      localStorage.setItem(key, next ? '1' : '0')
    } catch {
      // 저장 불가 환경은 무시
    }
  }
  return [v, set] as const
}

/** 정전 발생 / 전력 복구 — 장치(릴레이)로 보내는 가장 중요한 조작이라 크게 */
function PowerButton({ snap }: { snap: VillageSnapshot }) {
  const pending = snap.relayPending !== null
  if (pending) {
    return (
      <button className="btn btn-xl btn-power pending" disabled>
        <span className="spin" />
        장치에 명령 전송 중…
      </button>
    )
  }
  return snap.relay ? (
    <button className="btn btn-xl btn-power off" onClick={() => setRelay(false)} disabled={!snap.connected}>
      <IconPower />
      정전 발생
    </button>
  ) : (
    <button className="btn btn-xl btn-power on" onClick={() => setRelay(true)} disabled={!snap.connected}>
      <IconPower />
      전력 복구
    </button>
  )
}

/** 24시간 부하 패턴 막대 + 지금 재생 중인 시각 */
function HourBars({ profile, hour }: { profile: number[]; hour: number }) {
  const max = Math.max(...profile, 1)
  return (
    <div className="hourbars" role="img" aria-label={`24시간 부하 패턴, 현재 ${hour}시`}>
      {profile.map((v, h) => (
        <i key={h} className={h === hour ? 'now' : h < hour ? 'past' : ''} style={{ height: `${Math.max(8, (v / max) * 100)}%` }} title={`${h}시`} />
      ))}
    </div>
  )
}

const ALARM = ['WARNING', 'FAULT', 'OUTAGE']

export default function Village() {
  const snap = useVillage()
  const [selected, setSelected] = useState<ChannelId | null>(null)
  const [target, setTarget] = useState<ChannelId>('h2')
  const [night, setNight] = useStoredFlag('gridwitness.village.night', false)
  const [fx, setFx] = useStoredFlag('gridwitness.village.fx2', false)
  const [underground, setUnderground] = useState(false)
  const [part, setPart] = useState<PartId | null>(null)
  const [showPins, setShowPins] = useState(false)
  const [params] = useSearchParams()
  const [frtu, setFrtu] = useState<FrtuId | null>(() => (isFrtuId(params.get('frtu')) ? (params.get('frtu') as FrtuId) : params.get('ai') === '1' ? 'inlet' : null))
  const [controls, setControls] = useState(false)
  const nav = useNavigate()
  // AI 도우미가 열리면 화면의 카드 패널(FRTU 요약·제어판·LED 상세)은 내려감
  useEffect(() => {
    const onAssistant = () => {
      setFrtu(null)
      setControls(false)
      setSelected(null)
    }
    window.addEventListener(ASSISTANT_OPEN_EVENT, onAssistant)
    // 실시간 사건 화면이 올라와도 같은 자리를 비켜 줌
    window.addEventListener(INCIDENT_OPEN_EVENT, onAssistant)
    return () => {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, onAssistant)
      window.removeEventListener(INCIDENT_OPEN_EVENT, onAssistant)
    }
  }, [])
  // 반대로 카드 패널을 열면 AI 도우미가 접힘
  useEffect(() => {
    if (frtu || controls || selected) announcePanelOpen()
  }, [frtu, controls, selected])
  const sel = selected ? snap.leds[selected] : null
  const selView = sel ? lightView(sel, snap) : null
  const mock = snap.source === 'MOCK'
  const alarm = ALARM.includes(snap.status)
  const hour = snap.scenario ? Math.max(0, snap.scenario.hour) : 0

  return (
    <div className="workspace">

      {snap.scenario && (
        <div className="scenario-banner">
          <div style={{ minWidth: 0 }}>
            <strong>공공데이터 패턴 재생 중</strong>
            <div className="small muted">{snap.scenario.label} · {hour}시 · 시간대별 사용량만큼 LED가 켜집니다 (시뮬레이터)</div>
          </div>
          <HourBars profile={snap.scenario.profile} hour={hour} />
          <span className="scenario-lit num"><b>{snap.estLit}</b> / 5 켜짐</span>
          <button className="btn btn-sm" onClick={stopScenario}>정지</button>
        </div>
      )}

      <div className={`scene scene-full ${frtu || controls ? 'with-panel' : ''}`}>
        <div className="scene-canvas">
          <SceneBoundary>
            <VillageScene
              snap={snap}
              selected={selected}
              onSelect={(id) => {
                setSelected(id)
                if (id) setFrtu(null)
              }}
              night={night}
              fx={fx}
              underground={underground}
              selectedPart={part}
              onPart={setPart}
              showPins={showPins}
              frtu={frtu}
              onFrtu={(id) => {
                setSelected(null)
                setControls(false)
                setFrtu(id)
              }}
            />
          </SceneBoundary>
        </div>
        <div className="scene-tools">
          <Segmented
            className="glass"
            value={underground ? 'under' : 'surface'}
            onChange={(v) => {
              setUnderground(v === 'under')
              setSelected(null)
              setPart(null)
              setFrtu(null)
            }}
            options={[
              { value: 'surface', label: '지상' },
              { value: 'under', label: '지하 배선' },
            ]}
          />
          <Segmented
            className="glass"
            value={night ? 'night' : 'day'}
            onChange={(v) => setNight(v === 'night')}
            options={[
              { value: 'day', label: <span className="row" style={{ gap: 5 }}><IconSun />낮</span> },
              { value: 'night', label: <span className="row" style={{ gap: 5 }}><IconMoon />밤</span> },
            ]}
          />
          <button className={`btn btn-sm glass ${fx ? 'on' : ''}`} onClick={() => setFx(!fx)} aria-pressed={fx} title="AO·블룸 후처리, 고해상도, 60fps (GPU 사용량 증가)">
            고화질 {fx ? '켜짐' : '꺼짐'}
          </button>
          <button className={`btn btn-sm glass ${controls ? 'on' : ''}`} onClick={() => { setControls(!controls); setFrtu(null) }} aria-pressed={controls}>제어판</button>
          {!underground && !frtu && <button className="btn btn-sm glass btn-ai" onClick={() => { setSelected(null); setControls(false); setFrtu('inlet') }}>FRTU 보기</button>}
          <span style={{ marginLeft: 'auto' }}><PowerButton snap={snap} /></span>
          {underground && (
            <>
              <button className={`btn btn-sm glass ${showPins ? 'on' : ''}`} onClick={() => setShowPins(!showPins)} aria-pressed={showPins}>
                핀 이름 {showPins ? '켜짐' : '꺼짐'}
              </button>
              {part && <button className="btn btn-sm glass" onClick={() => setPart(null)}>전체 보기</button>}
            </>
          )}
        </div>

        {underground ? (
          <div className="scene-legend glass">
            <strong>배선 색상</strong>
            {(Object.keys(NET_KIND_LABEL) as NetKind[]).map((k) => (
              <span key={k}><i style={{ background: NET_COLOR[k] }} />{NET_KIND_LABEL[k]}</span>
            ))}
            <span className="muted" style={{ marginLeft: 'auto' }}>
              <i className="legend-dot" style={{ background: '#ffd43b' }} />전류 (릴레이가 닫혔을 때만) · <i className="legend-dot" style={{ background: '#a5d8ff' }} />통신 신호 · 부품 클릭: 상세
            </span>
          </div>
        ) : (
          <div className={`scene-hud glass ${alarm ? 'alarm' : ''}`} aria-live="polite">
            <Status tone={NODE_TONE[snap.status]} live={alarm}><strong>{STATUS_LABEL[snap.status]}</strong></Status>
            {snap.diagnosis && (
              <span className="small" title="실측으로 학습한 조합별 정상 전류표와 비교한 결과. 센서가 1개라 비슷한 전류의 채널끼리는 구분하지 못해 후보로 보여 줍니다">
                {snap.diagnosis.kind === 'LOW'
                  ? '켠 채널 중 전류를 안 흘리는 것이 있음'
                  : snap.diagnosis.candidates.length
                    ? '끈 채널에 전류가 흐름 (릴레이 고착 의심)'
                    : '예상보다 전류가 많음 (누설·단락 의심)'}
                {snap.diagnosis.candidates.length > 0 && ` · 의심: ${snap.diagnosis.candidates.map((id) => snap.leds[id].name).join(', ')}`}
                {' · '}
                <Link to="/village/loads">채널 점검으로 찾기 →</Link>
              </span>
            )}
            <div className="hud-nums num">
              <span><b>{snap.v.toFixed(2)}</b> V</span>
              <span><b>{snap.i.toFixed(2)}</b> A</span>
              <span><b>{snap.p.toFixed(2)}</b> W</span>
            </div>
            <div className="hud-lit" aria-label={`켜진 LED ${snap.estLit}개`}>
              {IOT_CHANNELS.map((c, k) => (
                <i key={c.id} className={snap.leds[c.id].lit ? 'on' : ''} title={c.name} data-k={k} />
              ))}
              <span className="small muted">{snap.estLit}/5</span>
            </div>
          </div>
        )}
        {!underground && !frtu && <div className="scene-hint glass">전봇대의 FRTU 함을 누르면 계측·고장표시가 열려요</div>}
        {frtu && !underground && <AiPanel snap={snap} frtu={frtu} onPick={setFrtu} onClose={() => setFrtu(null)} />}

        {underground && part && <PartPanel id={part} snap={snap} onClose={() => setPart(null)} />}
        {sel && selView && !underground && (
          <div className="scene-pop" role="dialog" aria-label={`${sel.name} 상세`}>
            <div className="scene-pop-head">
              <strong>{sel.name}</strong>
              <span className="tag">LED {sel.ch}</span>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setSelected(null)} aria-label="닫기"><IconX /></button>
            </div>
            <Status tone={NODE_TONE[selView.status]}>{selView.text}</Status>
            <dl className="kv" style={{ marginTop: 14 }}>
              <div><dt>제어</dt><dd>{sel.relay}</dd></div>
              <div><dt>측정</dt><dd>{ZONE_SENSOR[sel.kind]}</dd></div>
              <div><dt>{ZONE_LABEL[sel.kind]} 전류</dt><dd>{snap.zones ? `${snap.zones[sel.kind].i.toFixed(3)} A` : `${snap.i.toFixed(3)} A (마을 전체)`}</dd></div>
              <div><dt>켜진 LED</dt><dd>{snap.zones ? `${snap.zones[sel.kind].estLit} / ${zoneChannels(sel.kind).length}` : `${snap.estLit} / 5`}</dd></div>
            </dl>
            <p className="hint">LED별 전류는 따로 재지 않고 구간 전류로 추정합니다.</p>
            <div className="row gap" style={{ marginTop: 12 }}>
              <button
                className="btn btn-sm btn-primary"
                style={{ flex: 1 }}
                disabled={!snap.canControl || !snap.connected || snap.channelPending[sel.id] !== undefined}
                onClick={() => setChannel(sel.id, !sel.channelOn)}
              >
                {snap.channelPending[sel.id] !== undefined ? '전송 중…' : sel.channelOn ? '이 LED 끄기' : '이 LED 켜기'}
              </button>
              <button className="btn btn-sm" style={{ flex: 1 }} onClick={() => setUnderground(true)}>지하 배선</button>
            </div>
          </div>
        )}

      {controls && (
        <aside className="control-drawer" aria-label="제어판">
          <div className="ai-head">
            <strong>제어판</strong>
            <button className="btn btn-ghost btn-icon" onClick={() => setControls(false)} aria-label="닫기"><IconX /></button>
          </div>
          <Section title="LED 채널 제어" actions={<Link to="/village/loads" className="small">채널 점검 →</Link>}>
            <Channels snap={snap} selected={selected} onSelect={setSelected} controls />
          </Section>

      <Section title="고장 시뮬레이션" actions={!mock && <Badge>실측 모드에서는 사용 안 함</Badge>}>
        <div className="sim-grid">
          <div className="form">
            <label className="field">
              LED 위치 고장
              <select value={target} onChange={(e) => setTarget(e.target.value as ChannelId)} disabled={!mock}>
                {IOT_CHANNELS.map((c) => <option key={c.id} value={c.id}>LED {c.ch} · {c.name}</option>)}
              </select>
            </label>
            <div className="cluster">
              {(Object.keys(FAULT_LABEL) as FaultKind[]).filter((k) => FAULT_AT_LED[k]).map((k) => (
                <button key={k} className={`btn ${snap.faults[target] === k ? 'btn-danger on' : ''}`} aria-pressed={snap.faults[target] === k} onClick={() => injectFault(target, k)} disabled={!mock}>
                  {FAULT_LABEL[k]}
                </button>
              ))}
              <button className="btn btn-ghost" onClick={() => clearFault(target)} disabled={!mock || !snap.faults[target]}>이 LED 복구</button>
            </div>
          </div>
          <div className="form">
            <div className="field">전원·제어·통신 고장</div>
            <div className="cluster">
              {(Object.keys(FAULT_LABEL) as FaultKind[]).filter((k) => !FAULT_AT_LED[k]).map((k) => (
                <button key={k} className={`btn ${snap.supplyFault === k ? 'btn-danger on' : ''}`} aria-pressed={snap.supplyFault === k} onClick={() => injectFault(target, k)} disabled={!mock}>
                  {FAULT_LABEL[k]}
                </button>
              ))}
              <button className={`btn ${!snap.connected ? 'btn-danger on' : ''}`} aria-pressed={!snap.connected} onClick={() => setConnected(!snap.connected)} disabled={!mock}>
                통신 끊김
              </button>
              <button className="btn btn-ghost" onClick={() => { clearFault(); setConnected(true) }} disabled={!mock || (Object.keys(snap.faults).length === 0 && !snap.supplyFault && snap.connected)}>전체 복구</button>
            </div>
          </div>
          <div className="sim-spark">
            <div className="small muted" style={{ marginBottom: 4 }}>전류 (최근 1분)</div>
            <Sparkline values={snap.history.map((h) => h.i)} minSpan={0.08} height={44} />
          </div>
        </div>
      </Section>

          <Section title="FRTU 파형 분석" actions={<button type="button" className="btn btn-sm" onClick={() => nav('/frtu')}>크게 보기</button>}>
            <LiveFrtuWaveAnalysis stacked compact />
          </Section>

          <Section title="이상 이벤트" actions={<Link to="/village/loads" className="small">부하(LED 5개) 현황 →</Link>}>
            <EventList events={snap.events} limit={4} />
          </Section>

        </aside>
      )}
      </div>
    </div>
  )
}