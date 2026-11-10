import test from 'node:test'
import assert from 'node:assert/strict'
import { setApiBase } from '../src/lib/backend.ts'

const transport = (items = []) => async (_url, init) => {
  if (init?.method === 'PUT') {
    const body = JSON.parse(init.body)
    return new Response(JSON.stringify({ ...body, record_id: String(_url).split('/').at(-1), created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z' }))
  }
  return new Response(JSON.stringify({ items, page: 1, per_page: 100, total_count: items.length }))
}

test('offline raw records survive reload and retry with the same record UUID and all 260 samples', async () => {
  localStorage.clear()
  setApiBase('https://village-records.test')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const adapter = await import('../src/api/village.ts').catch(() => null)
  assert.equal(typeof adapter?.saveVillageRecord, 'function')
  const data = { e: { ev: 1, source: 'SERIAL', i100: Array.from({ length: 260 }, (_, i) => i + 500) }, verdict: { kind: 'WITHHELD', reasons: ['점수 부족'], evidence: [{ name: 'step_mA', contribution: .05 }] } }
  assert.equal(await adapter.saveVillageRecord('event-uuid-1', 'event', 'uno-real', data), null)
  const reloaded = await import('../src/api/village.ts?reload-offline')
  assert.deepEqual(reloaded.getCachedVillageRecords('event')[0].data, data)
  assert.equal(reloaded.getVillagePersistence().pending, 1)
  let saved
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PUT') saved = { id: String(url).split('/').at(-1), body: JSON.parse(init.body) }
    return transport()(url, init)
  }
  await reloaded.retryVillageRecords()
  assert.equal(saved.id, 'event-uuid-1')
  assert.equal(saved.body.data.e.i100.length, 260)
  assert.equal(reloaded.getVillagePersistence().pending, 0)
})

test('village records read all server pages and keep queued local updates over older server copies', async () => {
  localStorage.clear()
  setApiBase('https://village-pages.test')
  const adapter = await import('../src/api/village.ts')
  let pages = []
  globalThis.fetch = async (url) => {
    const page = new URL(String(url)).searchParams.get('page')
    pages.push(page)
    return new Response(JSON.stringify({ items: [{ record_id: `row-${page}`, kind: 'incident', device_id: 'uno-real', data: { stage: 'INSPECTING' }, created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z' }], page: Number(page), per_page: 1, total_count: 2 }))
  }
  assert.equal((await adapter.listVillageRecords('incident')).length, 2)
  assert.deepEqual(pages, ['1', '2'])
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await adapter.saveVillageRecord('row-1', 'incident', 'uno-real', { stage: 'CLOSED' })
  globalThis.fetch = transport([{ record_id: 'row-1', kind: 'incident', device_id: 'uno-real', data: { stage: 'RECEIVED' }, created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z' }])
  assert.equal((await adapter.listVillageRecords('incident')).find((x) => x.record_id === 'row-1').data.stage, 'CLOSED')
})

test('failed browser storage is reported if the server also cannot save', async () => {
  localStorage.clear()
  setApiBase('https://village-full-storage.test')
  const adapter = await import('../src/api/village.ts')
  const original = localStorage.setItem
  localStorage.setItem = () => { throw new DOMException('full', 'QuotaExceededError') }
  globalThis.fetch = async () => { throw new TypeError('offline') }
  try {
    await assert.rejects(adapter.saveVillageRecord('unsaved-record', 'event', 'uno-real', { i100: [123] }), /저장|보존|공간/)
    assert.match(adapter.getVillagePersistence().error, /저장|보존|공간/)
  } finally { localStorage.setItem = original }
})

test('restarting the Arduino event counter creates distinct durable recordings', async () => {
  localStorage.clear()
  setApiBase('https://uno-restarts.test')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const events = await import('../src/lib/villageEvents.ts')
  const sample = { ev: 1, dtMs: 10, pre: 60, src: 'cmd', cmd: 'CH 3 0', ch: [1, 1, 0, 1, 1], i100: Array(260).fill(1000), receivedAt: '2026-11-10T00:00:00Z' }
  events.pushVillageEvent(sample)
  events.pushVillageEvent({ ...sample, receivedAt: '2026-11-10T00:01:00Z' })
  const adapter = await import('../src/api/village.ts')
  const saved = adapter.getCachedVillageRecords('event')
  assert.equal(saved.length, 2)
  assert.notEqual(saved[0].record_id, saved[1].record_id)
  assert.equal(saved[0].data.e.source, 'SERIAL')
  assert.equal(saved[0].data.e.i100.length, 260)
  const reloaded = await import('../src/lib/villageEvents.ts?event-reload')
  assert.equal(reloaded.getVillageEvents().length, 2)
})

test('live incidents keep their event prefix and never infer restoration from NO_DATA or OFF', async () => {
  localStorage.clear()
  setApiBase('https://live-preservation.test')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const live = await import('../src/lib/liveIncident.ts')
  const { getVillage } = await import('../src/lib/village.ts')
  const adapter = await import('../src/api/village.ts')
  const start = Date.now()
  const snapshot = { ...getVillage(), source: 'SERIAL', connected: true, measurementScope: 'HOUSE', relay: true, status: 'FAULT', v: 5, i: .005, expected: .03, score: .9, zones: null, events: [] }
  for (let i = 0; i < 250; i++) live.observeVillage({ ...snapshot, packets: i, lastPacketAt: start + i, history: [{ t: start + i, v: 5, i: .005, expected: .03, score: .9, p: .025 }] })
  const record = adapter.getCachedVillageRecords('incident')[0]
  assert.equal(record.data.points.length, 250)
  assert.equal(record.data.points[0].t, start)
  live.observeVillage({ ...snapshot, packets: 251, status: 'NO_DATA', connected: false, lastPacketAt: start + 251 })
  assert.equal(live.getLiveIncident(record.record_id).clearedAt, null)
  live.observeVillage({ ...snapshot, packets: 252, status: 'OFF', relay: false, score: 0, lastPacketAt: start + 252 })
  assert.equal(live.getLiveIncident(record.record_id).clearedAt, null)
  live.setIncidentStage(record.record_id, 'INSPECTING', 'tester')
  const reloaded = await import('../src/lib/liveIncident.ts?live-reload')
  assert.equal(reloaded.getLiveIncident(record.record_id).stage, 'INSPECTING')
  assert.equal(reloaded.getLiveIncident(record.record_id).points[0].t, start)
})

test('duplicate legacy display numbers cannot change another observers incident', async () => {
  localStorage.clear()
  setApiBase('https://live-legacy-collision.test')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const adapter = await import('../src/api/village.ts')
  const fixture = { id: 1, source: 'SERIAL', observerId: 'another-observer', startedAt: Date.now(), clearedAt: null, scope: 'HOUSE', title: '원격 사건', reasons: [], fi: { inlet: 'LOW', house: 'LOW', lamp: 'NONE' }, cause: '전류 부족', points: [], ruleEventId: null, caseId: null, stage: 'RECEIVED', assignee: null, stageLog: [] }
  adapter.queueVillageRecord('incident-remote-one', 'incident', 'uno-remote', { ...fixture, recordId: 'incident-remote-one' })
  adapter.queueVillageRecord('incident-remote-two', 'incident', 'uno-remote', { ...fixture, recordId: 'incident-remote-two' })
  const live = await import('../src/lib/liveIncident.ts?legacy-collision')
  assert.equal(live.getLiveIncident(1), null)
  live.assignIncident(1, 'wrong-target')
  assert.equal(live.getLiveIncident('incident-remote-one').assignee, null)
  live.assignIncident('incident-remote-two', 'correct-target')
  assert.equal(live.getLiveIncident('incident-remote-one').assignee, null)
  assert.equal(live.getLiveIncident('incident-remote-two').assignee, 'correct-target')
})

test('two open tabs cannot overwrite each others unsubmitted recordings', async () => {
  localStorage.clear()
  setApiBase('https://village-two-tabs.test')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  const first = await import('../src/api/village.ts')
  const second = await import('../src/api/village.ts?second-tab')
  first.getCachedVillageRecords('event')
  second.getCachedVillageRecords('event')
  await first.saveVillageRecord('tab-one-event', 'event', 'uno-real', { sample: 1 })
  await second.saveVillageRecord('tab-two-event', 'event', 'uno-real', { sample: 2 })
  const reloaded = await import('../src/api/village.ts?two-tab-reload')
  assert.deepEqual(reloaded.getCachedVillageRecords('event').map((r) => r.record_id).sort(), ['tab-one-event', 'tab-two-event'])
  assert.equal(reloaded.getVillagePersistence().pending, 2)
})
