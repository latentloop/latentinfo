import test from "node:test"
import assert from "node:assert/strict"
import { runInNewContext } from "node:vm"

import type { PageProxy } from "../../collector-runner.js"
import { injectActionLogic } from "./action-page-fns.js"

test("injectActionLogic emits valid JavaScript for each page-side evaluation", async () => {
  const scripts: string[] = []

  const page: PageProxy = {
    url: "https://x.com/test/status/1",
    async evaluate(script) {
      const source = String(script)
      scripts.push(source)
      new Function(source)
      return null
    },
    async installModule() {},
    async callModule() {},
    async screenshot() { return Buffer.alloc(0) },
    onNotify() {},
    async disposeCollector() {},
    onCleanup() {},
  }

  await injectActionLogic(page, "warn", 0.5)

  assert.equal(scripts.length, 3)
  assert.ok(scripts.some(source => source.includes("chooseDownNavigationTarget")))
  assert.ok(scripts.some(source => source.includes("chooseViewportFocusIndex")))
})

test("injectActionLogic rebinds URL-change handling after reinjection so tweet-open/back keeps using the current handler", async () => {
  const scripts: string[] = []

  const page: PageProxy = {
    url: "https://x.com/test/status/1",
    async evaluate(script) {
      scripts.push(String(script))
      return null
    },
    async installModule() {},
    async callModule() {},
    async screenshot() { return Buffer.alloc(0) },
    onNotify() {},
    async disposeCollector() {},
    onCleanup() {},
  }

  await injectActionLogic(page, "warn", 0.5)

  const listeners = new Map<string, Function[]>()
  let dotRemovals = 0

  const focusDot = {
    remove() {
      dotRemovals++
    },
  }

  const windowObject: Record<string, any> = {
    innerHeight: 1000,
    addEventListener(event: string, handler: Function) {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
    },
    removeEventListener(event: string, handler: Function) {
      const handlers = listeners.get(event) ?? []
      listeners.set(event, handlers.filter(candidate => candidate !== handler))
    },
  }

  const scrollElement = {
    scrollTop: 0,
    dispatchEvent() {},
  }

  const context = {
    window: windowObject,
    document: {
      querySelector(selector: string) {
        if (selector === ".latent-focus-dot") return focusDot
        return null
      },
      querySelectorAll() {
        return []
      },
      getElementById() {
        return null
      },
      activeElement: null,
      scrollingElement: scrollElement,
      documentElement: scrollElement,
    },
    history: {
      pushState() {},
      replaceState() {},
    },
    location: {
      href: "https://x.com/home",
    },
    requestAnimationFrame(fn: Function) {
      fn()
      return 1
    },
    setTimeout(fn: Function) {
      fn()
      return 1
    },
    clearTimeout() {},
    console: {
      log() {},
    },
    performance: {
      now() { return 0 },
    },
    WheelEvent: function() {},
    Math,
    Date,
  }

  windowObject.window = windowObject
  windowObject.document = context.document
  windowObject.history = context.history
  windowObject.location = context.location
  windowObject.requestAnimationFrame = context.requestAnimationFrame
  windowObject.setTimeout = context.setTimeout
  windowObject.clearTimeout = context.clearTimeout
  windowObject.console = context.console
  windowObject.performance = context.performance
  windowObject.WheelEvent = context.WheelEvent
  windowObject.Math = Math
  windowObject.Date = Date

  runInNewContext(scripts[0]!, context)
  runInNewContext(scripts[1]!, context)

  context.location.href = "https://x.com/test/status/1"
  context.history.pushState()

  context.location.href = "https://x.com/home"
  runInNewContext(scripts[1]!, context)

  assert.equal((listeners.get("popstate") ?? []).length, 1)
  assert.equal((listeners.get("scroll") ?? []).length, 1)

  dotRemovals = 0
  context.location.href = "https://x.com/test/status/1"
  context.history.pushState()

  assert.ok(dotRemovals > 0)
})
