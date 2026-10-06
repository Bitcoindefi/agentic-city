import { NextResponse } from "next/server"
import { createTaskOffer, listTaskOffers } from "@/lib/task-market/offers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const requiredCapability = url.searchParams.get("cap")?.trim() || undefined
  const includeExpired = url.searchParams.get("includeExpired") === "1"

  return NextResponse.json(
    {
      ok: true,
      offers: listTaskOffers({ requiredCapability, includeExpired }),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const offer = createTaskOffer({
      postedBy: String(body.postedBy ?? req.headers.get("x-agent-id") ?? ""),
      requiredCapability: String(body.requiredCapability ?? ""),
      payload: body.payload && typeof body.payload === "object" ? body.payload : {},
      reward: body.reward,
      deadline: Number(body.deadline),
    })

    return NextResponse.json(
      { ok: true, offerId: offer.offerId, escrowTx: offer.escrowTx, offer },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to create task offer" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }
}
