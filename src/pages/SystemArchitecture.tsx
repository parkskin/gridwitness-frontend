import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { IconBrain, IconDatabase, IconPerson, IconPlug, IconWave } from '../components/Icons'
import { PageHeader } from '../components/ui'
import { useBackendHealth, useCapabilities } from '../lib/backend'
import { EVENT_MODEL } from '../lib/villageEvents'
import { useVillage } from '../lib/village'
import { unoStatus } from '../lib/systemArchitectureStatus'

type Live = 'ok' | 'warn' | 'down' | 'idle'
interface Node {
  id: string
  title: string
  tech: string
  /** 지금 상태 (화면에서 실제로 확인한 값) */
  live?: { state: Live; text: string }
  does: string[]
  guard?: string
  link?: { to: string; label: string }
}
interface Lane { key: string; title: string; icon: ReactNode; nodes: Node[] }

const LIVE_LABEL: Record<Live, string> = { ok: '동작 중', warn: '확인 필요', down: '연결 안 됨', idle: '확인 전' }

/** 시스템 구조: 데이터가 어디서 들어와 어디서 판단되고, 누가 확정하는지 한 장으로. 각 칸의 상태는 지금 실제 연결 값 */
export default function SystemArchitecture() {
  const snap = useVillage()
  const health = useBackendHealth()
  const caps = useCapabilities()
  const uno = unoStatus(snap)
  const models = caps.data?.models ?? []
  const llm = caps.data?.assistant
  const apiLive: Node['live'] = health.state === 'ok' ? { state: 'ok', text: `DB 준비됨${caps.data?.auth.required ? ' · 접근 코드 필요' : ''}` } : health.state === 'down' ? { state: 'down', text: health.detail || '응답 없음' } : { state: 'idle', text: '확인 중' }
  const modelLive = (country: string): Node['live'] => {
    const m = models.find((x) => x.country === country)
    if (!caps.data) return { state: caps.state === 'down' ? 'down' : 'idle', text: caps.state === 'down' ? '서버 응답 없음' : '확인 중' }
    return m?.available ? { state: 'ok', text: `사용 가능 · ${m.channels.length}채널 · ${m.sampling_rate_hz.toLocaleString()}Hz` } : { state: 'warn', text: '서버에 모델 없음' }
  }

  const lanes: Lane[] = [
    {
      key: 'in', title: '① 데이터 입력', icon: <IconPlug />,
      nodes: [
        {
          id: 'uno', title: '마을 모형 (우노)', tech: 'Arduino Uno · 분기 센서 0x40/0x41 · 릴레이 · USB 시리얼',
          live: { state: uno.state, text: uno.text },
          does: [
            snap.source === 'MOCK'
              ? '시뮬레이터가 전체·분기 값을 계산 (실측 아님)'
              : snap.connected && snap.zones
                ? '주택 0x40·가로등 0x41 분기별 실측값 수신 중'
                : '두 센서가 인식되면 주택·가로등 분기별 측정값 수신 (0.5초)',
            '전류가 급변하면 사건 파형을 녹화해 전송',
            '릴레이로 정전·복구 명령 수행',
          ],
          guard: `${uno.detail} · 실측과 시뮬레이터를 구분해 표시`,
          link: { to: '/village', label: '3D 마을' },
        },
        {
          id: 'wave', title: '고장파형 원본', tech: 'CSV · COMTRADE(.cfg+.dat)',
          does: ['공개 데이터셋 파형 등록 (중국 Xiong 7채널 · 러시아 OscGrid 5채널)', '원본 파일은 그대로 보존하고 SHA-256 해시 기록'],
          guard: '없는 채널을 합성하지 않고, 다른 나라 파형은 그 나라 모델로만',
          link: { to: '/cases/new', label: '고장파형 등록' },
        },
        {
          id: 'kepco', title: '한전 공공데이터', tech: '시간별 전력사용량 (공공데이터포털)',
          does: ['지역·계약종별 사용 패턴 조회', '마을 부하 시나리오로 재생'],
          guard: '사용량 자료는 고장 판단 학습에 섞지 않음',
          link: { to: '/public-data', label: '공공데이터' },
        },
      ],
    },
    {
      key: 'web', title: '② 웹 (브라우저)', icon: <IconWave />,
      nodes: [
        {
          id: 'serial', title: '실시간 감시 · 고장표시', tech: 'React · TypeScript · Web Serial',
          does: ['조합별 정상 전류표와 비교해 이상 점수 계산', 'FRTU 3대 고장표시(FI) → 고장 구간 · 점검 순서', 'FI 교차검증: 순간 과도면 "오표시 의심"'],
          guard: '오래된 값·미응답 센서를 0으로 만들지 않음',
        },
        {
          id: 'calc', title: '입력 검증 · 파형 계산', tech: '브라우저 계산 (AI 판단과 별개)',
          does: ['채널·단위·샘플링·품질 검사 후에만 분석', '급변 시점 · 피크·RMS 변화 · 평소 vs 지금 비교'],
          guard: '검증에서 거부된 자료는 분석하지 않음',
        },
        {
          id: 'villageAi', title: '마을 사건 AI', tech: `브라우저 내 트리 모델 · ${EVENT_MODEL.labels.length}유형`,
          live: { state: 'ok', text: `학습 ${Object.values(EVENT_MODEL.data?.counts ?? {}).reduce((a, b) => a + b, 0)}건 · 기준 ${EVENT_MODEL.thresholds.score}` },
          does: ['우노가 녹화한 사건 파형을 개폐·단선·순간/반복 접촉 불량·재접속으로 분류', '점수와 1·2위 차가 기준 미달이면 판단 보류'],
          guard: '서버 없이도 동작 (통신 끊겨도 판정 가능)',
        },
      ],
    },
    {
      key: 'api', title: '③ API 서버', icon: <IconDatabase />,
      nodes: [
        {
          id: 'api', title: 'GridWitness API', tech: 'FastAPI · SQLite · systemd',
          live: apiLive,
          does: ['사건·원본 파형·분석·검토·대화 기록 저장', '모델과 LLM 호출을 한곳에서 관리', '연결이 끊기면 브라우저에 보존 후 재전송'],
          guard: '접근 코드 인증 · 배포 전 코드·DB 백업',
          link: { to: '/settings', label: '연결 상태' },
        },
      ],
    },
    {
      key: 'ai', title: '④ AI · LLM', icon: <IconBrain />,
      nodes: [
        {
          id: 'cn', title: '고장파형 모델 CN', tech: 'RandomForest · TreeSHAP · Xiong 2020',
          live: modelLive('CN'),
          does: ['이벤트 유형 분류: SIF · MIF · PF · TD', '점수 · 1·2위 차 · 학습 범위 3가지 기준 모두 넘어야 결론'],
          guard: '물리적 원인·위치는 확정하지 않음 · 점수는 확률 아님',
        },
        {
          id: 'ru', title: '고장파형 모델 RU', tech: 'RandomForest · OscGrid',
          live: modelLive('RU'),
          does: ['이벤트 유형 분류: 정상 · 개폐 · 비정상 · 고장'],
          guard: '데이터셋 나라로 모델을 정하고 임의로 바꾸지 않음',
        },
        {
          id: 'llm', title: '현장 대화 LLM', tech: `Ollama${llm?.model ? ` · ${llm.model}` : ''} · GPU 서버`,
          live: !caps.data ? { state: caps.state === 'down' ? 'down' : 'idle', text: caps.state === 'down' ? '서버 응답 없음' : '확인 중' } : !llm?.configured ? { state: 'warn', text: '미설정 · 규칙 답변' } : llm.available === false ? { state: 'warn', text: '모델 확인 안 됨 · 규칙 답변' } : { state: 'ok', text: `${llm.model ?? '모델'} 목록 확인됨` },
          does: ['음성·글 질문을 이해하고 기록된 근거 ID를 골라 설명', '답은 음성으로 읽어 줌 (말이 끝나면 자동 전송)'],
          guard: '판정하지 않음 · 장치 제어 요청은 모델 호출 전에 거절',
        },
      ],
    },
    {
      key: 'human', title: '⑤ 사람 · 기록', icon: <IconPerson />,
      nodes: [
        {
          id: 'review', title: '담당자 검토', tech: '사건 기록 · 검토·승인 칸',
          does: ['AI 결과를 보고 동의·반대·추가 조사 판단', '판단한 원인을 기록'],
          link: { to: '/cases', label: '사건 기록' },
        },
        {
          id: 'approve', title: '최종 승인 (2인)', tech: '검토자와 다른 사람',
          does: ['확정 원인 승인 또는 반려', '확정된 사건만 사고 기록 · 학습 후보'],
          guard: '지금은 시연 단계 (이름 기반) · 운영 시 조직 인증으로 대체',
        },
      ],
    },
  ]

  const all = lanes.flatMap((l) => l.nodes)
  const [pick, setPick] = useState<string>('serial')
  const sel = all.find((n) => n.id === pick) ?? all[0]

  return (
    <>
      <PageHeader
        title="시스템 구조"
        description="데이터가 어디서 들어와 어디서 판단되고, 누가 확정하는지 한 장으로 보여 줘요. 각 칸의 상태 점은 지금 실제 연결 값이에요."
      />

      <div className="arch">
        {lanes.map((lane, li) => (
          <section key={lane.key} className="arch-lane">
            <h3><span className="arch-ico">{lane.icon}</span>{lane.title}</h3>
            {lane.nodes.map((n) => (
              <button key={n.id} type="button" className={`arch-node ${pick === n.id ? 'on' : ''}`} onClick={() => setPick(n.id)} aria-pressed={pick === n.id}>
                <span className="arch-node-top">
                  <b>{n.title}</b>
                  {n.live && <i className={`arch-dot ${n.live.state}`} title={LIVE_LABEL[n.live.state]} />}
                </span>
                <small>{n.tech}</small>
                {n.live && <span className={`arch-live ${n.live.state}`}>{n.live.text}</span>}
              </button>
            ))}
            {li < lanes.length - 1 && <span className="arch-arrow" aria-hidden>→</span>}
          </section>
        ))}
      </div>

      <div className="arch-detail">
        <div>
          <div className="arch-detail-head">
            <strong>{sel.title}</strong>
            <span className="small muted">{sel.tech}</span>
            {sel.live && <span className={`arch-live ${sel.live.state}`}>{LIVE_LABEL[sel.live.state]} · {sel.live.text}</span>}
          </div>
          <ul>{sel.does.map((d) => <li key={d}>{d}</li>)}</ul>
          {sel.guard && <p className="arch-guard"><b>안전장치</b> {sel.guard}</p>}
          {sel.link && <Link to={sel.link.to} className="btn btn-sm">{sel.link.label} 열기</Link>}
        </div>
      </div>

      <div className="arch-flows">
        <div>
          <b>실시간 사건 흐름</b>
          <ol>
            <li>우노 0.5초 계측</li>
            <li>브라우저 이상 점수 · FI · 고장 구간</li>
            <li>FI 교차검증 · 사건 파형 AI</li>
            <li>사건 자동 등록 → API 저장</li>
            <li>담당자 검토 → 2인 승인 → 확정</li>
          </ol>
        </div>
        <div>
          <b>고장파형 분석 흐름</b>
          <ol>
            <li>CSV·COMTRADE 등록 · 해시 보존</li>
            <li>입력 검증 (채널·단위·품질)</li>
            <li>CN/RU 모델 선택 → 3가지 기준</li>
            <li>결론 또는 판단 보류 + 근거</li>
            <li>LLM이 근거를 골라 설명 · 사람 확정</li>
          </ol>
        </div>
      </div>
    </>
  )
}
