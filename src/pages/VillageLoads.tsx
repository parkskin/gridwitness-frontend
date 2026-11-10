import { useState } from 'react'
import { Link } from 'react-router-dom'
import ChannelCheckPanel from '../components/ChannelCheckPanel'
import ComboCalibratePanel from '../components/ComboCalibratePanel'
import Channels from '../components/Channels'
import { Metric, Metrics, PageHeader, Section } from '../components/ui'
import { type ChannelId, useVillage, ZONE_LABEL, ZONE_SENSOR, zoneChannels } from '../lib/village'

export default function VillageLoads() {
  const snap = useVillage()
  const [selected, setSelected] = useState<ChannelId | null>(null)
  return (
    <>
      <PageHeader
        crumbs={[{ label: '스마트 마을', to: '/village' }, { label: '부하' }]}
        title="부하"
        description={`LED 5개는 채널 릴레이(D3~D7)로 하나씩 제어합니다. ${snap.source === 'SERIAL' && snap.measurementScope === 'HOUSE' ? '주택 분기만 실측합니다. 가로등은 릴레이 점등 시각화만 하며 전류 판정에서 제외합니다.' : snap.zones ? '감지된 INA219로 구간을 따로 측정합니다.' : '센서 범위 확인 후 실측 분석을 시작합니다.'}`}
      />
      {snap.zones && (
        <Metrics cols={2}>
          {(['HOUSE', 'LAMP'] as const).map((k) => {
            const z = snap.zones![k]
            if (!z) return null
            return (
              <Metric key={k} label={`${ZONE_LABEL[k]} · ${ZONE_SENSOR[k]}`} value={z.i.toFixed(3)} unit="A" foot={`예상 ${z.expected.toFixed(3)} A · ${z.v.toFixed(2)} V · 켜진 LED ${z.estLit}/${zoneChannels(k).length}`} />
            )
          })}
        </Metrics>
      )}
      <Section title="LED 채널" description={snap.canControl ? '스위치로 LED 하나씩 끄고 켭니다. 장치가 상태를 보고하면 확정됩니다.' : snap.connected ? '이 장치는 채널 상태를 보고하지 않아 조종할 수 없습니다.' : '장치가 연결되지 않았습니다. 사이드바에서 장치를 연결하세요.'} actions={<Link to="/settings" className="small">회로 구성 →</Link>}>
        <Channels snap={snap} selected={selected} onSelect={setSelected} controls />
        <p className="hint">LED별 전류는 따로 재지 않습니다. 구간 전류로 켜진 개수를 추정하고, 어느 LED인지는 채널 점검으로 확인합니다.</p>
      </Section>
      <ChannelCheckPanel snap={snap} />
      <ComboCalibratePanel snap={snap} />
    </>
  )
}
