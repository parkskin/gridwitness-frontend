import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as backend from '../src/lib/backend.ts'
import { getKepcoUsagePage } from '../src/api/kepcoUsage.ts'
import { openSerial, parseFrame } from '../src/lib/serial.ts'

test('serial non-finite sensor data is rejected instead of converted to a real zero', () => {
  assert.equal(parseFrame('{"v":nan,"i":0.03,"relay":1}'), null)
  assert.equal(parseFrame('{"v":5,"i":inf,"relay":1}'), null)
  assert.equal(parseFrame('{"v":null,"i":0.03,"relay":1}'), null)
  assert.equal(parseFrame('{"v":5,"i":0.03,"relay":2}'), null)
})

test('serial partial or invalid branch measurements cannot become measured zeroes', () => {
  assert.equal(parseFrame('{"v":5,"i":0.03,"relay":1,"vh":5,"ih":0.02}'), null)
  assert.equal(parseFrame('{"v":5,"i":0.03,"relay":1,"ch":[1,1,1,1,2]}'), null)
  assert.deepEqual(parseFrame('{"v":3.683,"i":0.0331,"relay":1,"ch":[1,1,1,1,1]}'), {
    v: 3.683, i: 0.0331, relay: true, ch: [true,true,true,true,true],
  })
})

test('API request shows structured server failure and attaches only configured credentials', async () => {
  assert.equal(typeof backend.apiRequest, 'function')
  backend.setApiToken('test-token')
  let auth
  globalThis.fetch = async (_url, init) => {
    auth = new Headers(init.headers).get('authorization')
    return new Response(JSON.stringify({code:'INVALID_METADATA',message:'샘플링 주파수를 확인하세요',details:{field:'sampling_rate_hz'}}), {status:422})
  }
  await assert.rejects(backend.apiRequest('/api/v1/incidents'), /샘플링 주파수를 확인하세요/)
  assert.equal(auth, 'Bearer test-token')
  backend.setApiToken('')
})

test('API request timeout aborts a transport and reports a finite wait', async () => {
  assert.equal(typeof backend.apiRequest, 'function')
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('Aborted','AbortError')), {once:true})
  })
  await assert.rejects(backend.apiRequest('/api/v1/capabilities', {}, 10), /시간|응답|초/)
})

test('LLM availability is described as an endpoint probe, not proof of a usable answer', () => {
  assert.equal(backend.assistantStatusLabel({ configured: false, model: null }), 'LLM 미설정 · 서버 규칙으로 답변')
  assert.equal(backend.assistantStatusLabel({ configured: true, model: 'qwen2.5:3b', available: false }), '설정 모델을 서버에서 확인하지 못함 · 서버 규칙으로 대체')
  assert.equal(backend.assistantStatusLabel({ configured: true, model: 'qwen2.5:3b', available: true }), '설정 모델 목록 확인됨 · 실제 답변 채택 여부는 대화 결과에서 확인')
  assert.equal(backend.assistantStatusLabel({ configured: true, model: 'qwen2.5:3b', available: null }), 'LLM 설정됨 · 모델 목록 확인 중')
})

test('KEPCO usage requests use the shared API base and include the configured access token', async () => {
  backend.setApiToken('kepco-token')
  let request
  globalThis.fetch = async (url, init) => {
    request = { url, authorization: new Headers(init.headers).get('authorization') }
    return Response.json({ total_count: 1, records: [] })
  }
  assert.deepEqual(await getKepcoUsagePage(2), { total_count: 1, records: [] })
  assert.match(request.url, /api\/v1\/energy\/kepco\/usage\?page=2&per_page=1000$/)
  assert.equal(request.authorization, 'Bearer kepco-token')
  backend.setApiToken('')
})

test('closing a serial connection releases both native stream locks before closing the port', async () => {
  let nativeClosed = false
  let received
  const receivedLine = new Promise((resolve) => { received = resolve })
  const port = {
    readable: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"v":3.68,"i":0.033,"relay":1}\n')) } }),
    writable: new WritableStream(),
    async open() {},
    async close() {
      assert.equal(this.readable.locked, false)
      assert.equal(this.writable.locked, false)
      nativeClosed = true
    },
  }
  navigator.serial = { requestPort: async () => port }
  const link = await openSerial(received, () => {})
  assert.match(await receivedLine, /3.68/)
  await link.close()
  assert.equal(nativeClosed, true)
  assert.equal(port.readable.locked, false)
  delete navigator.serial
})
