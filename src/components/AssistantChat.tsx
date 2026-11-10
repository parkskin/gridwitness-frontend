import { useEffect, useRef, useState } from 'react'
import { askAssistant, assistantTimeoutMs, getAssistantConversationNotice, getCachedAssistantMessages, listAssistantMessages, resetAssistantConversation, retryAssistantMessages, type AssistantMeta, type AssistantTurn } from '../api/assistant'
import { getActor } from '../lib/actor'
import { apiBase, useCapabilities } from '../lib/backend'
import { EVIDENCE_GROUP_LABEL, type EvidenceGroup } from '../lib/incidentContext'
import type { IncidentCase } from '../types'

// ── 브라우저 음성 인식 (Chrome·Edge·Safari, 노트북·스마트폰 내장 마이크) ──
type RecResult = { isFinal: boolean; 0: { transcript: string } }
type Rec = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: (e: { resultIndex: number; results: ArrayLike<RecResult> }) => void
  onend: () => void
  onerror: (e: { error: string }) => void
  start: () => void
  stop: () => void
}
const RecCtor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

const MIC_ERROR: Record<string, string> = {
  'not-allowed': '마이크 권한이 없어요. 브라우저 주소창에서 마이크를 허용하거나 글로 질문해 주세요.',
  'service-not-allowed': '이 브라우저에서 음성 인식을 쓸 수 없어요. 글로 질문해 주세요.',
  'no-speech': '말소리를 듣지 못했어요. 다시 눌러 말하거나 글로 질문해 주세요.',
  'audio-capture': '마이크를 찾지 못했어요. 글로 질문해 주세요.',
  network: '음성 인식 서버에 연결하지 못했어요. 글로 질문해 주세요.',
}

function speak(text: string) {
  if (!canSpeak) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'ko-KR'
  window.speechSynthesis.speak(u)
}

const FIELD_SUGGESTIONS = ['현재 어떤 고장이 발생했어?', '어디를 먼저 점검해야 해?', '이 판단의 근거는 뭐야?', '어떤 모델로 분석했어?', '담당자 검토는 어떻게 됐어?']

const STATUS_CHIP: Record<AssistantMeta['status'], [string, string]> = {
  answered: ['ok', '근거 있는 답'],
  abstained: ['warn', '판단 보류'],
  refused: ['err', '요청 거절'],
}
const FALLBACK_REASON: Record<string, string> = {
  llm_not_configured: '서버 LLM이 설정되지 않았어요.',
  llm_unavailable: '서버 LLM에 연결하지 못했어요.',
  llm_timeout: '서버 LLM 응답 시간이 초과됐어요.',
  llm_invalid_response: '서버 LLM의 응답 형식이 올바르지 않았어요.',
  llm_unsupported_evidence: 'LLM 답변의 근거 검증을 통과하지 못했어요.',
  llm_abstained: 'LLM이 답변을 보류했어요.',
  safety_policy: '설비 제어 요청은 규칙으로 거절해요.',
  unsupported_scope: '이 사건 기록으로 확인할 수 없는 질문이에요.',
}

function BotMeta({ m, text }: { m: AssistantMeta; text: string }) {
  const groups = Object.entries(
    m.evidence.reduce<Record<string, typeof m.evidence>>((acc, e) => ((acc[e.group] ??= []).push(e), acc), {}),
  ) as [EvidenceGroup, typeof m.evidence][]
  const [tone, label] = STATUS_CHIP[m.status]
  return (
    <div className="chat-meta">
      <div className="chat-meta-row">
        <span className={`chat-tag ${tone}`}>{label}</span>
        <span className="chat-tag">{m.answerMode === 'llm' ? '서버 LLM' : m.answerMode === 'rules' ? '서버 규칙' : m.mode === 'server' ? '서버 답변 · 방식 미확인' : '브라우저 규칙'}</span>
        {m.answerMode === 'llm' && m.llmModel && <span className="chat-tag mono">LLM {m.llmModel}</span>}
        {m.modelVersion && <span className="chat-tag mono">파형 모델 {m.modelVersion}</span>}
        {canSpeak && <button type="button" className="chat-replay" onClick={() => speak(text)} aria-label="이 답 다시 듣기">다시 듣기</button>}
      </div>
      {m.notice && <div className={`chat-notice ${m.notice.tone}`}>{m.notice.text}</div>}
      {m.fallbackReason && <div className="chat-notice warn">대체 답변 사유: {FALLBACK_REASON[m.fallbackReason] ?? m.fallbackReason}</div>}
      {m.abstainReasons.length > 0 && (
        <div className="chat-why"><b>{m.status === 'refused' ? '거절 이유' : '보류 이유'}</b> {m.abstainReasons.join(' · ')}</div>
      )}
      {m.neededInfo.length > 0 && (
        <div className="chat-why"><b>더 필요한 정보</b><ul>{m.neededInfo.map((n) => <li key={n}>{n}</li>)}</ul></div>
      )}
      {m.evidence.length > 0 && (
        <details className="chat-evidence">
          <summary>답에 쓴 근거 {m.evidence.length}건</summary>
          {groups.map(([g, items]) => (
            <div key={g} className="chat-ev-group">
              <div className="chat-ev-head">{EVIDENCE_GROUP_LABEL[g] ?? g}</div>
              <dl>{items.map((e) => <div key={e.id}><dt>{e.label}</dt><dd>{e.value}</dd></div>)}</dl>
            </div>
          ))}
        </details>
      )}
      <div className="chat-disclaimer">AI 제안이에요. 최종 판단과 설비 조작은 담당자가 해요.</div>
    </div>
  )
}

/** 사건 하나에 대한 현장 대응 AI 대화. 글·음성으로 묻고, 근거와 판단 보류 이유를 함께 보여준다. 설비는 조작하지 않는다 */
type AssistantChatProps = { c: IncidentCase; variant?: 'panel' | 'field' | 'popup' }
export default function AssistantChat(props: AssistantChatProps) {
  return <AssistantConversation key={`${apiBase()}.${props.c.id}`} {...props} />
}
function AssistantConversation({ c, variant = 'panel' }: AssistantChatProps) {
  const [turns, setTurns] = useState<AssistantTurn[]>(() => getCachedAssistantMessages(c))
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [cancellable, setCancellable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capabilities = useCapabilities()
  const [input, setInput] = useState('')
  const [fromVoice, setFromVoice] = useState(false)
  const [listening, setListening] = useState(false)
  const [micMsg, setMicMsg] = useState<string | null>(RecCtor ? null : '이 브라우저는 음성 인식을 지원하지 않아요. 글로 질문해 주세요.')
  // 답변은 기본으로 소리로 읽음 (현장에서 화면을 안 봐도 되게). 끄면 글로만
  const [voiceReply, setVoiceReply] = useState(true)
  const rec = useRef<Rec | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const request = useRef<AbortController | null>(null)

  // 사건이 바뀌면 그 사건의 대화를 불러온다
  useEffect(() => {
    let alive = true
    listAssistantMessages(c).then((t) => {
      if (!alive) return
      setTurns(t)
      setLoading(false)
    })
    return () => {
      alive = false
      request.current?.abort()
      rec.current?.stop()
      if (canSpeak) window.speechSynthesis.cancel()
    }
  }, [c.id, c.backend?.incidentId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [turns, pending])

  async function send(text: string, viaVoice = fromVoice) {
    const q = text.trim()
    if (!q || pending) return
    const via = viaVoice ? 'voice' : 'text'
    setInput('')
    setFromVoice(false)
    setMicMsg(null)
    setPending(true)
    setCancellable(true)
    setError(null)
    const controller = new AbortController()
    request.current = controller
    try {
      const next = await askAssistant(c, q, via, getActor(), turns, controller.signal)
      setTurns(next)
      const last = next[next.length - 1]
      if (via === 'voice' || voiceReply) speak(last.text)
    } catch (e) {
      setTurns(getCachedAssistantMessages(c))
      setError(controller.signal.aborted ? '요청을 취소했어요. 서버에서 이미 처리됐을 수 있으니 다시 동기화하면 같은 질문 ID로 확인해요.' : (e as Error).message)
      if (!controller.signal.aborted) setInput(q)
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
      setCancellable(false)
    }
  }

  // 음성 인식이 끝났을 때 최신 send를 부르기 위함 (마이크를 켠 시점의 오래된 대화를 쓰지 않게)
  const sendRef = useRef(send)
  sendRef.current = send

  function toggleMic() {
    if (!RecCtor) return
    if (listening) return rec.current?.stop()
    setMicMsg(null)
    const r = new RecCtor()
    r.lang = 'ko-KR'
    r.interimResults = true
    r.continuous = false
    let finalText = ''
    r.onresult = (e) => {
      let interim = ''
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const res = e.results[k]
        if (res.isFinal) finalText += res[0].transcript
        else interim += res[0].transcript
      }
      setInput((finalText + interim).trim())
    }
    r.onerror = (e) => setMicMsg(MIC_ERROR[e.error] ?? '음성을 알아듣지 못했어요. 글로 질문해 주세요.')
    r.onend = () => {
      setListening(false)
      // 말이 끝나면 인식한 문장을 바로 보냄
      if (finalText.trim()) void sendRef.current(finalText, true)
    }
    rec.current = r
    if (canSpeak) window.speechSynthesis.cancel()
    setListening(true)
    try {
      r.start()
    } catch {
      setListening(false)
      setMicMsg('마이크를 시작하지 못했어요. 글로 질문해 주세요.')
    }
  }

  async function reset() {
    if (pending) return
    setPending(true)
    setCancellable(false)
    setError(null)
    try { await resetAssistantConversation(c, getActor()); setTurns([]) }
    catch (e) { setError((e as Error).message) }
    finally { setPending(false) }
  }
  async function resync() {
    if (pending) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setCancellable(true)
    setError(null)
    try { setTurns(await retryAssistantMessages(c, controller.signal)) }
    catch (e) { setTurns(getCachedAssistantMessages(c)); setError((e as Error).message) }
    finally { if (request.current === controller) request.current = null; setPending(false); setCancellable(false) }
  }

  return (
    <div className={`chat chat-${variant}`}>
      <div className="chat-scope small muted">
        <span>사건 <b className="mono">{c.id}</b> · 교류 고장파형 분석 기록만 사용</span>
        {turns.length > 0 && <button type="button" className="chat-link" onClick={reset} disabled={pending}>현재 대화 보관 후 새로 시작</button>}
      </div>
      <div className="small muted">{capabilities.state === 'ok' ? !capabilities.data?.assistant.configured ? '서버 LLM 미설정 · 서버 규칙으로 답변' : capabilities.data.assistant.available === true ? `LLM 연결 확인 · ${capabilities.data.assistant.model}` : capabilities.data.assistant.available === false ? `LLM 응답 불가 · ${capabilities.data.assistant.model ?? '모델 미지정'}` : `LLM 준비 상태 미확인 · ${capabilities.data.assistant.model ?? '모델 미지정'}` : 'LLM 연결 상태 미확인'} · 각 답변에 실제 사용 방식을 표시해요.</div>
      {error && <div className="chat-notice err" role="alert">{error}</div>}
      {getAssistantConversationNotice(c) && <div className="chat-notice info" role="status">{getAssistantConversationNotice(c)}</div>}
      {c.backend?.incidentId && <button type="button" className="chat-link" onClick={resync} disabled={pending}>{turns.some((t) => t.sync === 'pending') ? '미전송 대화 다시 동기화' : '최신 대화 확인'}</button>}
      <div className="chat-log" aria-live="polite">
        {!loading && turns.length === 0 && (
          <div className="chat-msg bot">이 사건의 분석 결과를 근거와 함께 알려 드려요. 기록에 없는 원인이나 위치는 지어내지 않고 판단을 보류해요.</div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`chat-msg ${t.role === 'user' ? 'user' : 'bot'}`}>
            {t.role === 'user' && t.via === 'voice' && <span className="chat-via">음성</span>}
            {t.text}
            {t.sync === 'pending' && t.role === 'user' && <span className="chat-via">서버 전송 대기</span>}
            {t.meta && <BotMeta m={t.meta} text={t.text} />}
          </div>
        ))}
        {pending && <div className="chat-msg bot pending">기록을 조회하고 있어요… 질문 응답은 최대 {Math.ceil(assistantTimeoutMs() / 1000)}초 기다려요. {cancellable && <button type="button" className="chat-link" onClick={() => request.current?.abort()}>요청 취소</button>}</div>}
        <div ref={end} />
      </div>
      <div className="chat-dock">
      <div className="chat-chips">
        {FIELD_SUGGESTIONS.map((s) => <button key={s} type="button" className="chat-chip" onClick={() => send(s)} disabled={pending}>{s}</button>)}
      </div>
      {micMsg && <div className={`chat-micmsg ${fromVoice ? 'info' : ''}`} role="status">{micMsg}</div>}
      <form className="chat-input" onSubmit={(e) => (e.preventDefault(), send(input))}>
        {RecCtor && (
          <button type="button" className={`chat-mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? '음성 입력 멈추기' : '음성으로 질문하기'} title="음성으로 질문하기">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(input)
            }
          }}
          placeholder={listening ? '듣는 중… 말씀하세요' : '예: 어디를 먼저 점검해야 해?'}
          aria-label="질문"
        />
        <button type="submit" className="chat-send" aria-label="보내기" disabled={!input.trim() || pending}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M4 12 20 4l-6 16-3-7-7-1Z" /></svg>
        </button>
      </form>
      </div>
      {canSpeak && (
        <label className="chat-voice small muted">
          <input type="checkbox" checked={voiceReply} onChange={(e) => setVoiceReply(e.target.checked)} /> 답변을 소리로 읽기
          <span>(음성으로 물으면 항상 읽어요)</span>
        </label>
      )}
    </div>
  )
}
