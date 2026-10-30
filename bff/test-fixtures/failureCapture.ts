import { afterEach, beforeEach, vi } from 'vitest'
import { OpenKubesObservedStateAdapter, ObservedStateContractError } from '../adapters/openKubesObservedState.mjs'
import { classifySourceFailure, contractFailure, sourceFailureLogLine } from '../adapters/sourceFailure.mjs'
import { performance } from 'node:perf_hooks'

const original = OpenKubesObservedStateAdapter.prototype.readSnapshot
let lines: string[] = []
let window: { wall: number, mono: number }
let spy: ReturnType<typeof vi.spyOn>
export const captureFailureLine = (line: string) => { lines.push(line) }
export const captureFailure = (error: unknown) => {
  captureFailureLine(sourceFailureLogLine('/', error instanceof ObservedStateContractError ? contractFailure() : classifySourceFailure(error), undefined, error))
}
export const captureChildFailureLines = (output: string) => {
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (typeof event.nodeCode === 'string' && typeof event.failedStage === 'string' && Array.isArray(event.stages)) captureFailureLine(line)
    } catch { /* Child stdout/stderr also contains non-JSON runner output. */ }
  }
}

// No polling: two wall/monotonic observations and a prototype wrapper per test.
beforeEach(() => {
  lines = []
  window = { wall: Date.now(), mono: performance.now() }
  spy = vi.spyOn(OpenKubesObservedStateAdapter.prototype, 'readSnapshot').mockImplementation(async function (this: OpenKubesObservedStateAdapter) {
    try { return await original.call(this) } catch (error) {
      captureFailure(error)
      throw error
    }
  })
})
afterEach((context) => {
  const wallClockStepMs = Math.max(-86400000, Math.min(86400000, Math.round((Date.now() - window.wall) - (performance.now() - window.mono))))
  spy.mockRestore()
  if (context.task.result?.state === 'fail') {
    console.error(JSON.stringify({ testClock: 'WALL_VS_MONOTONIC', wallClockStepMs }))
    for (const line of lines) console.error(line)
  }
})
