import { NextResponse } from "next/server"

import { listRegisteredAgents } from "@/lib/agent-registry"
import { isAuthorized } from "@/lib/auth"
import { sendRawEmail } from "@/lib/email/resend"
import { buildAgentWeeklySummary, renderWeeklySummaryEmail } from "@/lib/email/weekly-summary"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  const nowHeader = req.headers.get("x-open-stellar-now")
  const now = nowHeader ? new Date(nowHeader) : new Date()
  if (Number.isNaN(now.getTime())) {
    return NextResponse.json({ ok: false, error: "Invalid x-open-stellar-now header" }, { status: 400 })
  }

  const agents = listRegisteredAgents()
  const allAgentIds = agents.map((agent) => agent.agentId)
  const results = []

  for (const agent of agents) {
    if (!agent.email) {
      results.push({ agentId: agent.agentId, skipped: true, reason: "agent has no email on file" })
      continue
    }

    if (agent.emailOptOut) {
      results.push({ agentId: agent.agentId, to: agent.email, skipped: true, reason: "agent opted out of email" })
      continue
    }

    const summary = buildAgentWeeklySummary(agent.agentId, agent.agentId, allAgentIds, now)
    const email = renderWeeklySummaryEmail(summary)
    const result = await sendRawEmail({ to: agent.email, ...email })
    results.push({ agentId: agent.agentId, to: agent.email, ...result })
  }

  return NextResponse.json({ ok: true, results }, { headers: { "Cache-Control": "no-store" } })
}
