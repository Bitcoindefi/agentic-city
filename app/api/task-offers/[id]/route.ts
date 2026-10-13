import { NextResponse } from "next/server"
import { cancelTaskOffer, getTaskOffer } from "@/lib/task-market/offers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ id: string }>
}

function actorFromRequest(req: Request): string {
  const url = new URL(req.url)
  return String(req.headers.get("x-agent-id") ?? url.searchParams.get("agentId") ?? "").trim()
}

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params
  const offer = getTaskOffer(decodeURIComponent(id))
  if (!offer) {
    return NextResponse.json(
      { ok: false, error: "Task offer not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    )
  }

  return NextResponse.json({ ok: true, offer }, { headers: { "Cache-Control": "no-store" } })
}

export async function DELETE(req: Request, context: RouteContext) {
  const { id } = await context.params
  const actorId = actorFromRequest(req)
  if (!actorId) {
    return NextResponse.json(
      { ok: false, error: "agentId is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  try {
    const offer = cancelTaskOffer(decodeURIComponent(id), actorId)
    return NextResponse.json({ ok: true, offer, refundTx: offer.refundTx }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to cancel task offer"
    let status = 400
    if (message.includes("not found")) {
      status = 404
    } else if (message.includes("Only the poster")) {
      status = 403
    }
    return NextResponse.json(
      { ok: false, error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    )
  }
}
