import { NextResponse } from "next/server"
import { BYOK_PROVIDERS, generateWithByokProvider, type ByokProviderId } from "@/lib/ai/byok-provider"
import { withOAuthCredentials } from "@/lib/connections/hydrate"
import { recordReceipt } from "@/lib/receipts/log"
import { resolveAgentOwner, scopedAgentKey } from "@/lib/solana/agent-owner"
import { agentTaskSystemPrompt } from "@/lib/solana/agent-task-prompt"
import { recordAgentPayment } from "@/lib/solana/payment-bindings"
import { AGENT_TASK_PRICE, attachPaymentResponse, explorerTxUrl, requirePayment } from "@/lib/solana/x402"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

type RouteContext = { params: Promise<{ id: string }> }

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

// A paid agent task: the caller pays the agent in USDC (x402, Solana devnet) and the agent
// answers with the model the caller connected. Everything is validated before charging.
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params
  const agentId = decodeURIComponent(id).slice(0, 80)

  const req = await withOAuthCredentials(request)
  if (req instanceof Response) return req
  const body = await req.clone().json().catch(() => null) as Record<string, unknown> | null
  const task = typeof body?.task === "string" ? body.task.trim() : ""
  if (!task || task.length > 2000) return json({ ok: false, error: "Describe the task in 1 to 2000 characters." }, 400)
  const agent = (body?.agent ?? {}) as Record<string, unknown>
  const connection = (agent.connection ?? {}) as Record<string, unknown>
  const provider = connection.provider as ByokProviderId
  const model = typeof connection.model === "string" ? connection.model.trim() : ""
  const apiKey = typeof connection.apiKey === "string" ? connection.apiKey.trim() : ""
  if (!(provider in BYOK_PROVIDERS) || !model || model.length > 180 || apiKey.length < 8) {
    return json({ ok: false, error: "Choose a connected model for this agent first." }, 400)
  }
  const name = typeof agent.name === "string" && agent.name.trim() ? agent.name.trim().slice(0, 80) : agentId
  const role = typeof agent.role === "string" && agent.role.trim() ? agent.role.trim().slice(0, 180) : "General assistant"

  const payment = await requirePayment(req, { price: AGENT_TASK_PRICE, description: `Task for agent ${name} in Agentic City` })
  if (!payment.ok) return payment.response

  // Remember which agent (of which owner) this payment was for: a review needs that binding.
  try {
    const owner = await resolveAgentOwner(req)
    await recordAgentPayment(payment.settle.transaction, scopedAgentKey(agentId, owner?.tag ?? null))
  } catch (error) {
    console.error("[x402] could not record the payment binding:", error instanceof Error ? error.message : error)
  }

  // Public receipts log (best-effort, never throws): no task text, only public facts.
  await recordReceipt({
    type: "payment",
    tx: payment.settle.transaction,
    amount: payment.requirements.amount,
    asset: payment.requirements.asset,
    agentId,
    agentName: name,
    payer: payment.payer,
  })

  const receipt = {
    transaction: payment.settle.transaction,
    network: payment.settle.network,
    payer: payment.payer,
    amount: payment.requirements.amount,
    asset: payment.requirements.asset,
    explorerUrl: explorerTxUrl(payment.settle.transaction),
  }

  try {
    const output = await generateWithByokProvider(
      { provider, model, apiKey },
      agentTaskSystemPrompt(name, role),
      task,
    )
    return attachPaymentResponse(json({ ok: true, agentId, result: output, receipt }), payment.settle)
  } catch (error) {
    // The payment already settled: return the receipt so the user can see what happened.
    return attachPaymentResponse(json({ ok: false, agentId, error: error instanceof Error ? error.message : "The agent could not complete the task.", receipt }, 502), payment.settle)
  }
}
