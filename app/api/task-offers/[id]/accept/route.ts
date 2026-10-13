import { NextResponse } from 'next/server'
import { acceptTaskOffer, LifecycleError } from '@/lib/task-offers/lifecycle'
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
    const posterAgentId = body.agentId || body.posterAgentId

    if (!posterAgentId) {
      return apiError('Missing required agentId in request body', 'BAD_REQUEST', 400)
    }

    const updated = await acceptTaskOffer(offerId, posterAgentId)
    return NextResponse.json({
      ok: true,
      offer: toPublicTaskOffer(updated),
      settled: true,
      releasedEscrow: {
        amount: updated.rewardAmount,
        asset: updated.rewardAsset,
        recipient: updated.workerAgentId,
      },
    })
  } catch (error) {
    if (error instanceof LifecycleError) {
      return apiError(error.message, error.code, error.statusCode)
    }
    return apiError((error as Error).message || 'Failed to accept task offer', 'INTERNAL', 500)
  }
}
