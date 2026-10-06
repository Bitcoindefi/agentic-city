import { describe, it, expect, beforeEach } from 'vitest'
import {
  putTaskOffer,
  getTaskOffer,
  resetTaskOfferStoreForTests,
} from '@/lib/task-offers/store'
import {
  claimTaskOffer,
  deliverTaskOffer,
  acceptTaskOffer,
  disputeTaskOffer,
  LifecycleError,
} from '@/lib/task-offers/lifecycle'

describe('Task Offer Lifecycle & Concurrency Test Suite', () => {
  const offerId = 'offer-101'
  const posterAgentId = 'agent-alice'
  const workerAgentId = 'agent-bob'
  const intruderAgentId = 'agent-charlie'

  beforeEach(() => {
    resetTaskOfferStoreForTests()
    putTaskOffer({
      id: offerId,
      title: 'Analyze network congestion telemetry',
      requiredCapability: 'Network Analysis',
      rewardAmount: 50,
      rewardAsset: 'XLM',
      deadline: new Date(Date.now() + 3_600_000).toISOString(), // 1 hour in future
      status: 'open',
      posterAgentId,
      payload: { logsUrl: 'https://logs.stellar.org/testnet/101' },
    })
  })

  describe('1. Concurrent Claims (Claim concurrente da un ganador)', () => {
    it('allows only ONE winner when two agents claim concurrently, rejecting the second with 409', async () => {
      // Trigger two concurrent claim requests simultaneously
      const claim1 = claimTaskOffer(offerId, workerAgentId)
      const claim2 = claimTaskOffer(offerId, intruderAgentId)

      const results = await Promise.allSettled([claim1, claim2])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)

      const winningRecord = (fulfilled[0] as PromiseFulfilledResult<any>).value
      expect(winningRecord.status).toBe('claimed')
      expect(['agent-bob', 'agent-charlie']).toContain(winningRecord.workerAgentId)

      const error = (rejected[0] as PromiseRejectedResult).reason as LifecycleError
      expect(error).toBeInstanceOf(LifecycleError)
      expect(error.statusCode).toBe(409)
      expect(error.message).toContain("cannot claim offer in state 'claimed'")
    })
  })

  describe('2. Delivery Authorization (Deliver de un tercero se rechaza)', () => {
    beforeEach(async () => {
      await claimTaskOffer(offerId, workerAgentId)
    })

    it('rejects delivery from a third-party intruder with 403 Forbidden', async () => {
      await expect(
        deliverTaskOffer(offerId, intruderAgentId, { resultSummary: 'Hacked output' })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: expect.stringContaining('Unauthorized: only the assigned worker agent'),
      })

      // Ensure offer remains in claimed state and result is not modified
      const current = getTaskOffer(offerId)
      expect(current?.status).toBe('claimed')
      expect(current?.result).toBeNull()
    })

    it('allows assigned worker agent to deliver task result successfully', async () => {
      const delivered = await deliverTaskOffer(offerId, workerAgentId, {
        metricsAnalyzed: 1000,
        threatsFound: 0,
      })
      expect(delivered.status).toBe('delivered')
      expect(delivered.result).toEqual({ metricsAnalyzed: 1000, threatsFound: 0 })
      expect(delivered.deliveredAt).toBeDefined()
    })
  })

  describe('3. Idempotent Escrow Release (Accept doble paga una vez)', () => {
    beforeEach(async () => {
      await claimTaskOffer(offerId, workerAgentId)
      await deliverTaskOffer(offerId, workerAgentId, { status: 'complete' })
    })

    it('releases escrow on first accept and strictly rejects second accept with 409', async () => {
      // First accept succeeds
      const accepted = await acceptTaskOffer(offerId, posterAgentId)
      expect(accepted.status).toBe('accepted')
      expect(accepted.escrowReleased).toBe(true)
      expect(accepted.releasedAt).toBeDefined()

      // Second accept must fail and cannot release escrow again
      await expect(acceptTaskOffer(offerId, posterAgentId)).rejects.toMatchObject({
        statusCode: 409,
        code: 'ALREADY_ACCEPTED',
        message: expect.stringContaining('already been accepted and escrow was already released'),
      })

      const finalRecord = getTaskOffer(offerId)
      expect(finalRecord?.status).toBe('accepted')
      expect(finalRecord?.escrowReleased).toBe(true)
    })

    it('rejects accept from an agent other than the poster with 403', async () => {
      await expect(acceptTaskOffer(offerId, intruderAgentId)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: expect.stringContaining('only the poster agent'),
      })
    })
  })

  describe('4. Dispute Freezes Escrow (Dispute congela el reward)', () => {
    beforeEach(async () => {
      await claimTaskOffer(offerId, workerAgentId)
      await deliverTaskOffer(offerId, workerAgentId, { status: 'invalid output' })
    })

    it('flags dispute and strictly freezes escrow reward', async () => {
      const disputed = await disputeTaskOffer(
        offerId,
        posterAgentId,
        'Delivered result does not meet task specification'
      )

      expect(disputed.status).toBe('disputed')
      expect(disputed.disputeReason).toBe('Delivered result does not meet task specification')
      expect(disputed.disputedBy).toBe(posterAgentId)
      expect(disputed.escrowReleased).toBe(false) // Reward is frozen!

      // Worker cannot deliver again while in dispute
      await expect(
        deliverTaskOffer(offerId, workerAgentId, { attempt: 2 })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      })

      // Poster cannot accept while in dispute
      await expect(acceptTaskOffer(offerId, posterAgentId)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      })
    })
  })

  describe('5. Invalid State Transitions (Transición inválida da 409, no 500)', () => {
    it('returns 409 when attempting to deliver an unclaimed open offer', async () => {
      await expect(
        deliverTaskOffer(offerId, workerAgentId, { data: 'test' })
      ).rejects.toMatchObject({
        statusCode: 403, // Not assigned yet
      })
    })

    it('returns 409 when attempting to accept an offer before delivery', async () => {
      await claimTaskOffer(offerId, workerAgentId)

      await expect(acceptTaskOffer(offerId, posterAgentId)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
        message: expect.stringContaining("cannot accept offer in state 'claimed'"),
      })
    })

    it('returns 409 when attempting to dispute an open offer', async () => {
      await expect(
        disputeTaskOffer(offerId, posterAgentId, 'Premature dispute')
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
        message: expect.stringContaining('Cannot dispute an open task offer'),
      })
    })
  })

  describe('6. Expiration Blocking (El vencimiento bloquea el claim)', () => {
    it('rejects claim with 409 when deadline has expired', async () => {
      const expiredOfferId = 'offer-expired'
      putTaskOffer({
        id: expiredOfferId,
        title: 'Legacy telemetry ingestion',
        requiredCapability: 'Data Ingestion',
        rewardAmount: 20,
        rewardAsset: 'XLM',
        deadline: new Date(Date.now() - 60_000).toISOString(), // 1 minute in the past
        status: 'open',
        posterAgentId,
      })

      await expect(claimTaskOffer(expiredOfferId, workerAgentId)).rejects.toMatchObject({
        statusCode: 409,
        code: 'OFFER_EXPIRED',
        message: expect.stringContaining('has expired and cannot be claimed'),
      })

      const record = getTaskOffer(expiredOfferId)
      expect(record?.status).toBe('expired')
    })
  })

  describe('7. Audit Trail & Event Logging', () => {
    it('records full transition history across complete lifecycle', async () => {
      await claimTaskOffer(offerId, workerAgentId)
      await deliverTaskOffer(offerId, workerAgentId, { output: 'success' })
      const accepted = await acceptTaskOffer(offerId, posterAgentId)

      expect(accepted.history.length).toBe(3)
      expect(accepted.history[0]).toMatchObject({
        fromStatus: 'open',
        toStatus: 'claimed',
        actor: workerAgentId,
      })
      expect(accepted.history[1]).toMatchObject({
        fromStatus: 'claimed',
        toStatus: 'delivered',
        actor: workerAgentId,
      })
      expect(accepted.history[2]).toMatchObject({
        fromStatus: 'delivered',
        toStatus: 'accepted',
        actor: posterAgentId,
      })
    })
  })
})
