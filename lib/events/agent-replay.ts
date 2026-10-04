import type { PublishedSystemEvent } from "@/lib/events/system-events"

export const AGENT_REPLAY_LIMIT = 50

export interface ReplayEvent {
  type: string
  payload: Record<string, unknown>
  recordedAt: string
}

interface ReplayBuffer {
  entries: ReplayEvent[]
  next: number
}

const globalState = globalThis as typeof globalThis & {
  __openStellarAgentReplay__?: Map<string, ReplayBuffer>
}

function buffers(): Map<string, ReplayBuffer> {
  return globalState.__openStellarAgentReplay__ ??= new Map()
}

/** Capture before event listeners can mutate an event; unscoped events are ignored. */
export function recordAgentReplay(event: PublishedSystemEvent): void {
  const agentId = event.agentId || (
    (event.type === "quest.abandoned" || event.type === "quest.expired") && "quest" in event
      ? event.quest.assignedTo
      : null
  )
  if (!agentId) return
  let buffer = buffers().get(agentId)
  if (!buffer) {
    buffer = { entries: [], next: 0 }
    buffers().set(agentId, buffer)
  }
  const { type, ...payload } = event
  buffer.entries[buffer.next] = {
    type,
    payload: structuredClone(payload),
    recordedAt: new Date().toISOString(),
  }
  buffer.next = (buffer.next + 1) % AGENT_REPLAY_LIMIT
}

/** Return independent snapshots, newest first, regardless of the ring's position. */
export function getAgentReplay(agentId: string): ReplayEvent[] {
  const buffer = buffers().get(agentId)
  if (!buffer) return []
  return Array.from({ length: buffer.entries.length }, (_, index) => {
    const slot = (buffer.next - 1 - index + buffer.entries.length) % buffer.entries.length
    return structuredClone(buffer.entries[slot])
  })
}

export function clearAgentReplay(agentId: string): void {
  buffers().delete(agentId)
}

export function resetAgentReplayForTests(): void {
  buffers().clear()
}
