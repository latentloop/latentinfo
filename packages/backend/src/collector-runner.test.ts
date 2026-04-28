import test from "node:test"
import assert from "node:assert/strict"

import { __test__ } from "./collector-runner.js"

test("decideTargetInfoChange queues a new http URL while the target is already processing", () => {
  const actual = __test__.decideTargetInfoChange(
    true,
    "about:blank",
    "https://arxiv.org/abs/2604.07725",
    true,
  )

  assert.equal(actual, "queue-check")
})

test("decideTargetInfoChange attaches a brand-new http target when idle", () => {
  const actual = __test__.decideTargetInfoChange(
    false,
    null,
    "https://arxiv.org/abs/2604.07725",
    false,
  )

  assert.equal(actual, "attach-now")
})

test("decideTargetInfoChange clears known targets that leave http", () => {
  const actual = __test__.decideTargetInfoChange(
    true,
    "https://x.com/home",
    "chrome://newtab/",
    false,
  )

  assert.equal(actual, "clear")
})

test("decideTargetInfoChange rechecks incomplete known targets", () => {
  assert.equal(__test__.decideTargetInfoChange(
    true,
    "https://x.com/home",
    "https://x.com/openai",
    false,
    false,
  ), "check-now")

  assert.equal(__test__.decideTargetInfoChange(
    true,
    "https://x.com/home",
    "https://x.com/openai",
    true,
    false,
  ), "queue-check")
})

test("decideTargetInfoChange keeps fully injected handlers across SPA route updates", () => {
  const actual = __test__.decideTargetInfoChange(
    true,
    "https://x.com/home",
    "https://x.com/openai",
    false,
    true,
  )

  assert.equal(actual, "update-url")
})

test("decideTargetInfoChange keeps fully injected handlers across hash-only URL updates", () => {
  const actual = __test__.decideTargetInfoChange(
    true,
    "https://x.com/openai/status/123",
    "https://x.com/openai/status/123#ref",
    false,
    true,
  )

  assert.equal(actual, "update-url")
})

test("getUrlChangePageHandlerCollectors only selects injected opt-in collectors", () => {
  const collectors = [
    {
      id: "x",
      description: "Save tweets",
      urlPatterns: ["https://x.com/*"],
      pageHandler: () => {},
    },
    {
      id: "web_clip",
      description: "Clip web content",
      urlPatterns: ["https://x.com/*"],
      pageHandler: () => {},
      rerunPageHandlerOnUrlChange: true,
    },
    {
      id: "github",
      description: "Save GitHub repositories",
      urlPatterns: ["https://github.com/*/*"],
      pageHandler: () => {},
      rerunPageHandlerOnUrlChange: true,
    },
  ]

  assert.deepEqual(
    __test__.getUrlChangePageHandlerCollectors(
      "https://x.com/junfanzhu98/status/2048096260578767044",
      collectors,
      new Set(["x", "web_clip"]),
    ).map((collector) => collector.id),
    ["web_clip"],
  )
})

test("isPageReadyForCollectors rejects the initial blank document", () => {
  const actual = __test__.isPageReadyForCollectors({
    hasBody: true,
    readyState: "complete",
    locationHref: "about:blank",
  })

  assert.equal(actual, false)
})

test("isPageReadyForCollectors accepts a loaded http page", () => {
  const actual = __test__.isPageReadyForCollectors({
    hasBody: true,
    readyState: "interactive",
    locationHref: "https://arxiv.org/abs/2604.07725",
  })

  assert.equal(actual, true)
})

test("isPageActiveForCollectors accepts visible or focused loaded http pages", () => {
  assert.equal(__test__.isPageActiveForCollectors({
    hasBody: true,
    readyState: "complete",
    locationHref: "https://github.com/openai/openai-node",
    visibilityState: "visible",
    hasFocus: false,
  }), true)

  assert.equal(__test__.isPageActiveForCollectors({
    hasBody: true,
    readyState: "complete",
    locationHref: "https://github.com/openai/openai-node",
    visibilityState: "hidden",
    hasFocus: true,
  }), true)
})

test("isPageActiveForCollectors rejects hidden unfocused and loading pages", () => {
  assert.equal(__test__.isPageActiveForCollectors({
    hasBody: true,
    readyState: "complete",
    locationHref: "https://github.com/openai/openai-node",
    visibilityState: "hidden",
    hasFocus: false,
  }), false)

  assert.equal(__test__.isPageActiveForCollectors({
    hasBody: true,
    readyState: "loading",
    locationHref: "https://github.com/openai/openai-node",
    visibilityState: "visible",
    hasFocus: true,
  }), false)
})

test("shouldRunCollectorsAfterAttach defers initial hidden pages but runs explicit trigger paths", () => {
  const hiddenReady = {
    hasBody: true,
    readyState: "complete",
    locationHref: "https://x.com/home",
    visibilityState: "hidden",
    hasFocus: false,
  }

  assert.equal(__test__.shouldRunCollectorsAfterAttach("initial", hiddenReady), false)
  assert.equal(__test__.shouldRunCollectorsAfterAttach("created", hiddenReady), false)
  assert.equal(__test__.shouldRunCollectorsAfterAttach("initial-active", hiddenReady), true)
  assert.equal(__test__.shouldRunCollectorsAfterAttach("location-change", hiddenReady), true)
  assert.equal(__test__.shouldRunCollectorsAfterAttach("config-enable", hiddenReady), true)
})

test("shouldRunCollectorsAfterAttach runs initial visible pages", () => {
  const visibleReady = {
    hasBody: true,
    readyState: "complete",
    locationHref: "https://github.com/openai/openai-node",
    visibilityState: "visible",
    hasFocus: false,
  }

  assert.equal(__test__.shouldRunCollectorsAfterAttach("initial", visibleReady), true)
})

test("parseActivationNotifyPayload treats activation payloads only as untrusted signals", () => {
  const payload = JSON.stringify({
    key: "__latent:page-activation",
    reason: "visibilitychange",
    href: "https://attacker.example/forged-url",
    hasBody: false,
    readyState: "loading",
    visibilityState: "hidden",
    hasFocus: false,
    detectedAt: 123,
  })

  assert.deepEqual(__test__.parseActivationNotifyPayload(payload), {
    key: "__latent:page-activation",
    reason: "visibilitychange",
    detectedAt: 123,
  })

  assert.equal(__test__.parseActivationNotifyPayload(JSON.stringify({
    key: "__latent:not-activation",
    reason: "focus",
  })), null)

  assert.equal(__test__.parseActivationNotifyPayload("not json"), null)
})

test("isDuplicateLocationCheck coalesces near-identical location events", () => {
  const previous = { url: "https://x.com/home", at: 1000 }

  assert.equal(__test__.isDuplicateLocationCheck(previous, "https://x.com/home", 1500), true)
  assert.equal(__test__.isDuplicateLocationCheck(previous, "https://x.com/home", 2500), false)
  assert.equal(__test__.isDuplicateLocationCheck(previous, "https://x.com/explore", 1500), false)
})

test("isStaleSessionError treats closed CDP connections as stale", () => {
  assert.equal(__test__.isStaleSessionError(new Error("CDP session closed")), true)
  assert.equal(__test__.isStaleSessionError(new Error("CDP not connected")), true)
  assert.equal(__test__.isStaleSessionError(new Error("Session with given id not found")), true)
  assert.equal(__test__.isStaleSessionError(new Error("CDP command timeout: Runtime.evaluate")), false)
})

test("hasCompleteCollectorInjection requires action handler injection when present", () => {
  const pageOnlyCollector = {
    id: "page-only",
    description: "Page collector",
    urlPatterns: ["https://example.com/*"],
  }
  const actionCollector = {
    id: "action",
    description: "Action collector",
    urlPatterns: ["https://example.com/*"],
    actionHandler: () => {},
  }

  assert.equal(__test__.hasCompleteCollectorInjection(new Set(["page-only"]), pageOnlyCollector), true)
  assert.equal(__test__.hasCompleteCollectorInjection(new Set(["action"]), actionCollector), false)
  assert.equal(__test__.hasCompleteCollectorInjection(new Set(["action", "action:action"]), actionCollector), true)
})

test("orderPageTargetsForInitialAttach prioritizes the active tab hint", () => {
  const targets = [
    { targetId: "background", type: "page", url: "https://x.com/home", title: "Home / X" },
    { targetId: "active", type: "page", url: "https://github.com/openai/openai-node", title: "openai-node" },
  ]

  const actual = __test__.orderPageTargetsForInitialAttach(targets, {
    url: "https://github.com/openai/openai-node",
    title: "openai-node",
  })

  assert.deepEqual(actual.active.map((target) => target.targetId), ["active"])
  assert.deepEqual(actual.rest.map((target) => target.targetId), ["background"])
})

test("orderPageTargetsForInitialAttach matches active tab hint without hash", () => {
  const targets = [
    { targetId: "active", type: "page", url: "https://github.com/openai/openai-node", title: "openai-node" },
  ]

  const actual = __test__.orderPageTargetsForInitialAttach(targets, {
    url: "https://github.com/openai/openai-node#readme",
  })

  assert.deepEqual(actual.active.map((target) => target.targetId), ["active"])
  assert.deepEqual(actual.rest, [])
})

test("runWithConcurrency caps parallel startup work without dropping items", async () => {
  let active = 0
  let maxActive = 0
  const completed: number[] = []

  await __test__.runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    completed.push(item)
    active -= 1
  })

  assert.equal(maxActive, 2)
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test("CdpCommandQueue rejects stale generation work after invalidation", async () => {
  const queue = new __test__.CdpCommandQueue()
  const targetId = "target-1"
  const oldGeneration = queue.generation(targetId)
  let staleRan = false

  queue.invalidate(targetId)

  await assert.rejects(
    queue.enqueue(targetId, oldGeneration, "default", async () => {
      staleRan = true
    }),
    /stale target generation/,
  )

  await queue.enqueue(targetId, queue.generation(targetId), "default", async () => {
    return "fresh"
  })

  assert.equal(staleRan, false)
})

test("CdpCommandQueue lanes let badge work bypass slow default work", async () => {
  const queue = new __test__.CdpCommandQueue()
  const targetId = "target-1"
  const generation = queue.generation(targetId)
  const events: string[] = []
  let releaseDefault: () => void = () => {
    throw new Error("default command was not started")
  }

  const firstDefault = queue.enqueue(targetId, generation, "default", () => {
    events.push("default-start")
    return new Promise<void>((resolve) => {
      releaseDefault = resolve
    })
  })
  const secondDefault = queue.enqueue(targetId, generation, "default", async () => {
    events.push("default-second")
  })
  const badge = queue.enqueue(targetId, generation, "badge", async () => {
    events.push("badge")
  })

  await badge
  assert.deepEqual(events, ["default-start", "badge"])

  releaseDefault()
  await Promise.all([firstDefault, secondDefault])

  assert.deepEqual(events, ["default-start", "badge", "default-second"])
})

test("CdpCommandQueue prioritizes pending active-page work in a lane", async () => {
  const queue = new __test__.CdpCommandQueue()
  const targetId = "target-1"
  const generation = queue.generation(targetId)
  const events: string[] = []
  let releaseDefault: () => void = () => {
    throw new Error("default command was not started")
  }

  const first = queue.enqueue(targetId, generation, "default", () => {
    events.push("first")
    return new Promise<void>((resolve) => {
      releaseDefault = resolve
    })
  })
  const background = queue.enqueue(targetId, generation, "default", async () => {
    events.push("background")
  })
  const active = queue.enqueue(targetId, generation, "default", async () => {
    events.push("active")
  }, 100)

  releaseDefault()
  await Promise.all([first, background, active])

  assert.deepEqual(events, ["first", "active", "background"])
})
