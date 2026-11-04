// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { boundedMs, createAttempt, createClockMonitor, createLifecycle, STAGES, withLifecycle, attachAttempt } from './diagnostics.mjs'
import { classifySourceFailure, sourceFailureLogLine, contractFailure } from './adapters/sourceFailure.mjs'

const id = 'corr-12345678-1234-1234-1234-123456789abc'
describe('bounded request and attempt diagnostics', () => {
  it('retains stage order, monotonic times and caps the trail at 16', () => {
    let time = 100
    const lifecycle = createLifecycle(id, { mono: () => time, trace: false })
    for (let i = 0; i < 30; i++) { time += 10; lifecycle.mark(STAGES[i % STAGES.length]) }
    lifecycle.mark('PRIVATE')
    expect(lifecycle.stages).toHaveLength(16)
    expect(lifecycle.stages[0]).toEqual({ stage: 'REQUEST_RECEIVED', atMs: 0 })
    expect(lifecycle.stages[15].atMs).toBe(150)
    expect(lifecycle.stages.every((entry: { stage: string }) => STAGES.includes(entry.stage))).toBe(true)
  })
  it('defaults tracing off and emits only the closed trace shape when opted in', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = process.env.OK_CONSOLE_TRACE
    try {
      delete process.env.OK_CONSOLE_TRACE
      createLifecycle(id).mark('AUTHZ_CHECKED')
      expect(log).not.toHaveBeenCalled()
      process.env.OK_CONSOLE_TRACE = 'stages'
      const lifecycle = createLifecycle(id)
      lifecycle.mark('PRIVATE')
      lifecycle.mark('AUTHZ_CHECKED')
      expect(log).toHaveBeenCalledTimes(2)
      for (const [line] of log.mock.calls) {
        const event = JSON.parse(line)
        expect(Object.keys(event)).toEqual(['stage', 'atMs', 'correlationId'])
        expect(STAGES).toContain(event.stage)
        expect(event.correlationId).toBe(id)
        expect(Number.isInteger(event.atMs)).toBe(true)
        expect(event.atMs).toBeGreaterThanOrEqual(0)
        expect(event.atMs).toBeLessThanOrEqual(600000)
      }
    } finally { log.mockRestore(); if (prior === undefined) delete process.env.OK_CONSOLE_TRACE; else process.env.OK_CONSOLE_TRACE = prior }
  })
  it('records a signed clock step inside an attempt window, excludes old steps and includes overlapping observations', () => {
    let wall = 1000000, mono = 0
    const clock = createClockMonitor({ wall: () => wall, mono: () => mono })
    const old = clock.start(); wall += 90000; old.finish()
    const first = clock.start()
    const second = clock.start()
    mono += 20; wall -= 10000
    expect(first.finish()).toBe(-10020)
    mono += 20; wall += 20
    expect(second.finish()).toBe(-10020)
    expect(clock.start().finish()).toBe(0)
  })
  it('clamps elapsed, phase, stage and signed clock evidence and preserves the earliest failure snapshot', () => {
    let mono = 0, wall = 0
    const clock = createClockMonitor({ wall: () => wall, mono: () => mono })
    const lifecycle = createLifecycle(id, { mono: () => mono, trace: false })
    const attempt = createAttempt({ mono: () => mono, clock, lifecycle })
    mono = 900000; wall = -900000000
    attempt.complete('dns', 'DNS_RESOLVED', 'CONNECT')
    const result = attempt.finish()
    expect(result).toEqual({ failedStage: 'CONNECT', elapsedMs: 600000, phaseMs: { dns: 600000 }, wallClockStepMs: -86400000, clockOffsetMs: -86400000, clockStepSinceLastObservationMs: 0, lastObservationAgeMs: null })
    expect(lifecycle.stages.at(-1).atMs).toBe(600000)
    mono = 0
    expect(attempt.finish()).toBe(result)
    wall = 0
    const positive = clock.start(); wall += 900000000
    expect(positive.finish()).toBe(86400000)
  })
  it('reenacts a backward step with CERT_NOT_YET_VALID in one private, bounded line', () => {
    let wall = 500000, mono = 0
    const clock = createClockMonitor({ wall: () => wall, mono: () => mono })
    const lifecycle = createLifecycle(id, { mono: () => mono, trace: false })
    withLifecycle(lifecycle, () => {
      const attempt = createAttempt({ mono: () => mono, clock })
      attempt.complete('dns', 'DNS_RESOLVED', 'CONNECT')
      attempt.complete('connect', 'TCP_CONNECTED', 'TLS_HANDSHAKE')
      mono = 100; wall -= 60000
      const error = attachAttempt(Object.assign(new Error('private.example:443 192.0.2.1 CN=private'), { code: 'CERT_NOT_YET_VALID' }), attempt)
      const line = sourceFailureLogLine('/api/console/v0/evidence/private', classifySourceFailure(error), id, error)
      const event = JSON.parse(line)
      expect(event).toMatchObject({ failedStage: 'TLS_HANDSHAKE', nodeCode: 'CERT_NOT_YET_VALID', wallClockStepMs: -60100, elapsedMs: 100, route: 'EVIDENCE_DETAIL' })
      expect(event).not.toHaveProperty('certValiditySkewS')
      expect(line).not.toContain('private')
      console.info('D4_R5_CLOCK_REENACTMENT ' + line)
    })
  })
})

it('chooses the largest raw clock divergence before clamping its signed output', () => {
  let wall = 0
  const clock = createClockMonitor({ wall: () => wall, mono: () => 0 })
  const outer = clock.start()
  wall = 100000000
  const inner = clock.start()
  wall = -200000000
  expect(inner.finish()).toBe(-86400000)
  expect(outer.finish()).toBe(-86400000)
})

it('enforces closed failed-stage and timing-key vocabularies', () => {
  for (const invalid of [undefined, null, 42, {}, [], 'private.example', 'CONNECT\\n', 'connect']) {
    const attempt = createAttempt()
    attempt.phase(invalid)
    attempt.complete(undefined, invalid, invalid)
    expect(attempt.finish()).toMatchObject({ failedStage: 'OTHER', phaseMs: {} })
    expect(attempt.finish().phaseMs).toEqual({})
    const direct = createAttempt()
    direct.phase(invalid)
    expect(direct.finish().failedStage).toBe('OTHER')
    const lifecycle = createLifecycle('OTHER', { trace: false })
    lifecycle.mark(invalid)
    expect(lifecycle.stages).toHaveLength(1)
  }
  for (const invalidKey of [undefined, null, 42, {}, [], 'private.example', 'CONNECT', 'dns\\n']) {
    const attempt = createAttempt()
    attempt.complete(invalidKey, 'TCP_CONNECTED', 'TLS_HANDSHAKE')
    expect(attempt.finish().phaseMs).toEqual({})
  }
})

it('bounds non-finite and negative monotonic diagnostic values', () => {
  for (const value of [NaN, Infinity, -Infinity, -1000]) expect(boundedMs(value)).toBe(0)
  expect(boundedMs(900000)).toBe(600000)
  expect(boundedMs(1.7)).toBe(2)
})

it('retains bounded preceding observation evidence with a two millisecond deadband', () => {
  let mono = 0, offset = 0
  const clock = createClockMonitor({ wall: () => mono + offset, mono: () => mono })
  const first = createAttempt({ clock, mono: () => mono })
  expect(first.finish()).toMatchObject({ clockStepSinceLastObservationMs: 0, lastObservationAgeMs: null })
  for (const step of [-2, -1, 0, 1, 2, -3, 3, -900000000, 900000000]) {
    mono += 900000000; offset += step
    const attempt = createAttempt({ clock, mono: () => mono })
    offset += step
    const expected = Math.abs(step) <= 2 ? 0 : Math.max(-86400000, Math.min(86400000, step))
    expect(attempt.finish()).toMatchObject({ clockStepSinceLastObservationMs: expected, wallClockStepMs: expected, lastObservationAgeMs: 86400000 })
  }
  mono -= 100
  expect(clock.start().lastObservationAgeMs).toBe(0)
})
it('releases every monitor window after successful and failed attempts', () => {
  const clock = createClockMonitor()
  for (let i = 0; i < 20; i++) {
    const attempt = createAttempt({ clock })
    expect(clock.activeWindowCount).toBe(1)
    if (i % 2) attachAttempt(new Error(), attempt)
    else attempt.finish()
    expect(clock.activeWindowCount).toBe(0)
  }
})
it('uses null for unmeasured source failures regardless of classification', () => {
  expect(JSON.parse(sourceFailureLogLine('/', contractFailure(), id, new Error()))).toMatchObject({ failedStage: 'OTHER', elapsedMs: null, wallClockStepMs: null, clockStepSinceLastObservationMs: null })
  for (const error of [new Error(), Object.assign(new Error(), { code: 'CERT_NOT_YET_VALID' })]) {
    expect(JSON.parse(sourceFailureLogLine('/', classifySourceFailure(error), id, error))).toMatchObject({ failedStage: 'OTHER', elapsedMs: null, wallClockStepMs: null, clockStepSinceLastObservationMs: null, lastObservationAgeMs: null })
  }
})

// G1: healthy A absorbs the event. G2: C observes first; B and later failures still retain the offset.
it.each(['G1', 'G2'])('persists clockOffsetMs through %s and every later failure line', (geometry) => {
  let mono = 1000, offset = 0
  const clock = createClockMonitor({ wall: () => mono + offset, mono: () => mono })
  expect(clock.clockOffsetMs).toBe(null)
  const begin = () => createAttempt({ clock, mono: () => mono })
  const a = begin()
  mono += 10
  if (geometry === 'G2') a.finish()
  offset -= 645; mono += 10
  const c = geometry === 'G2' ? begin() : undefined
  if (geometry === 'G1') a.finish()
  mono += 40
  for (let i = 0; i < 3; i++) {
    const b = begin(); mono += 14
    if (i === 0 && c) {
      const firstError = attachAttempt(Object.assign(new Error(), { code: 'CERT_NOT_YET_VALID' }), c)
      const first = JSON.parse(sourceFailureLogLine('/', classifySourceFailure(firstError), id, firstError))
      expect(first.clockOffsetMs).toBe(-645)
      expect(first.clockStepSinceLastObservationMs).toBe(-645)
      console.info('D4_R7_G2_FIRST ' + JSON.stringify(first))
    }
    const error = attachAttempt(Object.assign(new Error(), { code: 'CERT_NOT_YET_VALID' }), b)
    const event = JSON.parse(sourceFailureLogLine('/', classifySourceFailure(error), id, error))
    expect(event.clockOffsetMs).toBe(-645)
    expect(event.wallClockStepMs).toBe(0)
    expect(event.clockStepSinceLastObservationMs).toBe(0)
    console.info('D4_R7_' + geometry + ' ' + JSON.stringify(event))
  }
  c?.finish()
})
it('bounds offset and non-finite observation age and cancels opposite-sign preemption pairs', () => {
  let wall = 0, mono = 0
  const clock = createClockMonitor({ wall: () => wall, mono: () => mono })
  clock.start().finish()
  for (const invalid of [NaN, Infinity, -Infinity]) {
    mono = invalid
    expect(clock.start().lastObservationAgeMs).toBe(0)
    mono = 0; clock.start().finish()
  }
  wall = -900000000
  clock.start().finish()
  expect(clock.clockOffsetMs).toBe(-86400000)
  wall = 0; clock.start().finish()
  expect(clock.clockOffsetMs).toBe(0)
  wall = 900000000; clock.start().finish()
  expect(clock.clockOffsetMs).toBe(86400000)
  wall = 0; clock.start().finish()
  wall = 10; clock.start().finish()
  wall = 0; clock.start().finish()
  expect(clock.clockOffsetMs).toBe(0)
})


it('telescopes the -2.6/+2.2 preemption geometry instead of per-interval deadband', () => {
  let noiseWall = 0
  const noise = createClockMonitor({ wall: () => noiseWall, mono: () => 0 })
  noise.start().finish(); noiseWall = 1.4; noise.start().finish()
  expect(noise.clockOffsetMs).toBe(0)
  let time = 0, preempt = 0
  const clock = createClockMonitor({ wall: () => { const point = Math.floor(time); time += preempt; preempt = 0; return point }, mono: () => time })
  clock.start().finish()
  time += 10; preempt = 2.6
  clock.start().finish()
  time += 9.8
  clock.start().finish()
  time += 1000
  clock.start().finish()
  expect(clock.clockOffsetMs).toBe(0)
})
it('fallback without attempt details retains numeric process offset after observation', async () => {
  const { processClock } = await import('./diagnostics.mjs')
  processClock.start().finish()
  const wall = Date.now
  const shifted = vi.spyOn(Date, 'now').mockImplementation(() => wall() - 30000)
  try {
  processClock.start().finish()
  expect(processClock.clockOffsetMs).toBeLessThan(-29000)
  const error = new Error('no attempt details')
  const line = JSON.parse(sourceFailureLogLine('/', classifySourceFailure(error), id, error))
  expect(line).toMatchObject({ failedStage: 'OTHER', elapsedMs: null, clockOffsetMs: expect.any(Number) })
  expect(line.clockOffsetMs).toBe(processClock.clockOffsetMs)
  } finally { shifted.mockRestore(); processClock.start().finish() }
})

it('running total preserves fractional divergence and separates startup skew slew and suspend', () => {
  let wall = -645, mono = 0
  const clock = createClockMonitor({ wall: () => wall, mono: () => mono })
  clock.start().finish()
  expect(clock.clockOffsetMs).toBe(0) // startup skew is already in the baseline
  for (let i = 0; i < 10; i++) { wall += 10.4; mono += 10; clock.start().finish() }
  expect(clock.clockOffsetMs).toBe(4)
  wall += 1000; mono += 1000; clock.start().finish() // slewing advances both together
  expect(clock.clockOffsetMs).toBe(4)
  wall += 30000; clock.start().finish() // suspend with monotonic paused
  expect(clock.clockOffsetMs).toBe(30004)
  wall += 10; mono += 10; clock.start().finish()
  expect(clock.clockOffsetMs).toBe(30004)
})

it.each([0, 4])('H6 preemption at observation %s exposes first baseline and start half', preemptAt => {
  let time = 1000, count = 0
  const clock = createClockMonitor({ wall: () => { const wall = time; if (count++ === preemptAt) time += 40; return wall }, mono: () => time })
  const offsets = []
  for (let index = 0; index < 4; index++) {
    const window = clock.start()
    offsets.push(clock.clockOffsetMs)
    time += 100; window.finish(); time += 1000
  }
  expect(offsets).toEqual(preemptAt === 0 ? [0, 40, 40, 40] : [0, 0, -40, 0])
})
