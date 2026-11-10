// FRTU 상세 화면(마을 모형 DC 계측)의 상태 조회 도우미.
// LLM 없이 질문 의도를 규칙으로 골라 현재 계측·AI 판정 값을 그대로 읽어 줌 (값을 지어내지 않음).
// 대화로 장치를 조작하지 않는다. LED·릴레이 조작은 마을 화면의 제어판에서만 한다.
// 교류 고장파형 사건에 대한 현장 대응 대화는 components/AssistantChat (사건별) 이 맡는다.

import { FRTUS, frtuViews, locateFault } from './frtu'
import { inspectionCandidate } from './gis'
import { getVillage, IOT_CHANNELS, STATUS_LABEL } from './village'
import type { VillageSnapshot } from './village'
import { DEVICE_INFO, SOURCE_LABEL } from './village'
import type { AnalyzedEvent } from './villageEvents'
import { formatModelScore } from './modelScore'

export interface VillageEvidence { id: string; label: string; value: string }

/** Build a bounded, source-labelled snapshot. Missing/stale measurements are never encoded as zero. */
export function buildVillageEvidence(s: VillageSnapshot, events: AnalyzedEvent[], now = Date.now()): VillageEvidence[] {
  const evidence: VillageEvidence[] = []
  const add = (id: string, label: string, value: string) => evidence.push({ id: `village.${id}`, label, value: value.slice(0, 1000) })
  const source = SOURCE_LABEL[s.source]
  const stale = s.source === 'SERIAL' && s.connected && (!s.lastPacketAt || now - s.lastPacketAt > 5000)
  const available = s.connected && s.status !== 'NO_DATA' && !stale
  add('source', '자료 출처', `${source} · ${DEVICE_INFO[s.source].deviceId}`)
  add('status', '마을 상태', available ? STATUS_LABEL[s.status] : stale ? '오래된 계측 · 최신 값 없음' : '계측 데이터 없음')
  if (available) {
    add('measurement.total', '전체 실측', `${s.v.toFixed(2)} V · ${(s.i * 1000).toFixed(1)} mA · 릴레이 ${s.relay ? '투입' : '차단'} · ${new Date(s.lastPacketAt!).toISOString()}`)
    add('channels', '채널 상태', IOT_CHANNELS.map((c) => `${c.name} ${s.channels[c.id] ? 'ON' : 'OFF'}`).join(' · '))
    const views = frtuViews(s)
    for (const f of Object.values(views)) add(`frtu.${f.def.id}`, f.def.name, f.available
      ? `${STATUS_LABEL[f.status]} · ${f.v.toFixed(2)} V · 측정 ${(f.i * 1000).toFixed(1)} mA · 예상 ${(f.expected * 1000).toFixed(1)} mA · FI ${f.fi}`
      : `측정 불가: ${f.unavailableReason ?? '값 없음'}`)
    const loc = locateFault(s, views)
    add('location', 'FRTU 구간 판정', `${loc.title}${loc.reasons.length ? ` · ${loc.reasons.join(' / ')}` : ''}`)
  } else {
    add('measurement.total', '전체 실측', stale ? '최신 계측이 5초 이상 수신되지 않음' : '현재 계측값 없음')
    for (const id of ['inlet', 'house', 'lamp']) add(`frtu.${id}`, `${id} FRTU`, '현재 측정 불가 · 0으로 간주하지 않음')
  }
  for (const [index, item] of events.slice(0, 3).entries()) {
    const e = item.e
    const prefix = `event.${index === 0 ? 'latest' : index + 1}`
    const eventSource = `${e.source === 'MOCK' ? '시뮬레이터' : e.source === 'SERIAL' ? '실측 Arduino' : '출처 미기록'} · ${new Date(e.receivedAt).toISOString()}`
    const verdict = item.verdict.kind === 'ANSWERED' || item.verdict.kind === 'WITHHELD'
      ? `${item.verdict.kind === 'ANSWERED' ? '판정' : '보류'} ${item.verdict.labelKo} · 점수 ${item.verdict.score.toFixed(2)} (확률 아님)`
      : item.verdict.kind === 'NO_MODEL' ? '분류 모델 없음' : `입력 거부 · ${item.verdict.reasons[0] ?? '사유 없음'}`
    add(`${prefix}.summary`, `저장 사건 #${e.ev}`, `${eventSource} · ${e.src === 'cmd' ? `명령 직후 ${e.cmd || '(명령 미기록)'}` : '자동 감지'} · ${verdict} · ${e.i100.length}개 원시 표본 · 채널 ${e.ch.join('')}`)
    if (item.verdict.kind === 'ANSWERED' || item.verdict.kind === 'WITHHELD') {
      item.verdict.evidence.slice(0, 4).forEach((f, n) => add(`${prefix}.feature.${n}`, f.label, `${f.value.toFixed(3)} · 기여도 ${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(3)}`))
    }
  }
  // Keep a representative of each UNO trigger type even when newer events
  // have pushed it out of the recent-three window. This enables a factual
  // comparison between a recorded relay command and an automatic capture.
  for (const [kind, src] of [['command', 'cmd'], ['automatic', 'auto']] as const) {
    const item = events.find((candidate) => candidate.e.src === src)
    if (!item) continue
    const e = item.e
    const verdict = item.verdict.kind === 'ANSWERED' || item.verdict.kind === 'WITHHELD'
      ? `${item.verdict.kind === 'ANSWERED' ? '판정' : '보류'} ${item.verdict.labelKo} · 점수 ${item.verdict.score.toFixed(2)} (확률 아님)`
      : item.verdict.kind === 'NO_MODEL' ? '분류 모델 없음' : `입력 거부 · ${item.verdict.reasons[0] ?? '사유 없음'}`
    const eventSource = e.source === 'MOCK' ? '시뮬레이터' : e.source === 'SERIAL' ? '실측 Arduino' : '출처 미기록'
    add(`event.${kind}.summary`, `${kind === 'command' ? '최근 명령 사건' : '최근 자동 감지 사건'} #${e.ev}`, `${eventSource} · ${new Date(e.receivedAt).toISOString()} · ${e.src === 'cmd' ? `명령 직후 ${e.cmd || '(명령 미기록)'}` : '자동 감지'} · ${verdict} · ${e.i100.length}개 원시 표본 · 채널 ${e.ch.join('')}`)
  }
  return evidence.slice(0, 32)
}

export interface ChatMsg {
  role: 'user' | 'bot'
  text: string
}

export function villageChatHistory(messages: ChatMsg[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages.slice(1).slice(-12).map((m) => ({
    role: m.role === 'bot' ? 'assistant' as const : 'user' as const,
    content: m.role === 'bot' ? m.text.replace(/\n\[(?:서버 LLM|서버 규칙 답변|브라우저 규칙 답변)[^\]]*\]$/, '') : m.text,
  })).filter((turn) => turn.content.trim())
}

export const SUGGESTIONS = ['지금 상태 어때?', '어느 분기가 문제야?', 'FRTU별 전류는?', '왜 이상이야?', '마지막 사건 판정은?']

const has = (t: string, ...words: string[]) => words.some((w) => t.includes(w))

const CONTROL_REFUSAL = '대화 도우미는 장치를 켜고 끄지 않아요. LED·마을 전원 조작은 마을 화면의 제어판에서 직접 해 주세요.'

function verdictText(a: AnalyzedEvent): string {
  const v = a.verdict
  const source = `${a.e.source === 'MOCK' ? '시뮬레이터' : '실측 Arduino'} · ${new Date(a.e.receivedAt).toLocaleString('ko-KR')}`
  if (v.kind === 'ANSWERED') {
    const why = v.evidence.slice(0, 2).map((e) => e.label).join(', ')
    return `${source} 사건 #${a.e.ev}은(는) '${v.labelKo}'(으)로 판정했어요. 모델 점수 ${formatModelScore(v.score)} (정답 확률 아님), 주요 근거는 ${why}입니다.`
  }
  if (v.kind === 'WITHHELD') return `${source} 사건 #${a.e.ev}은(는) 판정을 보류했어요. 1순위는 '${v.labelKo}'였지만 ${v.reasons[0] ?? '근거가 부족'}해서요.`
  if (v.kind === 'NO_MODEL') return `${source} 사건 #${a.e.ev}의 파형은 기록했지만, 원인 분류 모델이 아직 학습 전이라 판정하지 않았어요.`
  return `${source} 사건 #${a.e.ev}은(는) 입력 검사에서 거부됐어요: ${v.reasons[0]}`
}

/** 질문 하나에 대한 답. 값을 읽어 줄 뿐, 장치에 명령을 보내지 않는다 */
export function answer(text: string, events: AnalyzedEvent[]): string {
  const t = text.trim()
  const s = getVillage()
  if (!t) return '무엇이 궁금하신가요?'

  // 조작 요청은 거절 (제어 로직과 대화 분리)
  if ((has(t, '정전') && has(t, '발생', '일으', '내줘', '시켜')) || has(t, '복구', '다시 켜', '꺼줘', '켜줘', '끄', '차단')) return CONTROL_REFUSAL

  // 지난 사건 조회는 현재 계측과 구분한다. 그 외 현재 상태·전압·원인에는
  // 연결 없음/오래된 계측의 0 값을 측정값이나 정상 근거로 쓰지 않는다.
  const pastEvent = has(t, '마지막', '최근', '판정', '사건')
  if (!pastEvent && (!s.connected || s.status === 'NO_DATA'))
    return '현재 계측값이 없어 전압·전류나 정상·복구 여부를 판단할 수 없어요. 실측 장치 연결과 최신 데이터 수신을 확인해 주세요.'

  // 위치·구간: FRTU별 고장표시로 좁힌 결과를 그대로 읽어 줌
  if (has(t, '어디', '위치', '구간', '분기', '먼저', '점검', 'FRTU', 'frtu') && !has(t, '전류', '전압')) {
    const loc = locateFault(s)
    if (loc.scope === 'NONE' || loc.scope === 'OFF' || loc.scope === 'NO_DATA') return `${loc.title}.`
    // 설비 연결정보(GIS)가 있으면 실제 설비 이름과 점검 순서까지
    const cand = inspectionCandidate(loc.scope)
    const order = cand ? `\n점검 후보: ${cand.section}\n점검 순서: ${cand.steps.map((st, k) => `${k + 1}) ${st.label}`).join(' → ')}\n(설비 정보: ${cand.source})` : ''
    return `${loc.title}.\n근거:\n${loc.reasons.map((r) => `· ${r}`).join('\n')}${order}\n분기 안의 어느 LED인지는 제어판의 채널 점검으로 확인해 주세요.`
  }

  // 조회
  if (has(t, '마지막', '최근', '판정', '사건')) {
    if (!events.length) return '아직 AI가 판정할 사건 파형이 없어요. LED를 끄거나 켜면 사건이 기록돼요.'
    return verdictText(events[0])
  }
  if (has(t, '왜', '이유', '원인', '근거')) {
    if (s.diagnosis) {
      const who = s.diagnosis.candidates.map((id) => s.leds[id].name).join(', ')
      return `${s.diagnosis.kind === 'LOW' ? '켠 LED 중 전류가 흐르지 않는 것이 있어요' : '예상보다 전류가 많이 흘러요'}${who ? `. 의심 위치: ${who}` : ''}. 측정 ${(s.i * 1000).toFixed(1)} mA, 예상 ${(s.expected * 1000).toFixed(1)} mA입니다.`
    }
    if (events[0]) return verdictText(events[0])
    return `지금은 이상 근거가 없어요. 이상 점수 ${s.score.toFixed(2)}로 기준(주의 0.3) 아래입니다.`
  }
  if (has(t, '전류')) {
    const fv = frtuViews(s)
    return FRTUS.map((f) => `${f.name}: ${fv[f.id].available ? `${(fv[f.id].i * 1000).toFixed(1)} mA (예상 ${(fv[f.id].expected * 1000).toFixed(1)} mA)` : '값 없음'}`).join('\n')
  }
  if (has(t, '전압')) return `전압은 ${s.v.toFixed(2)} V예요.`
  if (has(t, '상태', '어때', '괜찮', '현황', '정상')) {
    if (!s.connected) return '실측 장치와 연결이 끊겨 있어요. 메뉴의 실측 장치에서 다시 연결해 주세요.'
    const off = IOT_CHANNELS.filter((c) => !s.leds[c.id].channelOn).map((c) => c.name)
    return `마을은 '${STATUS_LABEL[s.status]}' 상태예요. ${s.v.toFixed(2)} V, ${(s.i * 1000).toFixed(1)} mA, 이상 점수 ${s.score.toFixed(2)}${off.length ? `. 꺼 둔 LED: ${off.join(', ')}` : '. LED는 모두 켜져 있어요'}.`
  }
  return "아직 그 질문은 이해하지 못해요. '지금 상태 어때?', '어느 분기가 문제야?', '왜 이상이야?'처럼 물어봐 주세요."
}

