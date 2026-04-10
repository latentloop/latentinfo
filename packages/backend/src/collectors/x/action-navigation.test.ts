import test from "node:test"
import assert from "node:assert/strict"

import {
  chooseDownNavigationTarget,
  chooseViewportFocusIndex,
  type DownNavigationCandidate,
} from "./action-navigation.js"

function decide(candidates: DownNavigationCandidate[]) {
  return chooseDownNavigationTarget(candidates, {
    viewportHeight: 1000,
    maxSkipDistanceMultiplier: 2,
  })
}

test("chooseDownNavigationTarget prefers the nearest unseen tweet below the anchor threshold", () => {
  const actual = decide([
    { top: 120, bottom: 300, isCursor: true, isValid: true, isUnseen: false },
    { top: 340, bottom: 520, isCursor: false, isValid: true, isUnseen: true },
    { top: 680, bottom: 860, isCursor: false, isValid: true, isUnseen: true },
  ])

  assert.deepEqual(actual, {
    action: "focus-target",
    index: 1,
    reason: "next-unseen-near",
  })
})

test("chooseDownNavigationTarget scrolls the viewport instead of jumping when the next unseen valid tweet is too far away", () => {
  const actual = decide([
    { top: 80, bottom: 240, isCursor: true, isValid: true, isUnseen: false },
    { top: 180, bottom: 360, isCursor: false, isValid: false, isUnseen: false },
    { top: 2600, bottom: 2780, isCursor: false, isValid: true, isUnseen: true },
  ])

  assert.deepEqual(actual, {
    action: "scroll-then-focus-viewport",
    reason: "next-unseen-too-far",
  })
})

test("chooseDownNavigationTarget re-focuses a visible tweet when the cursor is outside the viewport", () => {
  const actual = decide([
    { top: -420, bottom: -220, isCursor: true, isValid: true, isUnseen: false },
    { top: 140, bottom: 320, isCursor: false, isValid: false, isUnseen: false },
    { top: 520, bottom: 740, isCursor: false, isValid: true, isUnseen: false },
  ])

  assert.deepEqual(actual, {
    action: "focus-viewport",
    index: 1,
    reason: "cursor-out-of-viewport",
  })
})

test("chooseDownNavigationTarget scrolls the viewport when there is no unseen valid target nearby", () => {
  const actual = decide([
    { top: 220, bottom: 360, isCursor: true, isValid: true, isUnseen: false },
    { top: 420, bottom: 560, isCursor: false, isValid: false, isUnseen: false },
    { top: 640, bottom: 820, isCursor: false, isValid: true, isUnseen: false },
  ])

  assert.deepEqual(actual, {
    action: "scroll-then-focus-viewport",
    reason: "no-unseen-target",
  })
})

test("chooseViewportFocusIndex can focus a promoted or seen tweet inside the viewport", () => {
  const actual = chooseViewportFocusIndex([
    { top: -120, bottom: 20, isCursor: false, isValid: true, isUnseen: false },
    { top: 160, bottom: 340, isCursor: false, isValid: false, isUnseen: false },
    { top: 460, bottom: 680, isCursor: false, isValid: true, isUnseen: false },
  ], {
    viewportHeight: 1000,
  })

  assert.equal(actual, 1)
})
