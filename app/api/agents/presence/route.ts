import { NextResponse } from "next/server"
import { getBulkAgentPresence } from "@/lib/agents/agent-health-store"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const allIdsParams = url.searchParams.getAll("ids")

  let ids: string[] = []
  for (const param of allIdsParams) {
    if (!param) continue
    const parts = param.split(",").map((p) => decodeURIComponent(p).trim()).filter(Boolean)
    ids.push(...parts)
  }

  // Deduplicate preserving insertion order
  ids = Array.from(new Set(ids))

  if (ids.length > 50) {
    return NextResponse.json(
      { ok: false, error: "Maximum of 50 agent IDs allowed per request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  if (ids.length === 0) {
    return NextResponse.json(
      {},
      { status: 200, headers: { "Cache-Control": "no-store" } },
    )
  }

  const nowParam = url.searchParams.get("now")
  const nowMs = nowParam
    ? (Number.isFinite(Number(nowParam)) ? Number(nowParam) : Date.parse(nowParam))
    : Date.now()

  const presenceMap = getBulkAgentPresence(ids, nowMs)

  return NextResponse.json(presenceMap, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  })
}
