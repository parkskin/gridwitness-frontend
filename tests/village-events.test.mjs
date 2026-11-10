import test from 'node:test'
import assert from 'node:assert/strict'
import { checkEvent, parseEventLine } from '../src/lib/villageEvents.ts'

const event = (overrides = {}) => ({
  ev: 1, dtMs: 10, pre: 60, src: 'auto', cmd: '', ch: [1, 1, 1, 1, 1],
  i100: Array(260).fill(3300), receivedAt: '2026-11-10T00:00:00Z', source: 'SERIAL',
  ...overrides,
})

test('keeps command and automatic waveform sources distinct when parsing UNO frames', () => {
  const cmd = parseEventLine('{"ev":2,"dt":10,"pre":60,"src":"cmd","cmd":"CH 3 0","ch":[1,1,0,1,1],"i":[3300]}')
  const automatic = parseEventLine('{"ev":3,"dt":10,"pre":60,"src":"auto","cmd":"","ch":[1,1,1,1,1],"i":[3300]}')
  assert.equal(cmd.src, 'cmd')
  assert.equal(cmd.cmd, 'CH 3 0')
  assert.equal(automatic.src, 'auto')
  assert.equal(automatic.cmd, '')
})

test('retains but does not analyze a startup capture with fewer than 60 real pre-samples', () => {
  const partial = event({ pre: 15, i100: Array(215).fill(3300) })
  assert.match(checkEvent(partial).join(' '), /15\/60개뿐.*원시 파형은 보존/)
})
