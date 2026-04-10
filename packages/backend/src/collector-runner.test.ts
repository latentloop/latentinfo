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
