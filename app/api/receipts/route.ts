import { NextResponse } from "next/server"
import { parseFilters, queryReceipts } from "@/lib/receipts/query"
import { getReceiptsSnapshot } from "@/lib/receipts/snapshot"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

// Public receipts: every x402 payment, agent-to-agent hire and 8004 registration or review this
// app caused on Solana devnet, plus older treasury activity read back from the chain.
// GET /api/receipts?type=payment|hire|registration|review&agent=<id or name>&page=1&pageSize=25
export async function GET(request: Request) {
  const filters = parseFilters(new URL(request.url).searchParams)
  const snapshot = await getReceiptsSnapshot()
  const result = queryReceipts(snapshot.records, filters)
  return NextResponse.json(
    { ok: true, network: "solana:devnet", filters, ...result, sources: snapshot.sources, updatedAt: new Date(snapshot.updatedAt).toISOString() },
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30" } },
  )
}
