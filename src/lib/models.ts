import { getVillage, IOT_MODEL, THRESHOLDS } from './village'
import { MODEL_SCOPE } from './waveform'

// 목적별로 분리한 AI 모델 2종 (데이터를 섞어 학습하지 않음)
export const AI_MODELS = [
  {
    name: 'IoT 이상 탐지',
    get version() { return getVillage().source === 'SERIAL' && getVillage().measurementScope === 'HOUSE' ? 'iot-house-residual-v1 (주택 분기 기준 전류 잔차 규칙)' : IOT_MODEL },
    get input() { return getVillage().source === 'SERIAL' && getVillage().measurementScope === 'HOUSE' ? 'INA219 0x40 주택 분기 전압·전류 + 주택 릴레이 상태 (5V DC, 0.5초)' : '주택·가로등 실측 합계 전압·전류 + 릴레이 상태 (5V DC, 0.5초)' },
    get output() {
      return `이상 점수 0~1 · 주의 ≥ ${THRESHOLDS.warn} · 이상 ≥ ${THRESHOLDS.fault}`
    },
    get data() { return getVillage().source === 'SERIAL' && getVillage().measurementScope === 'HOUSE' ? 'Arduino + INA219 0x40 주택 분기 실측 · 가로등은 분석에서 제외' : 'Arduino + INA219 모형 계측 (확인된 센서 구성)' },
  },
  {
    name: '고장파형 분류',
    version: '연결·버전은 서버 기능 상태에서 확인',
    input: `CN ${MODEL_SCOPE.rows}×${MODEL_SCOPE.cols} · ${MODEL_SCOPE.samplingRateHz}Hz / RU 512×5 · 1600Hz`,
    output: 'CN SIF·MIF·PF·TD / RU 정상·개폐·이상·사고 또는 판단 보류',
    data: '중국 Xiong · 러시아 OscGrid (나라별 모델)',
  },
]
