import test from "node:test"
import assert from "node:assert/strict"
import { runInNewContext } from "node:vm"

import { startWatching } from "./page-functions.js"

function createContext() {
  const notifications: string[] = []
  const cleanups: Function[] = []
  const listeners = new Map<string, Function[]>()

  const article = {
    matches(selector: string) {
      return selector === 'article[data-testid="tweet"]'
    },
    querySelector(selector: string) {
      if (selector === ".li-scrape-badge") return null
      if (selector === 'a[href*="/status/"]') return {}
      if (selector.includes("tweetPhoto") || selector.includes("/photo/")) return null
      if (selector === '[data-testid="tweetText"]') {
        return {
          getBoundingClientRect() {
            return { top: 10, bottom: 110, height: 100 }
          },
        }
      }
      return null
    },
    getBoundingClientRect() {
      return { top: 10, bottom: 110, height: 100 }
    },
  }

  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  const tracker = {
    addListener(_collectorId: string, target: { addEventListener: Function }, event: string, handler: Function, options?: unknown) {
      target.addEventListener(event, handler, options)
    },
    addObserver(_collectorId: string, observer: { observe: Function }, target: unknown, config: unknown) {
      observer.observe(target, config)
    },
    addCleanup(_collectorId: string, fn: Function) {
      cleanups.push(fn)
    },
  }

  const windowObject: Record<string, any> = {
    innerHeight: 1000,
    scrollY: 0,
    pageYOffset: 0,
    __latent: {
      li_x: { enabled: true },
      __tracker: tracker,
    },
    __latentInfoNotify(payload: string) {
      notifications.push(payload)
    },
    addEventListener(event: string, handler: Function) {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
    },
  }

  const context = {
    window: windowObject,
    __name(fn: Function) {
      return fn
    },
    document: {
      body: {},
      querySelectorAll(selector: string) {
        return selector === 'article[data-testid="tweet"]' ? [article] : []
      },
    },
    MutationObserver,
    setTimeout(fn: Function) {
      fn()
      return 1
    },
    clearTimeout() {},
    Date,
  }

  return { context, windowObject, notifications, cleanups }
}

test("startWatching exposes and cleans up the X URL-change notifier", () => {
  const { context, windowObject, cleanups } = createContext()

  runInNewContext(`(${startWatching.toString()})({
    appName: "li_x",
    notifyKey: "li_x:new_tweets",
    collectorId: "x"
  })`, context)

  assert.equal(typeof windowObject.__latentXNotifyUrlChange, "function")

  for (const cleanup of cleanups) cleanup()

  assert.equal(windowObject.__latentXNotifyUrlChange, undefined)
})

test("startWatching URL-change notifier emits url-change notifications", () => {
  const { context, windowObject, notifications } = createContext()

  runInNewContext(`(${startWatching.toString()})({
    appName: "li_x",
    notifyKey: "li_x:new_tweets",
    collectorId: "x"
  })`, context)

  windowObject.__latentXNotifyUrlChange()

  assert.equal(notifications.length, 1)
  assert.equal(JSON.parse(notifications[0]!).reason, "url-change")
})
