export type DownNavigationCandidate = {
  top: number
  bottom: number
  isCursor: boolean
  isValid: boolean
  isUnseen: boolean
}

export type DownNavigationDecision =
  | {
    action: "focus-target"
    index: number
    reason: "next-unseen-near"
  }
  | {
    action: "focus-viewport"
    index: number
    reason: "cursor-out-of-viewport"
  }
  | {
    action: "scroll-then-focus-viewport"
    reason: "next-unseen-too-far" | "no-unseen-target"
  }

type DownNavigationOptions = {
  viewportHeight: number
  anchorRatio?: number
  belowAnchorOffsetPx?: number
  maxSkipDistanceMultiplier?: number
}

export function chooseViewportFocusIndex(
  candidates: DownNavigationCandidate[],
  options: DownNavigationOptions,
): number {
  const viewportHeight = options.viewportHeight
  const anchorRatio = options.anchorRatio ?? 0.2
  const anchor = viewportHeight * anchorRatio

  let bestIndex = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let bestTop = Number.POSITIVE_INFINITY

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!
    if (candidate.bottom < 0 || candidate.top > viewportHeight) continue

    const distanceFromAnchor = Math.abs(candidate.top - anchor)
    if (
      distanceFromAnchor < bestDistance
      || (distanceFromAnchor === bestDistance && candidate.top < bestTop)
    ) {
      bestIndex = i
      bestDistance = distanceFromAnchor
      bestTop = candidate.top
    }
  }

  return bestIndex
}

export function chooseDownNavigationTarget(
  candidates: DownNavigationCandidate[],
  options: DownNavigationOptions,
): DownNavigationDecision {
  const viewportHeight = options.viewportHeight
  const anchorRatio = options.anchorRatio ?? 0.2
  const belowAnchorOffsetPx = options.belowAnchorOffsetPx ?? 50
  const maxSkipDistanceMultiplier = options.maxSkipDistanceMultiplier ?? 2
  const anchor = viewportHeight * anchorRatio
  const belowThreshold = Math.floor(anchor) + belowAnchorOffsetPx

  const hasCursor = candidates.some(candidate => candidate.isCursor)
  const cursorInViewport = candidates.some(candidate =>
    candidate.isCursor
    && candidate.bottom >= 0
    && candidate.top <= viewportHeight,
  )

  if (hasCursor && !cursorInViewport) {
    const viewportIndex = chooseViewportFocusIndex(candidates, options)
    if (viewportIndex !== -1) {
      return {
        action: "focus-viewport",
        index: viewportIndex,
        reason: "cursor-out-of-viewport",
      }
    }
  }

  let unseenBelowIndex = -1
  let unseenBelowTop = Number.POSITIVE_INFINITY

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!
    if (candidate.isCursor) continue
    if (candidate.top <= belowThreshold) continue
    if (!candidate.isValid || !candidate.isUnseen) continue
    if (candidate.top < unseenBelowTop) {
      unseenBelowTop = candidate.top
      unseenBelowIndex = i
    }
  }

  if (unseenBelowIndex !== -1) {
    if (unseenBelowTop <= maxSkipDistanceMultiplier * viewportHeight) {
      return {
        action: "focus-target",
        index: unseenBelowIndex,
        reason: "next-unseen-near",
      }
    }

    return {
      action: "scroll-then-focus-viewport",
      reason: "next-unseen-too-far",
    }
  }

  return {
    action: "scroll-then-focus-viewport",
    reason: "no-unseen-target",
  }
}
