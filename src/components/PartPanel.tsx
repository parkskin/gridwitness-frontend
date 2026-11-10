import { LOAD_LINES, NET_COLOR, NETS, PART_BY_ID, pinLabel, splitPin, type PartId, type PinRef } from '../lib/hardware'
import { contactClosed, type VillageSnapshot } from '../lib/village'
import { IconX } from './Icons'
import { Status, type Tone } from './ui'

/** 부품의 현재 동작 상태 한 줄 */
function liveOf(id: PartId, snap: VillageSnapshot): [Tone, string] {
  const supplyOk = snap.supplyFault !== 'OUTAGE' && snap.status !== 'NO_DATA'
  const powered = contactClosed(snap) && supplyOk
  const lit = LOAD_LINES.filter((l) => l.board === id && snap.leds[l.led].lit).map((l) => l.name)
  switch (id) {
    case 'adapter':
      if (!supplyOk) return ['err', '출력 없음']
      return [snap.relay || snap.supplyFault === 'STUCK' ? 'ok' : 'off', `5V 출력${snap.supplyFault === 'SAG' ? ' · 전압 강하' : ''}${contactClosed(snap) ? '' : ' · 릴레이가 열려 있어 전류는 흐르지 않음'}`]
    case 'relay':
      if (snap.supplyFault === 'STUCK' && !snap.relay) return ['err', 'D2 = HIGH(코일 켜짐)인데 접점이 붙어 있음 (고착) · 전원이 차단되지 않음']
      return snap.relay ? ['ok', 'D2 = LOW · 코일 꺼짐 · COM → NC 연결 (전원 공급)'] : ['off', 'D2 = HIGH · 코일 켜짐 · COM → NC 열림 (마을 전체 차단)']
    case 'arduino':
      return snap.connected ? ['ok', `D2 ${snap.relay ? 'LOW(공급)' : 'HIGH(차단)'} · I2C로 0.5초마다 측정 · ${snap.source === 'MOCK' ? '시뮬레이터' : '실측'}`] : ['err', '연결 끊김']
    case 'inaH':
    case 'inaL': {
      const kind = id === 'inaH' ? 'HOUSE' : 'LAMP'
      const z = snap.zones?.[kind]
      if (snap.status === 'NO_DATA') return ['off', '데이터 없음']
      if (z) return ['ok', `${z.v.toFixed(2)} V · ${z.i.toFixed(3)} A · 켜진 LED ${z.estLit}개 추정`]
      if (snap.source === 'SERIAL' && snap.measurementScope === 'HOUSE' && kind === 'LAMP') return ['off', '가로등 전류 미측정 · LED는 릴레이 상태만 시각화']
      if (snap.source === 'SERIAL' && snap.measurementScope === 'LAMP' && kind === 'HOUSE') return ['off', '주택 분기 센서 미응답']
      return ['off', '해당 분기 실측값 없음']
    }
    default: {
      const line = LOAD_LINES.find((l) => l.board === id)
      if (!line) return ['off', '']
      if (!snap.channels[line.led]) return ['off', `코일 꺼짐 · COM → NO 열림 (${line.name} 소등)`]
      return powered ? [lit.length ? 'ok' : 'warn', lit.length ? `코일 켜짐 · ${line.name} 켜짐` : `코일 켜짐인데 ${line.name} 전류 없음 (단선 의심)`] : ['off', '전원 없음']
    }
  }
}

/** 핀에 연결된 상대편 목록 */
function peers(ref: PinRef): { color: string; text: string }[] {
  const out = NETS.filter((n) => n.a === ref || n.b === ref).map((n) => ({ color: NET_COLOR[n.kind], text: `${pinLabel(n.a === ref ? n.b : n.a)} · ${n.signal}` }))
  const [part, pin] = splitPin(ref)
  for (const l of LOAD_LINES) {
    if (l.board !== part) continue
    if (pin === 'NO') out.push({ color: NET_COLOR.ledPlus, text: `${l.name} LED ${l.ledNo} (+) · 220Ω 저항을 거침` })
  }
  return out
}

export default function PartPanel({ id, snap, onClose }: { id: PartId; snap: VillageSnapshot; onClose: () => void }) {
  const part = PART_BY_ID[id]
  const [tone, live] = liveOf(id, snap)
  return (
    <div className="part-panel" role="dialog" aria-label={`${part.name} 상세`}>
      <div className="row between">
        <h3>{part.name}</h3>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="닫기"><IconX /></button>
      </div>
      <p className="small muted" style={{ marginTop: 2 }}>{part.role} · {part.spec}</p>
      <div className="live"><Status tone={tone}>{live}</Status></div>
      <dl className="pin-rows">
        {Object.entries(part.pins).map(([pin, desc]) => {
          const ref = `${id}.${pin}` as PinRef
          const to = peers(ref)
          return (
            <div key={pin}>
              <dt>{pin}</dt>
              <dd>
                {desc}
                {to.length === 0 ? (
                  <span className="to">연결 없음</span>
                ) : (
                  to.map((p, k) => (
                    <span key={k} className="to"><span className="wire-chip" style={{ background: p.color }} />{p.text}</span>
                  ))
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}
