import { cancelChannelCheck, runChannelCheck, useChannelCheck, VERDICT_TEXT } from '../lib/channelCheck'
import { IOT_CHANNELS, ZONE_LABEL, type VillageSnapshot } from '../lib/village'
import { Section, Status } from './ui'

/** 채널 점검: 채널을 하나씩 꺼서 구간 전류 변화로 고장 난 LED를 짚음 */
export default function ChannelCheckPanel({ snap }: { snap: VillageSnapshot }) {
  const chk = useChannelCheck()
  const ready = snap.canControl && snap.relay && snap.connected && snap.status !== 'NO_DATA'
  const bad = chk.results.filter((r) => r.verdict === 'NO_CURRENT' || r.verdict === 'OVER')
  const name = (id: string) => IOT_CHANNELS.find((c) => c.id === id)!
  return (
    <Section
      title="채널 점검"
      description="켜져 있는 LED를 하나씩 약 2초씩 꺼 보고, 그 구간 전류가 LED 1개 분량(기준 전류)만큼 줄어드는지 확인합니다. 구간까지만 알 수 있던 고장을 LED 하나까지 짚습니다."
      actions={
        chk.running ? (
          <button className="btn" onClick={cancelChannelCheck}>멈추기</button>
        ) : (
          <button className="btn btn-primary" onClick={() => void runChannelCheck()} disabled={!ready}>{chk.results.length ? '다시 점검' : '채널 점검 시작'}</button>
        )
      }
    >
      {!snap.canControl && <div className="alert alert-warn"><span>이 장치는 채널 상태를 보고하지 않아 점검할 수 없습니다. 채널 릴레이용 새 스케치를 올리세요.</span></div>}
      {snap.canControl && !snap.relay && <div className="alert alert-warn"><span>마을 전원이 꺼져 있습니다. 전력 복구 뒤에 점검하세요.</span></div>}
      {chk.running && (
        <p className="row gap" style={{ margin: '0 0 12px' }}>
          <Status tone="accent" live>{chk.current ? `${name(chk.current).name} 점검 중…` : '준비 중…'}</Status>
          <span className="small muted">{chk.results.length} / {IOT_CHANNELS.length}</span>
        </p>
      )}
      {chk.results.length > 0 && (
        <div className="table-wrap">
          <table className="check-table">
            <thead>
              <tr><th>LED</th><th>구간</th><th>끄기 전</th><th>끈 뒤</th><th>줄어든 전류</th><th>판정</th></tr>
            </thead>
            <tbody>
              {chk.results.map((r) => {
                const c = name(r.id)
                return (
                  <tr key={r.id}>
                    <td>{c.name} <span className="muted xs">LED {c.ch}</span></td>
                    <td className="muted">{ZONE_LABEL[c.kind]}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{r.before === null ? '—' : `${r.before.toFixed(3)} A`}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{r.after === null ? '—' : `${r.after.toFixed(3)} A`}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{r.drop === null ? '—' : `${r.drop.toFixed(3)} A`}</td>
                    <td className={r.verdict === 'OK' ? 'ok' : r.verdict === 'SKIPPED' || r.verdict === 'UNMEASURED' ? 'muted' : 'bad'}>{VERDICT_TEXT[r.verdict]}{r.note ? ` · ${r.note}` : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {!chk.running && chk.finishedAt && (
        <p className="hint" style={{ marginTop: 12 }}>
          {bad.length ? `이상 LED: ${bad.map((r) => name(r.id).name).join(', ')}. 해당 LED와 저항, 채널 릴레이 배선을 확인하세요.` : chk.results.some((r) => r.verdict === 'OK') ? '점검한 LED가 모두 정상입니다.' : ''}
        </p>
      )}
      {chk.error && <div className="alert alert-err" style={{ marginTop: 12 }}><span>{chk.error}</span></div>}
    </Section>
  )
}
