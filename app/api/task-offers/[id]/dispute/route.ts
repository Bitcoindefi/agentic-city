import { NextResponse } from 'next/server'
import { disputeTaskOffer, LifecycleError } from '@/lib/task-offers/lifecycle'
import { toPublicTaskOffer } from '@/lib/task-offers/store'
import { apiError } from '@/lib/api/error'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    const offerId = decodeURIComponent(id)

    const body = await req.json().catch(() => ({}))
    const actorAgentId = body.agentId || body.actorAgentId
    const reason = body.reason

    if (!actorAgentId) {
      return apiError('Missing required agentId in request body', 'BAD_REQUEST', 400)
    }
    if (!reason?.trim()) {
      return apiError('Missing required reason for dispute', 'BAD_REQUEST', 400)
    }

    const updated = await disputeTaskOffer(offerId, actorAgentId, reason)
    return NextResponse.json({
      ok: true,
      offer: toPublicTaskOffer(updated),
      disputed: true,
      frozenEscrow: {
        amount: updated.rewardAmount,
        asset: updated.rewardAsset,
        status: 'frozen_pending_arbitration',
      },
    })
  } catch (error) {
    if (error instanceof LifecycleError) {
      return apiError(error.message, error.code, error.statusCode)
    }
    return apiError((error as Error).message || 'Failed to dispute task offer', 'INTERNAL', 500)
  }
}
