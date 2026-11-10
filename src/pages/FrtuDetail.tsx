import { Link, useSearchParams } from 'react-router-dom'
import { FrtuStrip } from '../components/AiPanel'
import { LiveFrtuWaveAnalysis } from '../components/FrtuWaveAnalysis'
import { PageHeader } from '../components/ui'
import SingleLineDiagram from '../components/SingleLineDiagram'
import { frtuDisplayViews, isFrtuId, locateFault, type FrtuId } from '../lib/frtu'
import { inspectionCandidate } from '../lib/gis'
import { useVillage } from '../lib/village'

/** FRTU 파형 분석 페이지: 3D 마을 옆 패널에서 "FRTU 파형 분석 열기"로 들어옴. 파형 · 2D/3D · AI 진단 보고서 · 파형 요약 */
export default function FrtuDetail() {
  const [params, setParams] = useSearchParams()
  const snap = useVillage()
  const id: FrtuId = isFrtuId(params.get('id')) ? (params.get('id') as FrtuId) : snap.source === 'SERIAL' && snap.measurementScope === 'HOUSE' ? 'house' : 'inlet'
  const views = frtuDisplayViews(snap)
  const loc = locateFault(snap)
  const cand = inspectionCandidate(loc.scope)
  const fi = { inlet: views.inlet.fi, house: views.house.fi, lamp: views.lamp.fi }
  return (
    <>
      <PageHeader
        crumbs={[{ label: '3D 마을', to: `/village?frtu=${id}` }, { label: 'FRTU 파형 분석' }]}
        title="FRTU 파형 분석"
        description={snap.source === 'SERIAL' && snap.measurementScope === 'HOUSE' ? '주택 FRTU의 실제 INA219 전류·전압을 분석합니다. 인입과 가로등은 센서가 없어 판정을 내리지 않습니다.' : '연결된 INA219 범위의 실시간 전류·전압(직류 모형, 0.5초 간격)을 고장파형 분석과 같은 틀로 보여 줍니다.'}
        actions={<Link to={`/village?frtu=${id}`} className="btn">3D 마을로 돌아가기</Link>}
      />
      <div style={{ marginBottom: 14 }}>
        <FrtuStrip snap={snap} value={id} onPick={(next) => setParams(next === 'inlet' ? {} : { id: next }, { replace: true })} />
      </div>
      <LiveFrtuWaveAnalysis
        focus={id}
        extraMain={
          <div className="fa-card" style={{ marginTop: 14 }}>
            <div className="fa-card-head"><strong>고장 구간</strong><span className="small muted">{loc.title}</span></div>
            <SingleLineDiagram highlight={cand?.branches} fi={fi} candidate={cand} />
          </div>
        }
      />
    </>
  )
}
