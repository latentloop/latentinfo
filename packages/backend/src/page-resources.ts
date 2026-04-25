// @ts-nocheck
/**
 * Page-side resource tracker — tracks MutationObservers, event listeners,
 * and timers per collector for bulk cleanup.
 *
 * These functions are serialized via .toString() and injected into the browser
 * page context via installModule(). They reference browser globals (window,
 * AbortController) that don't exist in Node.js — hence @ts-nocheck.
 *
 * Module name: "__resources" (double underscore = framework-owned).
 * In-page access: window.__latent.__tracker (initialized after install).
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// NOTE: No module-level variables! Functions serialized via .toString() cannot
// reference closure variables — all constants must be inlined in each function.

/**
 * createResourceTracker — create a per-collector resource cleanup coordinator.
 *
 * Returns an object that tracks MutationObservers, event listeners, timers,
 * and arbitrary cleanup functions keyed by collector ID. Calling
 * disposeCollector(id) tears down everything registered under that ID.
 *
 * Disposal order per bucket: MutationObservers disconnect FIRST, then other
 * cleanups run LIFO. This prevents a cleanup that mutates the DOM from being
 * picked up by a still-live observer that then tries to notify against a
 * closed CDP binding.
 *
 * Cleanup purity rule — cleanup callbacks registered via addCleanup MUST:
 *   (a) not call window.__latentInfoNotify or any CDP-dependent API — during
 *       reattach, the old CDP session is gone and such calls throw; and
 *   (b) not perform DOM mutations observable by any still-live MutationObserver
 *       in the same or prior lifetime.
 *
 * Uses AbortController for addEventListener cleanup (native browser support).
 */
export function createResourceTracker() {
  var resources = {}  // { [collectorId]: Array<() => void> } — non-observer cleanups, LIFO
  var observers = {}  // { [collectorId]: Array<() => void> } — observer.disconnect fns, disposed first

  function getOrCreate(collectorId) {
    if (!resources[collectorId]) resources[collectorId] = []
    return resources[collectorId]
  }

  function getOrCreateObservers(collectorId) {
    if (!observers[collectorId]) observers[collectorId] = []
    return observers[collectorId]
  }

  return {
    /**
     * Track a MutationObserver. Calls observe() and stores disconnect() in
     * the observers bucket so it runs before any other cleanup on dispose.
     */
    addObserver: function(collectorId, observer, target, config) {
      observer.observe(target, config)
      getOrCreateObservers(collectorId).push(function() { observer.disconnect() })
      return observer
    },

    /**
     * Track an event listener. Uses AbortController internally for cleanup.
     */
    addListener: function(collectorId, target, event, handler, options) {
      var ac = new AbortController()
      var opts = {}
      if (options) {
        for (var k in options) {
          if (options.hasOwnProperty(k)) opts[k] = options[k]
        }
      }
      opts.signal = ac.signal
      target.addEventListener(event, handler, opts)
      getOrCreate(collectorId).push(function() { ac.abort() })
    },

    /**
     * Track a setTimeout. Returns the timer ID.
     */
    addTimeout: function(collectorId, fn, delay) {
      var id = setTimeout(fn, delay)
      getOrCreate(collectorId).push(function() { clearTimeout(id) })
      return id
    },

    /**
     * Track a setInterval. Returns the timer ID.
     */
    addInterval: function(collectorId, fn, delay) {
      var id = setInterval(fn, delay)
      getOrCreate(collectorId).push(function() { clearInterval(id) })
      return id
    },

    /**
     * Register an arbitrary cleanup function.
     * See purity rule in the module header — no __latentInfoNotify, no DOM
     * mutations observable by still-live MutationObservers.
     */
    addCleanup: function(collectorId, fn) {
      getOrCreate(collectorId).push(fn)
    },

    /**
     * Tear down all resources for a specific collector.
     * Observers disconnect first, then other cleanups run LIFO.
     */
    disposeCollector: function(collectorId) {
      var obs = observers[collectorId]
      if (obs) {
        for (var k = obs.length - 1; k >= 0; k--) {
          try { obs[k]() } catch(e) { /* swallow — continue cleanup */ }
        }
        delete observers[collectorId]
      }
      var cleanups = resources[collectorId]
      if (cleanups) {
        for (var i = cleanups.length - 1; i >= 0; i--) {
          try { cleanups[i]() } catch(e) { /* swallow — continue cleanup */ }
        }
        delete resources[collectorId]
      }
    },

    /**
     * Tear down all resources for all collectors.
     */
    disposeAll: function() {
      var ids = {}
      var rk = Object.keys(resources)
      for (var j = 0; j < rk.length; j++) ids[rk[j]] = true
      var ok = Object.keys(observers)
      for (var m = 0; m < ok.length; m++) ids[ok[m]] = true
      var allIds = Object.keys(ids)
      for (var n = 0; n < allIds.length; n++) {
        this.disposeCollector(allIds[n])
      }
    },

    /**
     * Query which collectors have registered resources.
     */
    activeCollectors: function() {
      var ids = {}
      var rk = Object.keys(resources)
      for (var j = 0; j < rk.length; j++) ids[rk[j]] = true
      var ok = Object.keys(observers)
      for (var m = 0; m < ok.length; m++) ids[ok[m]] = true
      return Object.keys(ids)
    }
  }
}
