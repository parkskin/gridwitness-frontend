import { Link, useSearchParams } from 'react-router-dom'
import { FrtuStrip } from '../components/AiPanel'
import { LiveFrtuWaveAnalysis } from '../components/FrtuWaveAnalysis'
import { PageHeader } from '../components/ui'
import { isFrtuId, type FrtuId } from '../lib/frtu'
import { useVillage } from '../lib/village'

/** FRTU 파형 분석 페이지: 3D 마을 옆 패널에서 "FRTU 파형 분석 열기"로 들어옴. 파형 · 2D/3D · AI 진단 보고서 · 파형 요약 */
export default function FrtuDetail() {
  const [params, setParams] = useSearchParams()
  const id: FrtuId = isFrtuId(params.get('id')) ? (params.get('id') as FrtuId) : 'inlet'
  const snap = useVillage()
  return (
    <>
      <PageHeader
        crumbs={[{ label: '3D 마을', to: `/village?frtu=${id}` }, { label: 'FRTU 파형 분석' }]}
        title="FRTU 파형 분석"
        description="마을 FRTU 3대의 실시간 전류·전압(직류 모형, 0.5초 간격)을 고장파형 분석과 같은 틀로 보여 주고, AI 진단 보고서를 함께 냅니다."
        actions={<Link to={`/village?frtu=${id}`} className="btn">3D 마을로 돌아가기</Link>}
      />
      <div style={{ marginBottom: 14 }}>
        <FrtuStrip snap={snap} value={id} onPick={(next) => setParams(next === 'inlet' ? {} : { id: next }, { replace: true })} />
      </div>
      <LiveFrtuWaveAnalysis focus={id} />
    </>
  )
}
