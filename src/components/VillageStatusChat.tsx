import { useEffect, useRef, useState } from 'react'
import { answer, SUGGESTIONS, type ChatMsg } from '../lib/assistant'
import { useVillageEvents } from '../lib/villageEvents'
import { useVillage } from '../lib/village'
import { askVillageAssistant } from '../api/villageAssistant'

// 브라우저 음성 인식 (Chrome·Edge·Safari). 없으면 마이크 버튼을 숨김
type Rec = { lang: string; interimResults: boolean; continuous: boolean; onresult: (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void; onend: () => void; onerror: (e: { error: string }) => void; start: () => void; stop: () => void }
const RecCtor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition
const MIC_ERROR: Record<string, string> = {
  'not-allowed': '마이크 권한이 없어요. 브라우저 주소창에서 마이크를 허용하거나 글로 질문해 주세요.',
  'service-not-allowed': '이 브라우저에서 음성 인식을 쓸 수 없어요. 글로 질문해 주세요.',
  'no-speech': '말소리를 듣지 못했어요. 다시 눌러 말하거나 글로 질문해 주세요.',
  'audio-capture': '마이크를 찾지 못했어요. 글로 질문해 주세요.',
  network: '음성 인식 서버에 연결하지 못했어요. 글로 질문해 주세요.',
}

function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'ko-KR'
  window.speechSynthesis.speak(u)
}

/** FRTU(마을 모형) 상태 조회 도우미: 글이나 음성으로 묻고 값을 듣는다. 장치는 조작하지 않음 */
export default function VillageStatusChat() {
  const events = useVillageEvents()
  const snapshot = useVillage()
  const [msgs, setMsgs] = useState<ChatMsg[]>([{ role: 'bot', text: "마을 FRTU 3대(인입·주택 분기·가로등 분기)의 상태와 고장 구간을 알려 드려요.\n예: '어느 분기가 문제야?', '왜 이상이야?'\nLED·전원 조작은 마을 화면 제어판에서 해 주세요." }])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [fromVoice, setFromVoice] = useState(false)
  const [micMsg, setMicMsg] = useState<string | null>(RecCtor ? null : '이 브라우저는 음성 인식을 지원하지 않아요. 글로 질문해 주세요.')
  // 답변은 기본으로 소리로 읽음 (현장에서 화면을 안 봐도 되게). 끄면 글로만
  const [voiceReply, setVoiceReply] = useState(true)
  const [pending, setPending] = useState(false)
  const rec = useRef<Rec | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => { rec.current?.stop(); if ('speechSynthesis' in window) window.speechSynthesis.cancel() }, [])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  async function send(text: string, viaVoice = fromVoice) {
    const q = text.trim()
    if (!q || pending) return
    setMsgs((m) => [...m, { role: 'user', text: q }])
    setInput('')
    setFromVoice(false)
    setMicMsg(null)
    setPending(true)
    try {
      const reply = await askVillageAssistant(q, snapshot, events)
      const badge = reply.mode === 'llm' ? `서버 LLM${reply.model ? ` · ${reply.model}` : ''}` : '서버 규칙 답변'
      const text = `${reply.text}\n[${badge}]`
      setMsgs((m) => [...m, { role: 'bot', text }])
      if (viaVoice || voiceReply) speak(reply.text)
    } catch (error) {
      const fallback = answer(q, events)
      const reason = (error as Error).message || '서버 LLM 연결 실패'
      const text = `${fallback}\n[브라우저 규칙 답변 · ${reason}]`
      setMsgs((m) => [...m, { role: 'bot', text }])
      setMicMsg(`서버 LLM을 사용하지 못해 브라우저 규칙 답변을 표시했어요. ${reason}`)
      if (viaVoice || voiceReply) speak(fallback)
    } finally { setPending(false) }
  }
  // 음성 인식이 끝났을 때 최신 send를 부르기 위함 (마이크를 켠 시점의 오래된 값을 쓰지 않게)
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
        if (e.results[k].isFinal) finalText += e.results[k][0].transcript
        else interim += e.results[k][0].transcript
      }
      setInput((finalText + interim).trim())
    }
    r.onend = () => {
      setListening(false)
      // 말이 끝나면 인식한 문장을 바로 보냄
      if (finalText.trim()) sendRef.current(finalText, true)
    }
    r.onerror = (e) => { setListening(false); setMicMsg(MIC_ERROR[e.error] ?? '음성을 알아듣지 못했어요. 글로 질문해 주세요.') }
    rec.current = r
    setListening(true)
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    try { r.start() }
    catch { setListening(false); setMicMsg('마이크를 시작하지 못했어요. 글로 질문해 주세요.') }
  }

  return (
    <div className="chat">
      <div className="chat-scope small muted">마을 직류 계측 · {snapshot.source === 'MOCK' ? '시뮬레이터' : '실측 Arduino'} · 서버 LLM 근거 확인</div>
      <div className="chat-log" aria-live="polite">
        {msgs.map((m, k) => <div key={k} className={`chat-msg ${m.role}`}>{m.text}</div>)}
        {pending && <div className="chat-msg bot" role="status">서버 LLM이 계측·사건 근거를 확인하고 있어요…</div>}
        {listening && <div className="chat-msg user listening">듣는 중…</div>}
        <div ref={end} />
      </div>
      <div className="chat-chips">
        {SUGGESTIONS.map((s) => <button key={s} className="chat-chip" disabled={pending} onClick={() => void send(s, false)}>{s}</button>)}
      </div>
      {micMsg && <div className={`chat-micmsg ${fromVoice ? 'info' : ''}`} role="status">{micMsg}</div>}
      <form className="chat-input" onSubmit={(e) => (e.preventDefault(), void send(input))}>
        {RecCtor && (
          <button type="button" className={`chat-mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? '음성 입력 멈추기' : '음성으로 말하기'} title="음성으로 말하기">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
        <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder={listening ? '듣는 중… 말씀하세요' : '예: 지금 상태 어때?'} aria-label="질문" />
        <button type="submit" className="chat-send" aria-label="보내기" disabled={!input.trim() || pending}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M4 12 20 4l-6 16-3-7-7-1Z" /></svg>
        </button>
      </form>
      <label className="chat-voice small muted">
        <input type="checkbox" checked={voiceReply} onChange={(e) => setVoiceReply(e.target.checked)} /> 답변을 소리로 읽기
      </label>
    </div>
  )
}
