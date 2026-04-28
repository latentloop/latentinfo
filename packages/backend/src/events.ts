import { EventEmitter } from "node:events"

export interface BackendEvent {
  event: string
  data: unknown
}

const backendEvents = new EventEmitter()

export function emitBackendEvent(event: string, data: unknown): void {
  backendEvents.emit("event", { event, data } satisfies BackendEvent)
}

export function onBackendEvent(listener: (payload: BackendEvent) => void): () => void {
  backendEvents.on("event", listener)
  return () => {
    backendEvents.off("event", listener)
  }
}
