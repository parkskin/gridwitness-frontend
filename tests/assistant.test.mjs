import test from 'node:test'
import assert from 'node:assert/strict'
import * as assistant from '../src/api/assistant.ts'
import { groundedAnswer } from '../src/lib/groundedAnswer.ts'
import { answer } from '../src/lib/assistant.ts'
import * as notes from '../src/api/fieldNotes.ts'

const c = { id: 'case-chat', title: '시험', backend: { incidentId: 'incident-chat' }, diagnosis: { status: 'ACCEPTED', issues: [] }, source: { sourceType: 'UPLOAD', samplingRateHz: 1000, systemFrequencyHz: 50, channelOrder: ['Ia', 'Ib', 'Ic', 'Ua', 'Ub', 'Uc', 'U0'] }, reviews: [] }
const ctx = { analysis: { status: 'COMPLETED', label: 'PF', score: .92, ranking: [], reasons: [], neededInfo: [], topFeatures: [] }, diagnosis: { status: 'ACCEPTED', issues: [] }, model: { version: 'cn-v1', dataset: 'Xiong', country: 'CN', limitations: [] }, reviews: [], evidence: [] }
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

test('preserves actual LLM model and fallback metadata from the assistant response', async () => {
  localStorage.clear()
  globalThis.fetch = async () => json({ message_id: 'answer-1', answer: '기록에 근거한 답', status: 'answered', answer_mode: 'llm', llm_model: 'qwen-real', fallback_reason: null, model_version: 'classifier-v3', created_at: '2026-11-10T00:00:01Z' })
  const turns = await assistant.askAssistant(c, '고장 유형', 'text', 'tester', [])
  assert.equal(turns.at(-1).meta.answerMode, 'llm')
  assert.equal(turns.at(-1).meta.llmModel, 'qwen-real')
  globalThis.fetch = async () => json({ message_id: 'answer-2', answer: '규칙 답', answer_mode: 'rules', fallback_reason: 'llm_unavailable', created_at: '2026-11-10T00:00:02Z' })
  const rules = await assistant.askAssistant(c, '근거', 'text', 'tester', turns)
  assert.equal(rules.at(-1).meta.fallbackReason, 'llm_unavailable')
  assert.equal(rules.at(-1).meta.answerMode, 'rules')
})

test('keeps offline turns when a server history succeeds and resyncs one idempotent pair', async () => {
  localStorage.clear()
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const offline = await assistant.askAssistant(c, '분석 결과', 'text', 'tester', [])
  const clientId = offline[0].clientTurnId
  globalThis.fetch = async () => json({ items: [{ message_id: 'old', role: 'assistant', text: '기존 서버 답', created_at: '2026-11-09T00:00:00Z' }] })
  const merged = await assistant.listAssistantMessages(c)
  assert.equal(merged.length, 3)
  assert.ok(clientId)
  let requestId
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      requestId = JSON.parse(init.body).client_turn_id
      return json({ message_id: 'resynced-answer', answer: '서버에 복원됨', client_turn_id: requestId, answer_mode: 'rules', created_at: new Date().toISOString() })
    }
    return json({ items: requestId ? [{ message_id: 'resynced-user', role: 'user', text: '분석 결과', client_turn_id: clientId, created_at: offline[0].at }, { message_id: 'resynced-answer', role: 'assistant', text: '서버에 복원됨', client_turn_id: clientId, answer_mode: 'rules', created_at: offline[1].at }] : [] })
  }
  const synced = await assistant.retryAssistantMessages(c)
  assert.equal(requestId, clientId)
  assert.equal(synced.filter((x) => x.clientTurnId === clientId).length, 2)
  assert.equal(synced.filter((x) => x.role === 'user').length, 1)
  assert.equal(synced.find((x) => x.role === 'assistant' && x.clientTurnId === clientId).text, '서버에 복원됨')
})

test('reset archives the current conversation on server and survives reload', async () => {
  localStorage.clear()
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assistant.askAssistant(c, '분석 결과', 'text', 'tester', [])
  let resetPath = ''
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { resetPath = String(url); return json({ conversation_id: 'new', archived_count: 2 }) }
    return json({ items: [] })
  }
  assert.equal(typeof assistant.resetAssistantConversation, 'function')
  await assistant.resetAssistantConversation(c, 'tester')
  assert.match(resetPath, /\/assistant\/reset$/)
  assert.deepEqual(await assistant.listAssistantMessages(c), [])
})

test('browser fallback abstains on future predictions and recognizes training-data queries before location', () => {
  assert.equal(groundedAnswer('내일 고장 날까?', ctx).status, 'abstained')
  assert.match(groundedAnswer('학습 데이터 어디 거야?', ctx).text, /Xiong/)
})

test('grounded browser fallback never turns a model score into a probability', () => {
  const fallback = groundedAnswer('분석 결과 알려줘', ctx)
  assert.match(fallback.text, /점수는 0\.92.*정답 확률이 아니에요/)
  assert.doesNotMatch(fallback.text, /92%/)
})

test('all current village measurements abstain when no data is available', () => {
  for (const question of ['전압 알려줘', '왜 이상이야?', '전류는?', '지금 정상이지?']) {
    const text = answer(question, [])
    assert.match(text, /계측값|데이터|연결/)
    assert.doesNotMatch(text, /0\.00 V|이상 근거가 없|정상.*상태/)
  }
})

test('offline field notes remain pending and an idempotent retry produces one stored note', async () => {
  localStorage.clear()
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const pending = await notes.saveFieldNote(c, '현장 확인 완료', 'tester')
  assert.equal(pending.stored, 'pending')
  assert.ok(pending.clientNoteId)
  const serverNote = { note_id: 'note-server', client_note_id: pending.clientNoteId, text: pending.text, actor: 'tester', created_at: pending.at }
  let sent = false
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { assert.equal(JSON.parse(init.body).client_note_id, pending.clientNoteId); sent = true; return json(serverNote) }
    return json({ items: sent ? [serverNote] : [] })
  }
  const resynced = await notes.retryFieldNotes(c)
  assert.equal(resynced.length, 1)
  assert.equal(resynced[0].stored, 'server')
  assert.equal((await notes.listFieldNotes(c)).length, 1)
})

test('a reset from another browser archives cached pending turns instead of replaying them into the new conversation', async () => {
  localStorage.clear()
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const pending = await assistant.askAssistant(c, '분석 결과', 'text', 'tester', [])
  let posted = 0
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posted++; return json({ message_id: 'wrong-replay', conversation_id: 'new-remote-conversation', answer: '이전 대화가 잘못 재전송됨', created_at: new Date().toISOString() }) }
    return json({ conversation_id: 'new-remote-conversation', items: [] })
  }
  assert.deepEqual(await assistant.retryAssistantMessages(c), [])
  assert.equal(posted, 0)
  assert.ok(assistant.exportLocalAssistantRecords(c.id).some((r) => r.turns.some((t) => t.id === pending[0].id)))
})
