import { FAULT_LABEL, IOT_CHANNELS, setChannel, ZONE_SENSOR, type ChannelId, type VillageSnapshot } from '../lib/village'
import { IconHouse, IconLamp } from './Icons'
import { Status, Switch, type Tone } from './ui'

/**
 * 마을 부하(LED 5개) 목록과 채널 스위치.
 * 시뮬레이터는 시뮬레이터가 아는 실제 상태, 실측은 구간 전류로 추정한 켜짐 여부.
 */
export default function Channels({ snap, selected, onSelect, controls }: { snap: VillageSnapshot; selected?: ChannelId | null; onSelect?: (id: ChannelId) => void; controls?: boolean }) {
  const measured = snap.source === 'SERIAL'
  return (
    <div className={`channels ${controls ? 'with-ctl' : ''}`} role="list">
      {IOT_CHANNELS.map((def) => {
        const led = snap.leds[def.id]
        const pending = snap.channelPending[def.id] !== undefined
        const [label, tone]: [string, Tone] =
          snap.status === 'NO_DATA'
            ? ['데이터 없음', 'off']
            : measured && snap.measurementScope === 'HOUSE' && def.kind === 'LAMP'
              ? (led.channelOn ? ['시각화 (릴레이 ON)', 'off'] : ['꺼짐 (릴레이 OFF)', 'off'])
            : led.fault
              ? [FAULT_LABEL[led.fault], led.fault === 'OPEN' ? 'warn' : 'err']
              : !snap.relay
                ? ['차단됨', 'off']
                : !led.channelOn
                  ? ['꺼짐 · 채널 OFF', 'off']
                  : led.lit
                    ? [measured ? '켜짐 (추정)' : '켜짐', 'ok']
                    : [measured ? '전류 없음 (추정)' : '꺼짐', 'warn']
        return (
          <div
            key={def.id}
            role="listitem"
            tabIndex={onSelect ? 0 : undefined}
            className={`channel load ${selected === def.id ? 'sel' : ''}`}
            onClick={() => onSelect?.(def.id)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect?.(def.id)}
          >
            <div className="channel-name">
              <span className={`channel-glyph ${led.lit ? 'lit' : ''}`}>{def.kind === 'HOUSE' ? <IconHouse /> : <IconLamp />}</span>
              <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                <strong>{def.name}</strong>
                <span className="xs muted">LED {def.ch}</span>
              </span>
            </div>
            <span className="small muted">{def.relay}</span>
            <span className="small muted">{snap.source === 'MOCK' ? ZONE_SENSOR[def.kind] : snap.measurementScope === 'BOTH' ? ZONE_SENSOR[def.kind] : def.kind === 'HOUSE' && snap.measurementScope === 'HOUSE' ? '주택 분기 실측' : def.kind === 'LAMP' && snap.measurementScope === 'HOUSE' ? '전류 미측정 · 릴레이 시각화' : '구간 실측 없음'}</span>
            <Status tone={tone}>{pending ? '명령 전송 중…' : label}</Status>
            {controls && (
              <Switch
                on={pending ? snap.channelPending[def.id]! : led.channelOn}
                pending={pending}
                disabled={!snap.canControl || !snap.connected}
                onToggle={() => setChannel(def.id, !led.channelOn)}
                label={`${def.name} 채널 ${led.channelOn ? '끄기' : '켜기'}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
