import type { AgentStatus } from "@/lib/types"
import type { X402Receipt } from "@/lib/protocols/x402"
import type { BadgeRarity } from "@/lib/gamification/badge-catalog"
import type { Quest } from "@/lib/quests/quest-store"

export interface AgentTask {
  id: string
  title: string
  district?: string
}

export interface TaskResult {
  summary: string
  durationMs?: number
}

export interface Badge {
  id: string
  name: string
  rarity?: BadgeRarity
}

export interface QuestCompletionSummary {
  id: string
  title: string
}

export interface QuestCompletionReward {
  xp: number
  xlm?: string
  badge?: string
  title?: string
}

interface BaseEvent {
  id?: string
  occurredAt?: string
}

export type SystemEvent =
  | (BaseEvent & { type: "agent.status"; agentId: string; status: AgentStatus })
  | (BaseEvent & { type: "task.started"; agentId: string; task: AgentTask })
  | (BaseEvent & { type: "task.completed"; agentId: string; taskId: string; result: TaskResult; skillId?: string })
  | (BaseEvent & { type: "payment.received"; agentId: string; receipt: X402Receipt })
  | (BaseEvent & {
    type: "quest.completed"
    agentId: string
    questId?: string
    quest?: QuestCompletionSummary
    reward?: QuestCompletionReward
  })
  | (BaseEvent & { type: "quest.expired"; agentId: string; questId: string; completedSubtasks: number; totalSubtasks: number })
  | (BaseEvent & { type: "quest.expired"; questId: string; quest: Quest })
  | (BaseEvent & { type: "quest.expired"; questId: string; agentId?: string; expiresAt?: string; remainingMs?: number })
  | (BaseEvent & { type: "quest.abandoned"; questId: string; quest: Quest })
  | (BaseEvent & { type: "quest.unlocked"; agentId: string; questId: string })
  | (BaseEvent & { type: "agent.xp"; agentId: string; xp: number; totalXp?: number; level: number; xpToNext?: number; reason?: string })
  | (BaseEvent & { type: "badge.unlocked"; agentId: string; badge: Badge })
  | (BaseEvent & { type: "district.unlocked"; districtId?: import("@/lib/types").DistrictId; district?: import("@/lib/types").District })
  | (BaseEvent & {
    type: "agent.registry"
    agentId: string
    action: "registered" | "updated" | "deregistered"
    agent: import("@/lib/agent-registry").AgentCapabilityManifest
  })



export type PublishedSystemEvent = SystemEvent & {
  id: string
  occurredAt: string
  // Some events are not agent-scoped.
  agentId?: string
}


type EventListener = (event: PublishedSystemEvent) => void

interface EventBusState {
  listeners: Set<EventListener>
  sequence: number
}

const EVENT_LOG_LIMIT = 500

const globalState = globalThis as typeof globalThis & {
  __openStellarEventBus__?: EventBusState
  __openStellarEventLog__?: PublishedSystemEvent[]
}

const eventBus: EventBusState = globalState.__openStellarEventBus__ ?? {
  listeners: new Set<EventListener>(),
  sequence: 0,
}

if (!globalState.__openStellarEventBus__) {
  globalState.__openStellarEventBus__ = eventBus
}

function getEventLog(): PublishedSystemEvent[] {
  if (!globalState.__openStellarEventLog__) {
    globalState.__openStellarEventLog__ = []
  }
  return globalState.__openStellarEventLog__
}

function appendToEventLog(event: PublishedSystemEvent): void {
  const log = getEventLog()
  log.push(event)
  if (log.length > EVENT_LOG_LIMIT) {
    log.splice(0, log.length - EVENT_LOG_LIMIT)
  }
}

function nextEventId(type: string) {
  eventBus.sequence += 1
  return `${type}:${Date.now()}:${eventBus.sequence}`
}

export function ensurePublishedEvent(event: SystemEvent): PublishedSystemEvent {
  return {
    ...event,
    id: event.id || nextEventId(event.type),
    occurredAt: event.occurredAt || new Date().toISOString(),
  } as PublishedSystemEvent
}

export function eventMatchesAgent(event: PublishedSystemEvent, agentId?: string) {
  // If an event is not agent-scoped (e.g. district unlock), allow it to pass when no agentId filter is set.
  if (!agentId) return true
  return event.agentId === agentId
}


export function publishSystemEvent(event: SystemEvent): PublishedSystemEvent {
  const published = ensurePublishedEvent(event)
  appendToEventLog(published)
  for (const listener of eventBus.listeners) {
    listener(published)
  }
  return published
}

export function emitEvent(type: string, payload: Record<string, any>): PublishedSystemEvent {
  return publishSystemEvent({ type, ...payload } as unknown as SystemEvent)
}

export function listPublishedSystemEvents(): PublishedSystemEvent[] {
  return [...getEventLog()]
}

export function resetPublishedSystemEventLogForTests(): void {
  globalState.__openStellarEventLog__ = []
}

export function subscribeToSystemEvents(listener: EventListener) {
  eventBus.listeners.add(listener)
  return () => {
    eventBus.listeners.delete(listener)
  }
}

export function encodeSseEvent(event: PublishedSystemEvent) {
  return [
    `id: ${event.id}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n")
}

export function encodeSseComment(comment: string) {
  return `: ${comment}\n\n`
}
