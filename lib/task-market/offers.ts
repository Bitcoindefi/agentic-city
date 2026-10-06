export type TaskOfferAsset = "XLM" | "USDC"
export type TaskOfferStatus = "open" | "claimed" | "delivered" | "accepted" | "disputed" | "expired" | "cancelled"

export interface TaskOfferReward {
  amount: string
  asset: TaskOfferAsset
}

export interface TaskOffer {
  offerId: string
  postedBy: string
  requiredCapability: string
  payload: unknown
  reward: TaskOfferReward
  deadline: number
  status: TaskOfferStatus
  escrowTx: string
  refundTx?: string
  createdAt: string
  updatedAt: string
}

export interface CreateTaskOfferInput {
  postedBy: string
  requiredCapability: string
  payload?: unknown
  reward: string | Partial<TaskOfferReward>
  deadline: number
}

interface TaskOfferState {
  offers: Map<string, TaskOffer>
  sequence: number
}

const globalState = globalThis as typeof globalThis & {
  __openStellarTaskOffers__?: TaskOfferState
}

const state: TaskOfferState = globalState.__openStellarTaskOffers__ ?? {
  offers: new Map(),
  sequence: 0,
}

globalState.__openStellarTaskOffers__ ??= state

function assertNonEmpty(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new Error(`${field} is required`)
  return text
}

function nextOfferId(): string {
  state.sequence += 1
  return `off_${Date.now().toString(36)}_${state.sequence.toString(36)}`
}

function isTaskOfferAsset(value: unknown): value is TaskOfferAsset {
  return value === "XLM" || value === "USDC"
}

function normalizeReward(reward: string | Partial<TaskOfferReward>): TaskOfferReward {
  if (typeof reward === "string") {
    const match = /^(\d+(?:\.\d+)?)\s+(XLM|USDC)$/i.exec(reward.trim())
    if (!match) throw new Error("reward must be formatted like '0.05 XLM'")
    const amount = match[1]
    const asset = match[2].toUpperCase()
    if (Number(amount) <= 0) throw new Error("reward amount must be > 0")
    if (!isTaskOfferAsset(asset)) throw new Error("reward asset must be XLM or USDC")
    return { amount, asset }
  }

  if (!reward || typeof reward !== "object") {
    throw new Error("reward is required")
  }

  const amount = String(reward.amount ?? "").trim()
  const asset = String(reward.asset ?? "").trim().toUpperCase()
  if (!amount || Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
    throw new Error("reward amount must be > 0")
  }
  if (!isTaskOfferAsset(asset)) throw new Error("reward asset must be XLM or USDC")
  return { amount, asset }
}

function normalizeDeadline(deadline: number): number {
  const value = Number(deadline)
  if (!Number.isFinite(value)) throw new Error("deadline must be a unix timestamp")
  const timestamp = value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  if (timestamp <= Math.floor(Date.now() / 1000)) throw new Error("deadline must be in the future")
  return timestamp
}

function escrowHash(prefix: "escrow" | "refund", offerId: string): string {
  return `${prefix}_${offerId}_${crypto.randomUUID()}`
}

function refreshOfferExpiry(offer: TaskOffer): TaskOffer {
  if (offer.status !== "open" || offer.deadline > Math.floor(Date.now() / 1000)) {
    return offer
  }
  const expired = {
    ...offer,
    status: "expired" as const,
    refundTx: offer.refundTx ?? escrowHash("refund", offer.offerId),
    updatedAt: new Date().toISOString(),
  }
  state.offers.set(offer.offerId, expired)
  return expired
}

export function resetTaskOffersForTests(): void {
  state.offers.clear()
  state.sequence = 0
}

export function createTaskOffer(input: CreateTaskOfferInput): TaskOffer {
  const now = new Date().toISOString()
  const offerId = nextOfferId()
  const offer: TaskOffer = {
    offerId,
    postedBy: assertNonEmpty(input.postedBy, "postedBy"),
    requiredCapability: assertNonEmpty(input.requiredCapability, "requiredCapability"),
    payload: input.payload ?? {},
    reward: normalizeReward(input.reward),
    deadline: normalizeDeadline(input.deadline),
    status: "open",
    escrowTx: escrowHash("escrow", offerId),
    createdAt: now,
    updatedAt: now,
  }
  state.offers.set(offer.offerId, offer)
  return offer
}

export function getTaskOffer(offerId: string): TaskOffer | null {
  const offer = state.offers.get(offerId)
  return offer ? refreshOfferExpiry(offer) : null
}

export function listTaskOffers(filters: { requiredCapability?: string; includeExpired?: boolean } = {}): TaskOffer[] {
  return [...state.offers.values()]
    .map(refreshOfferExpiry)
    .filter((offer) => filters.includeExpired || offer.status === "open")
    .filter((offer) => !filters.requiredCapability || offer.requiredCapability === filters.requiredCapability)
    .sort((a, b) => a.deadline - b.deadline || a.offerId.localeCompare(b.offerId))
}

export function cancelTaskOffer(offerId: string, actorId: string): TaskOffer {
  const offer = getTaskOffer(offerId)
  if (!offer) throw new Error("Task offer not found")
  if (offer.postedBy !== actorId) throw new Error("Only the poster can cancel this offer")
  if (offer.status !== "open") throw new Error("Only open offers can be cancelled")
  const cancelled = {
    ...offer,
    status: "cancelled" as const,
    refundTx: offer.refundTx ?? escrowHash("refund", offer.offerId),
    updatedAt: new Date().toISOString(),
  }
  state.offers.set(offerId, cancelled)
  return cancelled
}
