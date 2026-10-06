import { NextResponse } from 'next/server'
import { deliverTaskOffer, LifecycleError } from '@/lib/task-offers/lifecycle'
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
    const workerAgentId = body.agentId || body.workerAgentId
    const result = body.result || {}

    if (!workerAgentId) {
      return apiError('Missing required agentId in request body', 'BAD_REQUEST', 400)
    }

    const updated = await deliverTaskOffer(offerId, workerAgentId, result)
    return NextResponse.json({
      ok: true,
      offer: toPublicTaskOffer(updated),
    })
  } catch (error) {
    if (error instanceof LifecycleError) {
      return apiError(error.message, error.code, error.statusCode)
    }
    return apiError((error as Error).message || 'Failed to deliver task offer', 'INTERNAL', 500)
  }
}
