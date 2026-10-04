import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET } from "@/app/api/receipts/route"
import { createMemoryReceiptBackend, recordReceipt, setReceiptBackendForTests } from "@/lib/receipts/log"
import { resetReceiptsSnapshotForTests } from "@/lib/receipts/snapshot"
import { isPublicApiRoute } from "@/lib/auth/middleware"

const sig = (c: string) => c.repeat(88)

describe("GET /api/receipts", () => {
  const env = { ...process.env }
  beforeEach(async () => {
    // No chain reads in unit tests: the backfill is covered in lib/receipts/onchain.test.ts.
    process.env.RECEIPTS_ONCHAIN_BACKFILL = "off"
    delete process.env.KV_REST_API_URL
    delete process.env.UPSTASH_REDIS_REST_URL
    const backend = createMemoryReceiptBackend()
    setReceiptBackendForTests(backend)
    resetReceiptsSnapshotForTests()
    await recordReceipt({ type: "registration", tx: sig("2"), agentId: "research", agentName: "Investigador", timestamp: 100 })
    await recordReceipt({ type: "payment", tx: sig("3"), amount: "10000", agentId: "research", agentName: "Investigador", timestamp: 200 })
    await recordReceipt({ type: "hire", tx: sig("4"), amount: "10000", agentId: "writer", agentName: "Redactor", counterpartId: "research", counterpartName: "Investigador", timestamp: 300 })
    await recordReceipt({ type: "review", tx: sig("5"), agentId: "writer", score: 90, timestamp: 400 })
  })
  afterEach(() => {
    process.env = { ...env }
    setReceiptBackendForTests(null)
    resetReceiptsSnapshotForTests()
  })

  it("is public and cached about 10 seconds at the edge", async () => {
    expect(isPublicApiRoute("/api/receipts", "GET")).toBe(true)
    expect(isPublicApiRoute("/api/receipts", "POST")).toBe(false)
    const res = await GET(new Request("https://agentic-city.test/api/receipts"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=10, stale-while-revalidate=30")
    const data = await res.json()
    expect(data).toMatchObject({ ok: true, network: "solana:devnet", total: 4, page: 1, totalPages: 1, sources: { app: 4, onchain: 0 } })
    expect(data.receipts.map((item: { type: string }) => item.type)).toEqual(["review", "hire", "payment", "registration"])
    expect(data.totals).toEqual({ payments: 2, volumeUsdc: 0.02, hires: 1, reviews: 1, registrations: 1, uniquePayers: 0 })
    expect(typeof data.updatedAt).toBe("string")
  })

  it("filters by type and agent and paginates", async () => {
    const hires = await (await GET(new Request("https://agentic-city.test/api/receipts?type=hire"))).json()
    expect(hires.receipts).toHaveLength(1)
    expect(hires.filters).toEqual({ type: "hire", agent: null, page: 1, pageSize: 25 })

    const research = await (await GET(new Request("https://agentic-city.test/api/receipts?agent=Investigador&pageSize=2&page=2"))).json()
    expect(research).toMatchObject({ total: 3, page: 2, totalPages: 2 })
    expect(research.receipts.map((item: { tx: string }) => item.tx[0])).toEqual(["2"])
    expect(research.totals).toMatchObject({ payments: 2, registrations: 1, reviews: 0 })
    expect(research.agents.map((item: { id: string }) => item.id)).toEqual(["research", "writer"])
  })
})
