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
