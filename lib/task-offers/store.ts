/**
 * Task Offer Store
 *
 * Canonical in-memory storage for open-stellar task offers and state tracking.
 */

export type TaskOfferStatus =
  | "open"
  | "claimed"
  | "delivered"
  | "accepted"
  | "disputed"
  | "expired"

export interface TaskOfferTransitionEvent {
  fromStatus: TaskOfferStatus
  toStatus: TaskOfferStatus
  actor: string
  timestamp: number
  note?: string
}

export interface TaskOfferRecord {
  id: string
  title: string
  requiredCapability: string
  rewardAmount: number
  rewardAsset: string
  deadline: string
  status: TaskOfferStatus
  posterAgentId: string
  workerAgentId?: string | null
  payload: Record<string, unknown>
  result?: Record<string, unknown> | null
  disputeReason?: string | null
  disputedBy?: string | null
  escrowReleased?: boolean
  releasedAt?: number | null
  claimedAt?: number | null
  deliveredAt?: number | null
  acceptedAt?: number | null
  disputedAt?: number | null
  history: TaskOfferTransitionEvent[]

  // Server-only metadata. Never expose these fields through public board API.
  internalEscrowRef?: string | null
  internalCreatedAt?: string
}

export interface PublicTaskOffer {
  id: string
  title: string
  requiredCapability: string
  rewardAmount: number
  rewardAsset: string
  deadline: string
  status: TaskOfferStatus
  posterAgentId: string
  workerAgentId: string | null
  payload: Record<string, unknown>
  result?: Record<string, unknown> | null
  history?: TaskOfferTransitionEvent[]
}

const TASK_OFFERS = new Map<string, TaskOfferRecord>()

function cloneRecord(offer: TaskOfferRecord): TaskOfferRecord {
  return {
    ...offer,
    payload: { ...offer.payload },
    result: offer.result ? { ...offer.result } : null,
    history: offer.history ? [...offer.history] : [],
  }
}

function assertTaskOffer(offer: TaskOfferRecord) {
  if (!offer.id?.trim()) throw new Error("Task offer id is required")
  if (!offer.title?.trim()) throw new Error("Task offer title is required")
  if (!offer.requiredCapability?.trim()) throw new Error("Task offer capability is required")
  if (!Number.isFinite(offer.rewardAmount) || offer.rewardAmount < 0) {
    throw new Error("Task offer reward must be a non-negative number")
  }
  if (!Number.isFinite(Date.parse(offer.deadline))) {
    throw new Error("Task offer deadline must be an ISO-compatible date")
  }
}

export function putTaskOffer(offer: Partial<TaskOfferRecord> & Pick<TaskOfferRecord, "id" | "title" | "requiredCapability" | "rewardAmount" | "rewardAsset" | "deadline" | "posterAgentId">): TaskOfferRecord {
  const completeRecord: TaskOfferRecord = {
    id: offer.id,
    title: offer.title,
    requiredCapability: offer.requiredCapability,
    rewardAmount: offer.rewardAmount,
    rewardAsset: offer.rewardAsset,
    deadline: offer.deadline,
    status: offer.status ?? "open",
    posterAgentId: offer.posterAgentId,
    workerAgentId: offer.workerAgentId ?? null,
    payload: offer.payload ?? {},
    result: offer.result ?? null,
    disputeReason: offer.disputeReason ?? null,
    disputedBy: offer.disputedBy ?? null,
    escrowReleased: offer.escrowReleased ?? false,
    history: offer.history ?? [],
    internalEscrowRef: offer.internalEscrowRef ?? null,
    internalCreatedAt: offer.internalCreatedAt ?? new Date().toISOString(),
  }
  assertTaskOffer(completeRecord)
  const stored = cloneRecord(completeRecord)
  TASK_OFFERS.set(stored.id, stored)
  return cloneRecord(stored)
}

export function getTaskOffer(id: string): TaskOfferRecord | null {
  const offer = TASK_OFFERS.get(id)
  return offer ? cloneRecord(offer) : null
}

export function updateTaskOffer(id: string, updater: (record: TaskOfferRecord) => TaskOfferRecord): TaskOfferRecord {
  const current = TASK_OFFERS.get(id)
  if (!current) {
    throw new Error(`Task offer '${id}' not found`)
  }
  const updated = updater(cloneRecord(current))
  assertTaskOffer(updated)
  TASK_OFFERS.set(id, cloneRecord(updated))
  return cloneRecord(updated)
}

export function listOpenTaskOffers(options: {
  requiredCapability?: string
  now?: number
} = {}): TaskOfferRecord[] {
  const now = options.now ?? Date.now()
  const requiredCapability = options.requiredCapability?.trim().toLowerCase()

  return Array.from(TASK_OFFERS.values())
    .filter((offer) => {
      if (offer.status !== "open") return false
      if (Date.parse(offer.deadline) <= now) return false
      if (requiredCapability && offer.requiredCapability.toLowerCase() !== requiredCapability) return false
      return true
    })
    .sort((a, b) => {
      const deadlineDelta = Date.parse(a.deadline) - Date.parse(b.deadline)
      return deadlineDelta || a.id.localeCompare(b.id)
    })
    .map(cloneRecord)
}

export function toPublicTaskOffer(offer: TaskOfferRecord): PublicTaskOffer {
  return {
    id: offer.id,
    title: offer.title,
    requiredCapability: offer.requiredCapability,
    rewardAmount: offer.rewardAmount,
    rewardAsset: offer.rewardAsset,
    deadline: offer.deadline,
    status: offer.status,
    posterAgentId: offer.posterAgentId,
    workerAgentId: offer.workerAgentId ?? null,
    payload: { ...offer.payload },
    result: offer.result ? { ...offer.result } : null,
    history: [...offer.history],
  }
}

export function resetTaskOfferStoreForTests() {
  TASK_OFFERS.clear()
}
