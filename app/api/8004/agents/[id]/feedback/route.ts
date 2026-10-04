import { NextResponse } from "next/server"
import { isStrictSameOrigin } from "@/lib/connections/hydrate"
import { createRpc } from "@/lib/receipts/onchain"
import { confirmReview, rememberPendingReview } from "@/lib/receipts/review-confirm"
import { IdentityError, getRpcUrl, prepareFeedback } from "@/lib/solana/agent-identity"
import { resolveAgentOwner } from "@/lib/solana/agent-owner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

type RouteContext = { params: Promise<{ id: string }> }

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

// Returns a review transaction (already signed by the treasury as fee payer) for the payer's
// wallet to sign and send. Requires proof of an x402 payment to this agent, one review each.
// With `{ reviewSignature }` instead, the browser reports the review it sent: once the chain
// confirms it, it goes into the public receipts log (see lib/receipts/review-confirm.ts).
export async function POST(req: Request, context: RouteContext) {
  if (!isStrictSameOrigin(req)) return json({ ok: false, error: "Cross-site requests are not allowed." }, 403)
  const { id } = await context.params
  const agentId = decodeURIComponent(id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  if (typeof body.reviewSignature === "string") {
    const result = await confirmReview(body.reviewSignature.trim(), agentId, { rpc: createRpc(getRpcUrl()) })
    return result.ok ? json({ ok: true, recorded: result.recorded }) : json({ ok: false, error: result.error }, result.status)
  }

  const paymentSignature = typeof body.paymentSignature === "string" ? body.paymentSignature.trim() : ""
  const payer = typeof body.payer === "string" ? body.payer.trim() : ""
  const score = typeof body.score === "number" ? body.score : Number.NaN
  if (!paymentSignature || !payer) return json({ ok: false, error: "A paid task is required to leave a review." }, 400)
  try {
    const owner = await resolveAgentOwner(req)
    const prepared = await prepareFeedback({ agentId, ownerTag: owner?.tag ?? null, score, paymentSignature, payer })
    const agentName = typeof body.agentName === "string" ? body.agentName : null
    await rememberPendingReview(prepared.transaction, { agentId, agentName, payer, score })
    return json({ ok: true, ...prepared })
  } catch (error) {
    if (error instanceof IdentityError) return json({ ok: false, error: error.message }, error.status)
    console.error("[8004] could not prepare review:", error instanceof Error ? error.message : error)
    return json({ ok: false, error: "Could not prepare the review." }, 502)
  }
}
