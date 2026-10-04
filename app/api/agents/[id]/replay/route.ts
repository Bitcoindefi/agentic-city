import { NextResponse } from "next/server"
import { AGENT_REPLAY_LIMIT, clearAgentReplay, getAgentReplay } from "@/lib/events/agent-replay"

interface RouteContext {
  params: Promise<{ id: string }>
}

// The central middleware preserves public agent reads and requires agents:write
// for DELETE. Never cache replay responses.
export async function GET(_req: Request, context: RouteContext) {
  const { id: agentId } = await context.params
  const events = getAgentReplay(agentId)
  return NextResponse.json(
    { agentId, events, bufferSize: AGENT_REPLAY_LIMIT, count: events.length },
    { headers: { "Cache-Control": "no-store" } },
  )
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id: agentId } = await context.params
  clearAgentReplay(agentId)
  return NextResponse.json(
    { agentId, events: [], bufferSize: AGENT_REPLAY_LIMIT, count: 0 },
    { headers: { "Cache-Control": "no-store" } },
  )
}
