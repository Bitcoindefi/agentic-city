/**
 * Task Offer Lifecycle State Machine & Concurrency Control
 *
 * Implements strict state transitions:
 *   [open] -> [claimed] -> [delivered] -> [accepted] (escrow paid)
 *                                      -> [disputed] (escrow frozen)
 *          -> [expired]
 */

import {
  getTaskOffer,
  updateTaskOffer,
  TaskOfferRecord,
  TaskOfferStatus,
  TaskOfferTransitionEvent,
} from './store'

export class LifecycleError extends Error {
  public statusCode: number
  public code: string
  public currentState?: TaskOfferStatus

  constructor(message: string, statusCode = 409, code = 'CONFLICT', currentState?: TaskOfferStatus) {
    super(message)
    this.name = 'LifecycleError'
    this.statusCode = statusCode
    this.code = code
    this.currentState = currentState
  }
}

// In-memory mutex map for atomic offer operations
const OFFER_LOCKS = new Map<string, Promise<unknown>>()

async function withOfferLock<T>(offerId: string, operation: () => Promise<T> | T): Promise<T> {
  const currentLock = OFFER_LOCKS.get(offerId) || Promise.resolve()
  let releaseLock: () => void

  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve
  })

  OFFER_LOCKS.set(offerId, newLock)

  try {
    await currentLock
    return await operation()
  } finally {
    releaseLock!()
    if (OFFER_LOCKS.get(offerId) === newLock) {
      OFFER_LOCKS.delete(offerId)
    }
  }
}

/**
 * Claim an open task offer (First-Come, First-Served)
 */
export async function claimTaskOffer(
  id: string,
  workerAgentId: string,
  options: { now?: number } = {}
): Promise<TaskOfferRecord> {
  if (!workerAgentId?.trim()) {
    throw new LifecycleError('Worker agentId is required to claim offer', 400, 'BAD_REQUEST')
  }

  return withOfferLock(id, () => {
    const offer = getTaskOffer(id)
    if (!offer) {
      throw new LifecycleError(`Task offer '${id}' not found`, 404, 'NOT_FOUND')
    }

    const now = options.now ?? Date.now()

    // 1. Expiration check
    if (Date.parse(offer.deadline) <= now) {
      // Mark as expired if not already
      if (offer.status === 'open') {
        updateTaskOffer(id, (rec) => ({
          ...rec,
          status: 'expired',
          history: [
            ...rec.history,
            {
              fromStatus: 'open',
              toStatus: 'expired',
              actor: 'system',
              timestamp: now,
              note: 'Offer expired past deadline before claim',
            },
          ],
        }))
      }
      throw new LifecycleError(`Task offer '${id}' has expired and cannot be claimed`, 409, 'OFFER_EXPIRED', 'expired')
    }

    // 2. Strict State Transition Check
    if (offer.status !== 'open') {
      throw new LifecycleError(
        `Invalid state transition: cannot claim offer in state '${offer.status}'`,
        409,
        'CONFLICT',
        offer.status
      )
    }

    // 3. Prevent self-claiming
    if (offer.posterAgentId === workerAgentId) {
      throw new LifecycleError('Poster agent cannot claim their own task offer', 400, 'BAD_REQUEST', offer.status)
    }

    // 4. Atomic Transition to 'claimed'
    const event: TaskOfferTransitionEvent = {
      fromStatus: 'open',
      toStatus: 'claimed',
      actor: workerAgentId,
      timestamp: now,
      note: `Claimed by worker agent ${workerAgentId}`,
    }

    return updateTaskOffer(id, (rec) => ({
      ...rec,
      status: 'claimed',
      workerAgentId,
      claimedAt: now,
      history: [...rec.history, event],
    }))
  })
}

/**
 * Deliver task result for a claimed offer
 */
export async function deliverTaskOffer(
  id: string,
  workerAgentId: string,
  result: Record<string, unknown>,
  options: { now?: number } = {}
): Promise<TaskOfferRecord> {
  if (!workerAgentId?.trim()) {
    throw new LifecycleError('Worker agentId is required to deliver result', 400, 'BAD_REQUEST')
  }

  return withOfferLock(id, () => {
    const offer = getTaskOffer(id)
    if (!offer) {
      throw new LifecycleError(`Task offer '${id}' not found`, 404, 'NOT_FOUND')
    }

    const now = options.now ?? Date.now()

    // 1. Authorization: Only assigned worker agent can deliver
    if (offer.workerAgentId !== workerAgentId) {
      throw new LifecycleError(
        `Unauthorized: only the assigned worker agent (${offer.workerAgentId || 'none'}) can deliver this task`,
        403,
        'FORBIDDEN',
        offer.status
      )
    }

    // 2. Status Validation
    if (offer.status !== 'claimed') {
      throw new LifecycleError(
        `Invalid state transition: cannot deliver offer in state '${offer.status}'`,
        409,
        'CONFLICT',
        offer.status
      )
    }

    // 3. Atomic Transition to 'delivered'
    const event: TaskOfferTransitionEvent = {
      fromStatus: 'claimed',
      toStatus: 'delivered',
      actor: workerAgentId,
      timestamp: now,
      note: 'Task delivery submitted by worker',
    }

    return updateTaskOffer(id, (rec) => ({
      ...rec,
      status: 'delivered',
      result: { ...result },
      deliveredAt: now,
      history: [...rec.history, event],
    }))
  })
}

/**
 * Accept delivery and release escrow reward (Only Poster Agent)
 */
export async function acceptTaskOffer(
  id: string,
  posterAgentId: string,
  options: { now?: number } = {}
): Promise<TaskOfferRecord> {
  if (!posterAgentId?.trim()) {
    throw new LifecycleError('Poster agentId is required to accept delivery', 400, 'BAD_REQUEST')
  }

  return withOfferLock(id, () => {
    const offer = getTaskOffer(id)
    if (!offer) {
      throw new LifecycleError(`Task offer '${id}' not found`, 404, 'NOT_FOUND')
    }

    const now = options.now ?? Date.now()

    // 1. Authorization: Only poster agent can accept delivery
    if (offer.posterAgentId !== posterAgentId) {
      throw new LifecycleError(
        `Unauthorized: only the poster agent (${offer.posterAgentId}) can accept delivery`,
        403,
        'FORBIDDEN',
        offer.status
      )
    }

    // 2. Check if already accepted (Escrow Released Only Once)
    if (offer.status === 'accepted' || offer.escrowReleased) {
      throw new LifecycleError(
        'Task offer has already been accepted and escrow was already released',
        409,
        'ALREADY_ACCEPTED',
        offer.status
      )
    }

    // 3. Status Validation: Must be delivered
    if (offer.status !== 'delivered') {
      throw new LifecycleError(
        `Invalid state transition: cannot accept offer in state '${offer.status}' (must be 'delivered')`,
        409,
        'CONFLICT',
        offer.status
      )
    }

    // 4. Atomic Transition to 'accepted' and single escrow release
    const event: TaskOfferTransitionEvent = {
      fromStatus: 'delivered',
      toStatus: 'accepted',
      actor: posterAgentId,
      timestamp: now,
      note: `Delivery accepted by ${posterAgentId}; escrow of ${offer.rewardAmount} ${offer.rewardAsset} released to ${offer.workerAgentId}`,
    }

    return updateTaskOffer(id, (rec) => ({
      ...rec,
      status: 'accepted',
      escrowReleased: true,
      releasedAt: now,
      acceptedAt: now,
      history: [...rec.history, event],
    }))
  })
}

/**
 * Dispute delivery and freeze escrow (Poster or Worker Agent)
 */
export async function disputeTaskOffer(
  id: string,
  actorAgentId: string,
  reason: string,
  options: { now?: number } = {}
): Promise<TaskOfferRecord> {
  if (!actorAgentId?.trim()) {
    throw new LifecycleError('Actor agentId is required to dispute offer', 400, 'BAD_REQUEST')
  }
  if (!reason?.trim()) {
    throw new LifecycleError('Dispute reason is required', 400, 'BAD_REQUEST')
  }

  return withOfferLock(id, () => {
    const offer = getTaskOffer(id)
    if (!offer) {
      throw new LifecycleError(`Task offer '${id}' not found`, 404, 'NOT_FOUND')
    }

    const now = options.now ?? Date.now()

    // 1. Authorization: Only poster or worker can dispute
    const isPoster = offer.posterAgentId === actorAgentId
    const isWorker = offer.workerAgentId === actorAgentId
    if (!isPoster && !isWorker) {
      throw new LifecycleError(
        'Unauthorized: only the poster or worker agent can raise a dispute',
        403,
        'FORBIDDEN',
        offer.status
      )
    }

    // 2. Status Validation: Cannot dispute already accepted or open offers
    if (offer.status === 'accepted') {
      throw new LifecycleError(
        'Cannot dispute a task offer that has already been accepted and settled',
        409,
        'CONFLICT',
        offer.status
      )
    }
    if (offer.status === 'open') {
      throw new LifecycleError(
        'Cannot dispute an open task offer that has not been claimed or delivered',
        409,
        'CONFLICT',
        offer.status
      )
    }
    if (offer.status === 'disputed') {
      throw new LifecycleError(
        'Task offer is already in dispute',
        409,
        'ALREADY_DISPUTED',
        offer.status
      )
    }

    // 3. Atomic Transition to 'disputed' with frozen escrow
    const event: TaskOfferTransitionEvent = {
      fromStatus: offer.status,
      toStatus: 'disputed',
      actor: actorAgentId,
      timestamp: now,
      note: `Dispute raised by ${actorAgentId}: ${reason}`,
    }

    return updateTaskOffer(id, (rec) => ({
      ...rec,
      status: 'disputed',
      disputeReason: reason,
      disputedBy: actorAgentId,
      disputedAt: now,
      escrowReleased: false, // Strictly frozen
      history: [...rec.history, event],
    }))
  })
}
