import { cancelComboCalibrate, runComboCalibrate, useComboCalibrate } from '../lib/comboCalibrate'
import { COMBO, COMBO_TOL_A, getComboCalibration, setComboCalibration, type VillageSnapshot } from '../lib/village'
import { Section, Status } from './ui'

/** 시연할 PC에서 정상 기준을 다시 맞춤 (USB 전원·포트에 따라 정상 전류가 조금 달라짐) */
export default function ComboCalibratePanel({ snap }: { snap: VillageSnapshot }) {
  const st = useComboCalibrate()
  const cal = getComboCalibration()
  const ready = snap.source === 'SERIAL' && snap.connected && snap.canControl && snap.relay && snap.measurementScope === 'BOTH'
  return (
    <Section
      title="기준 다시 맞추기"
      description={snap.source === 'SERIAL' && snap.measurementScope === 'HOUSE' ? '현재는 주택 분기만 실측합니다. 두 분기 5개 채널의 기존 학습 조합표를 잘못 덮어쓰지 않도록 보정을 막았습니다.' : 'LED가 모두 정상일 때 누르세요. 32가지 채널 조합을 차례로 만들며 정상 전류를 재서(약 2분) 이 PC의 기준으로 씁니다. 같은 모형이라도 USB 포트·충전기가 바뀌면 정상 전류가 조금 달라지기 때문입니다.'}
      actions={
        st.running ? (
          <button className="btn" onClick={cancelComboCalibrate}>
            멈추기
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void runComboCalibrate()} disabled={!ready}>
            기준 맞추기 시작
          </button>
        )
      }
    >
      {!ready && !st.running && <p className="small muted">우노를 연결하고 마을 전원이 들어와 있어야 합니다.</p>}
      {st.running && (
        <Status tone="accent" live>
          조합 {st.done} / {st.total} 재는 중… (집·가로등이 잠깐씩 꺼집니다)
        </Status>
      )}
      {st.error && (
        <div className="alert alert-warn">
          <span>{st.error}</span>
        </div>
      )}
      <dl className="dl-rows" style={{ marginTop: 12 }}>
        <div>
          <dt>지금 쓰는 기준</dt>
          <dd>
            {cal ? (
              <>
                이 PC에서 맞춘 값 ({new Date(cal.at).toLocaleString('ko-KR')}) · 학습값과 최대 {(cal.maxShiftA * 1000).toFixed(2)} mA 차이
                <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setComboCalibration(null)}>
                  학습값으로 되돌리기
                </button>
              </>
            ) : (
              <>학습값 · {COMBO.source}</>
            )}
          </dd>
        </div>
        <div>
          <dt>판정 기준</dt>
          <dd>
            |측정 − 정상| &gt; {COMBO.k_sigma}×흔들림 + {(COMBO_TOL_A * 1000).toFixed(1)} mA 이면 이상 (흔들림은 학습값)
          </dd>
        </div>
      </dl>
    </Section>
  )
}
