import test from "node:test"
import assert from "node:assert/strict"

import { createResourceTracker } from "./page-resources.js"

// The tracker runs in-page, so we simulate the browser globals it needs.
function withFakeBrowser<T>(fn: () => T): T {
  const g = globalThis as unknown as { AbortController: typeof AbortController }
  if (!g.AbortController) g.AbortController = class { signal = {}; abort() {} } as never
  return fn()
}

test("disposeCollector runs observer.disconnect before other cleanups", () => {
  withFakeBrowser(() => {
    const tracker = createResourceTracker() as unknown as {
      addObserver: (id: string, o: unknown, t: unknown, c: unknown) => void
      addCleanup: (id: string, fn: () => void) => void
      disposeCollector: (id: string) => void
    }
    const order: string[] = []

    const fakeObserver = {
      observe: () => order.push("observe-called"),
      disconnect: () => order.push("observer-disconnect"),
    }
    tracker.addObserver("x", fakeObserver, {}, {})
    // Register a cleanup that would, in the bug scenario, run before observer.disconnect
    // and mutate the DOM, which a still-live observer would pick up.
    tracker.addCleanup("x", () => order.push("cleanup-dom-mutation"))

    tracker.disposeCollector("x")

    // Invariant: observer disconnect must come before any cleanup that could
    // trigger observable DOM mutations.
    const disconnectIdx = order.indexOf("observer-disconnect")
    const cleanupIdx = order.indexOf("cleanup-dom-mutation")
    assert.notEqual(disconnectIdx, -1, "observer.disconnect must run")
    assert.notEqual(cleanupIdx, -1, "cleanup must run")
    assert.ok(disconnectIdx < cleanupIdx, "observer.disconnect must run before cleanups")
  })
})

test("disposeAll tears down observers and cleanups from every bucket", () => {
  withFakeBrowser(() => {
    const tracker = createResourceTracker() as unknown as {
      addObserver: (id: string, o: unknown, t: unknown, c: unknown) => void
      addCleanup: (id: string, fn: () => void) => void
      disposeAll: () => void
      activeCollectors: () => string[]
    }
    let disconnects = 0
    let cleanups = 0

    tracker.addObserver("x", { observe: () => {}, disconnect: () => disconnects++ }, {}, {})
    tracker.addObserver("web_clip", { observe: () => {}, disconnect: () => disconnects++ }, {}, {})
    tracker.addCleanup("x", () => cleanups++)
    tracker.addCleanup("web_clip:clip_mode", () => cleanups++)

    assert.equal(tracker.activeCollectors().sort().join(","), "web_clip,web_clip:clip_mode,x")

    tracker.disposeAll()

    assert.equal(disconnects, 2, "both observers disconnected")
    assert.equal(cleanups, 2, "both cleanups ran")
    assert.equal(tracker.activeCollectors().length, 0, "no buckets remain after disposeAll")
  })
})

test("disposeCollector is safe when called on a non-existent id", () => {
  withFakeBrowser(() => {
    const tracker = createResourceTracker() as unknown as {
      disposeCollector: (id: string) => void
    }
    // Should not throw
    tracker.disposeCollector("does-not-exist")
  })
})

test("cleanup errors do not interrupt the disposal sequence", () => {
  withFakeBrowser(() => {
    const tracker = createResourceTracker() as unknown as {
      addCleanup: (id: string, fn: () => void) => void
      disposeCollector: (id: string) => void
    }
    const ran: string[] = []
    tracker.addCleanup("x", () => ran.push("first"))
    tracker.addCleanup("x", () => { throw new Error("boom") })
    tracker.addCleanup("x", () => ran.push("third"))

    tracker.disposeCollector("x")

    // LIFO order: third runs, throwing cleanup is swallowed, then first runs
    assert.deepEqual(ran, ["third", "first"])
  })
})

test("addObserver and addCleanup can share the same collector id with disposeCollector idempotent", () => {
  withFakeBrowser(() => {
    const tracker = createResourceTracker() as unknown as {
      addObserver: (id: string, o: unknown, t: unknown, c: unknown) => void
      addCleanup: (id: string, fn: () => void) => void
      disposeCollector: (id: string) => void
      activeCollectors: () => string[]
    }
    tracker.addObserver("x", { observe: () => {}, disconnect: () => {} }, {}, {})
    tracker.addCleanup("x", () => {})

    tracker.disposeCollector("x")
    assert.deepEqual(tracker.activeCollectors(), [])

    // Second dispose is a no-op
    tracker.disposeCollector("x")
    assert.deepEqual(tracker.activeCollectors(), [])
  })
})
