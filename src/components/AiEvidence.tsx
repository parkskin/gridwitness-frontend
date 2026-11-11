import { featureLabel, METHOD_LABEL, REASON_SHORT } from '../lib/aiExplain'
import type { AiDetail } from '../types'
import { Gauge, Src } from './AiExplain'

/** AI가 이렇게 판단한(또는 보류한) 이유: 판단 기준 통과 여부 + 점수를 움직인 특징 */
export default function AiEvidence({ ai, compact }: { ai: AiDetail; compact?: boolean }) {
  const th = ai.thresholds
  const answered = ai.status === 'ok'
  const feats = ai.topFeatures.slice(0, compact ? 3 : 6)
  const maxAbs = Math.max(...feats.map((f) => Math.abs(f.contribution)), 1e-9)
  const hasGates = ai.topScore != null && th.score != null
  return (
    <div className="fa-card">
      <div className="fa-card-head">
        <strong>{answered ? 'AI가 이렇게 판단한 이유' : 'AI가 보류한 이유'}</strong>
        <Src kind="model" />
      </div>

      {hasGates && (
        <>
          <div className="small muted" style={{ marginBottom: 6 }}>{ai.modelCountry ? `${ai.modelCountry} 모델 ` : ''}서버에서 받은 판단 기준</div>
          <div className="gauges">
            <Gauge label="AI 원인 후보 1위 점수" note="최종 원인으로 표시할 최소 점수" value={ai.topScore ?? 0} limit={th.score} />
            {th.margin != null && ai.margin != null && <Gauge label="AI 1·2위 후보 점수 차" note="두 원인 후보를 구분하는 최소 차이" value={ai.margin} limit={th.margin} max={Math.max(0.5, th.margin * 2)} />}
            {th.ood_ratio != null && ai.oodRatio != null && <Gauge label="학습 범위 밖 특징" note="배운 적 있는 파형인가" value={ai.oodRatio} limit={th.ood_ratio} higherIsBetter={false} fmt={(x) => `${Math.round(x * 100)}%`} />}
          </div>
          <p className="hint">점수는 정답 확률이 아니에요. 세 기준을 모두 넘어야 결론을 내고, 하나라도 못 넘으면 보류해요.</p>
          {!answered && ai.reasonCodes.length > 0 && (
            <p className="small" style={{ margin: '8px 0 0' }}>
              <strong>보류 사유:</strong> {ai.reasonCodes.map((c) => REASON_SHORT[c] ?? c).join(' · ')}
            </p>
          )}
        </>
      )}

      {feats.length > 0 && (
        <>
          <div className="small muted" style={{ margin: '14px 0 6px' }}>
            {answered ? `${ai.topLabel ?? '판단한 유형'} 점수를 움직인 파형 특징` : '1순위 후보 점수를 움직인 파형 특징 (답이 아님, 참고용)'}
          </div>
          <ul className="ai-feats">
            {feats.map((f) => (
              <li key={f.name}>
                <span className="ai-feat-name" title={f.name}>{featureLabel(f.name)}</span>
                <span className="ai-feat-bar">
                  <i className={f.contribution >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(f.contribution) / maxAbs) * 50}%` }} />
                </span>
                <span className="num small">{f.contribution >= 0 ? '+' : '−'}{Math.abs(f.contribution).toFixed(3)}</span>
              </li>
            ))}
          </ul>
          {!compact && <p className="hint">{METHOD_LABEL[ai.method] ?? ai.method}. 막대 오른쪽(+)은 점수를 올림, 왼쪽(−)은 내림.</p>}
        </>
      )}
    </div>
  )
}
