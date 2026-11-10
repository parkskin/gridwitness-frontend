// 서버 대화 AI에 닿지 못할 때 쓰는 근거형 답변.
// 사건 근거 묶음(IncidentContext)에 있는 값만 문장으로 옮기고, 없는 것은 "모른다"고 보류한다.
// LLM이 아니므로 질문 의도를 몇 가지로만 가린다. 서버 대화 API가 붙으면 이 함수는 대체 경로로만 쓰인다.

import { eventKo, type IncidentContext } from './incidentContext'
import { formatModelScore } from './modelScore'

export type AnswerStatus = 'answered' | 'abstained' | 'refused'

export interface GroundedAnswer {
  text: string
  status: AnswerStatus
  /** 이 답에 쓴 근거 항목 id (IncidentContext.evidence) */
  evidenceIds: string[]
  abstainReasons: string[]
  neededInfo: string[]
}

const has = (t: string, re: RegExp) => re.test(t.replace(/\s+/g, ''))
const ids = (ctx: IncidentContext, ...groups: string[]) => ctx.evidence.filter((e) => groups.some((g) => e.id.startsWith(g))).map((e) => e.id)

/** 설비를 조작하라는 요청인지 (답하지 않고 거절) */
export const isControlRequest = (q: string) =>
  has(q, /(꺼|끄|켜줘|켜라|켜봐|차단해|차단시|투입해|투입시|개방해|개폐해|열어|닫아|복구해|복구시|재폐로|정전(을)?(일으|발생|시켜)|조작해|조작시|트립시)/) ||
  // '스위치 내려줘'처럼 설비 이름 + 조작 동사 (서버 규칙 gridwitness-api app/services/assistant.py 와 같게)
  has(q, /(스위치|개폐기|차단기|리클로저|릴레이|전원|선로).{0,6}(내려|올려|넣어|빼줘|빼라|조작)/)

function summary(ctx: IncidentContext): GroundedAnswer {
  const a = ctx.analysis
  if (ctx.diagnosis.status === 'REJECTED')
    return {
      text: `이 사건은 입력 검사에서 거부돼 AI 분석을 하지 않았어요. ${ctx.diagnosis.issues[0] ?? ''}`.trim(),
      status: 'abstained',
      evidenceIds: ids(ctx, 'diagnosis'),
      abstainReasons: ['입력 파형이 분석 조건을 충족하지 않음'],
      neededInfo: ['형식을 고친 원본 파형 파일'],
    }
  if (a.status === 'NONE')
    return {
      text: '이 사건은 아직 AI 분석을 실행하지 않았어요. 분석 결과가 없어 고장 유형을 말씀드릴 수 없어요.',
      status: 'abstained',
      evidenceIds: ids(ctx, 'analysis', 'diagnosis'),
      abstainReasons: ['분석 기록 없음'],
      neededInfo: ['사건 화면의 파형·AI 분석 탭에서 분석 실행'],
    }
  if (a.status === 'WITHHELD')
    return {
      text: `AI는 이 사건의 판단을 보류했어요. 이유: ${a.reasons.map((r) => r.replace(/[.\s]+$/, '')).join(', ') || '근거 부족'}.${a.ranking[0] ? ` 참고로 점수 1순위는 ${a.ranking[0].label}(${a.ranking[0].score.toFixed(2)})였지만 답으로 보지 마세요.` : ''}`,
      status: 'abstained',
      evidenceIds: ids(ctx, 'analysis', 'diagnosis'),
      abstainReasons: a.reasons,
      neededInfo: a.neededInfo,
    }
  const last = ctx.reviews[ctx.reviews.length - 1]
  return {
    text: `AI 분석 결과는 '${eventKo(a.label!)}'이고 모델 점수는 ${a.score != null ? formatModelScore(a.score) : '—'}예요. 이 점수는 정답 확률이 아니에요.${a.reasons.length ? ` 주의할 점: ${a.reasons.join(', ')}.` : ''} ${last ? `담당자 검토: ${last.reviewer} — ${last.verdict}.` : '아직 담당자 검토 전이라 최종 판단은 아니에요.'}`,
    status: 'answered',
    evidenceIds: ids(ctx, 'analysis.type', 'analysis.status', 'analysis.ranking', 'analysis.reason', 'review'),
    abstainReasons: [],
    neededInfo: [],
  }
}

export function groundedAnswer(question: string, ctx: IncidentContext): GroundedAnswer {
  const q = question.trim()
  const a = ctx.analysis

  if (isControlRequest(q))
    return {
      text: 'AI 도우미는 실제 설비를 열고 닫거나 복구하지 않아요. 설비 조작은 담당자가 정해진 절차에 따라 직접 해 주세요.',
      status: 'refused',
      evidenceIds: [],
      abstainReasons: ['설비 제어 요청은 대화 AI의 권한 밖'],
      neededInfo: [],
    }

  if (has(q, /(내일|모레|다음(달|주|번|고장)|미래|예측|앞으로|날까|될까|생길까|발생할까|가능성|언제나|통계|작년|올해|다른(지역|곳|동네)|주변|날씨|비와|금액|비용|보상|고객|가구|세대|몇명|인원|연락처|설치(됐|된|일)|사고이력|사장|점심|농담|몇시간|걸려|정전돼)/))
    return {
      text: '이 사건의 파형 분석 기록에는 미래 예측이나 다른 지역·운영 정보가 없어 이 질문은 보류해요.',
      status: 'abstained', evidenceIds: [], abstainReasons: ['미래 예측은 사건 분석 기록의 범위 밖'], neededInfo: [],
    }

  // 학습 데이터 출처의 "어디"는 설비 위치 질문이 아니다.
  if (has(q, /(어디|위치|구간|장소|먼저|어느쪽|점검순서|점검할|가봐야)/) && !has(q, /(데이터|파일|출처|학습|모델|데이터셋|배웠)/)) {
    const known = a.status === 'COMPLETED' ? ` 지금 확인된 것은 이벤트 유형(${eventKo(a.label!)})뿐이에요.` : ''
    return {
      text: `이 사건 자료에는 설비 위치나 선로 구간 정보가 연결돼 있지 않아 특정 장소를 지목할 수 없어요.${known}`,
      status: 'abstained',
      evidenceIds: ids(ctx, 'analysis.status', 'source'),
      abstainReasons: ['사건에 설비 위치·구간 정보 없음'],
      neededInfo: ['기록한 FRTU의 설치 위치와 담당 선로 구간 (K-GIS 등 전력 GIS의 계통 추적 결과)', '같은 시각 인접 FRTU의 기록'],
    }
  }

  // 물리적 원인: 모델이 분석하는 범위가 아니다
  if (has(q, /(원인|수목|나무|절연|동물|낙뢰|까치|접촉|왜났|왜생)/) && !has(q, /(근거|이유)/))
    return {
      text: `이 AI는 ${a.type ?? '이벤트 유형 분류'}만 해요. 수목 접촉·절연 파괴 같은 물리적 원인은 분석하지 않았기 때문에 추정해서 말씀드리지 않을게요.`,
      status: 'abstained',
      evidenceIds: ids(ctx, 'analysis.type', 'analysis.status'),
      abstainReasons: ['물리적 원인은 모델 분석 범위 밖'],
      neededInfo: ['현장 점검 결과', '원인이 확인된 과거 사고 기록'],
    }

  if (has(q, /(근거|이유|왜|어떻게판단|무엇을보고|뭘보고)/)) {
    if (a.status === 'NONE') return summary(ctx)
    const feats = a.topFeatures.map((f) => `${f.label}(${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(3)})`).join(', ')
    const rank = a.ranking.slice(0, 2).map((r) => `${r.label} ${r.score.toFixed(2)}`).join(' / ')
    return {
      text: `${a.status === 'COMPLETED' ? `'${eventKo(a.label!)}'로 본` : '판단을 보류한'} 근거예요. ${rank ? `유형별 점수 상위: ${rank}. ` : ''}${feats ? `판단에 크게 영향을 준 특징: ${feats}. ` : '특징별 기여도 기록은 없어요. '}${a.reasons.length ? `보류·주의 사유: ${a.reasons.join(', ')}.` : ''}`.trim(),
      status: a.status === 'COMPLETED' ? 'answered' : 'abstained',
      evidenceIds: ids(ctx, 'analysis', 'diagnosis.status'),
      abstainReasons: a.status === 'WITHHELD' ? a.reasons : [],
      neededInfo: a.neededInfo,
    }
  }

  if (has(q, /(모델|버전|믿|신뢰|정확|학습)/))
    return {
      text: ctx.model.version
        ? `이 사건은 모델 ${ctx.model.version}${ctx.model.preprocess ? ` (전처리 ${ctx.model.preprocess})` : ''}로 분석했어요.${ctx.model.dataset ? ` 학습 데이터: ${[ctx.model.country, ctx.model.dataset].filter(Boolean).join(' · ')}.` : ''}${ctx.model.limitations[0] ? ` 한계: ${ctx.model.limitations[0]}` : ''}`
        : '이 사건은 아직 모델로 분석하지 않아 모델 정보가 없어요.',
      status: ctx.model.version ? 'answered' : 'abstained',
      evidenceIds: ids(ctx, 'model'),
      abstainReasons: ctx.model.version ? [] : ['분석 기록 없음'],
      neededInfo: [],
    }

  if (has(q, /(검토|담당자|확정|최종|누가)/))
    return {
      text: ctx.reviews.length
        ? ctx.reviews.map((r) => `${r.reviewer}: ${r.verdict}${r.finalJudgment ? ` — ${r.finalJudgment}` : ''}`).join('\n') + '\nAI 결과와 담당자 판단은 따로 기록돼요.'
        : '아직 담당자 검토가 없어요. AI 결과는 제안일 뿐이고, 최종 판단은 검토에서 확정돼요.',
      status: 'answered',
      evidenceIds: ids(ctx, 'review'),
      abstainReasons: [],
      neededInfo: [],
    }

  if (has(q, /(입력|데이터|파일|적합|진단|샘플링|채널|출처)/))
    return {
      text: `입력 검사 결과는 '${{ ACCEPTED: '통과', LIMITED: '제한 통과', REJECTED: '거부' }[ctx.diagnosis.status]}'예요.${ctx.diagnosis.issues.length ? ` 확인 사항: ${ctx.diagnosis.issues.slice(0, 2).join(' / ')}` : ' 확인할 문제는 없었어요.'}`,
      status: 'answered',
      evidenceIds: ids(ctx, 'diagnosis', 'source'),
      abstainReasons: [],
      neededInfo: [],
    }

  if (has(q, /(고장|무슨|어떤|상태|판정|결과|요약|발생|뭐야|알려)/)) return summary(ctx)

  return {
    text: '그 질문은 이 사건의 분석 기록으로 답할 수 없어 보류할게요. 고장 유형, 판단 근거, 모델 정보, 검토 이력, 입력 데이터에 대해 물어봐 주세요.',
    status: 'abstained',
    evidenceIds: [],
    abstainReasons: ['사건 기록 범위 밖의 질문'],
    neededInfo: [],
  }
}
