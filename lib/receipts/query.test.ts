import { describe, expect, it } from "vitest"
import { sanitizeReceipt, type ReceiptInput, type ReceiptRecord } from "@/lib/receipts/log"
import { computeTotals, listAgents, matchesAgent, mergeReceipts, parseFilters, queryReceipts } from "@/lib/receipts/query"

const sig = (c: string, n = 88) => c.repeat(n)
const PAYER_A = "Bp6mXwYzAbCdEfGhJkLmNpQrStUvWxYz12345678abcd"
const PAYER_B = "4TiFXwYzAbCdEfGhJkLmNpQrStUvWxYz12345678abcd"

function rec(input: ReceiptInput): ReceiptRecord {
  const record = sanitizeReceipt(input)
  if (!record) throw new Error("invalid fixture")
  return record
}

describe("parseFilters", () => {
  it("defaults, clamps and ignores unknown values", () => {
    expect(parseFilters(new URLSearchParams())).toEqual({ type: "all", agent: null, page: 1, pageSize: 25 })
    expect(parseFilters(new URLSearchParams("type=HIRE&agent=%20research%20&page=3&pageSize=500"))).toEqual({ type: "hire", agent: "research", page: 3, pageSize: 100 })
    expect(parseFilters(new URLSearchParams("type=refund&page=-2&pageSize=abc"))).toEqual({ type: "all", agent: null, page: 1, pageSize: 25 })
    expect(parseFilters(new URLSearchParams("pageSize=0")).pageSize).toBe(1)
  })
})

describe("mergeReceipts", () => {
  it("prefers the app log, lets a hire replace its payment and sorts newest first", () => {
    const app = [
      rec({ type: "hire", tx: sig("2"), amount: "10000", agentId: "research", agentName: "Investigador", counterpartId: "orchestrator", counterpartName: "Supervisor", payer: PAYER_A, timestamp: 300 }),
      rec({ type: "payment", tx: sig("2"), amount: "10000", agentId: "research", timestamp: 299 }),
      rec({ type: "payment", tx: sig("3"), amount: "10000", agentId: "writer", payer: PAYER_B, timestamp: 100 }),
      rec({ type: "payment", tx: sig("3"), amount: "10000", agentId: "writer", payer: PAYER_B, timestamp: 100 }),
    ]
    const chain = [
      rec({ type: "payment", tx: sig("2"), amount: "10000", source: "on-chain", timestamp: 300 }),
      rec({ type: "payment", tx: sig("4"), amount: "20000", payer: PAYER_B, source: "on-chain", timestamp: 200 }),
      rec({ type: "payment", tx: sig("4"), amount: "20000", payer: PAYER_B, source: "on-chain", timestamp: 200 }),
      rec({ type: "registration", tx: sig("5"), source: "on-chain", timestamp: 50 }),
    ]
    const merged = mergeReceipts(app, chain)
    expect(merged.map((record) => `${record.type}:${record.tx[0]}:${record.source}`)).toEqual([
      "hire:2:app", "payment:4:on-chain", "payment:3:app", "registration:5:on-chain",
    ])
  })
})

describe("totals, agents and queries", () => {
  const all = mergeReceipts([
    rec({ type: "hire", tx: sig("2"), amount: "10000", agentId: "research", agentName: "Investigador", counterpartId: "orchestrator", counterpartName: "Supervisor", payer: PAYER_A, timestamp: 600 }),
    rec({ type: "payment", tx: sig("3"), amount: "10000", agentId: "research", agentName: "Investigador", payer: PAYER_B, timestamp: 500 }),
    rec({ type: "review", tx: sig("4"), agentId: "research", payer: PAYER_B, score: 100, timestamp: 400 }),
    rec({ type: "registration", tx: sig("5"), agentId: "writer", agentName: "Redactor", timestamp: 300 }),
    rec({ type: "payment", tx: sig("6"), amount: "25000", payer: PAYER_B, source: "on-chain", timestamp: 200 }),
    rec({ type: "payment", tx: sig("7"), amount: "5", asset: PAYER_A, timestamp: 100 }),
  ], [])

  it("counts payments (hires included), USDC volume and unique payers", () => {
    expect(computeTotals(all)).toEqual({ payments: 4, volumeUsdc: 0.045, hires: 1, reviews: 1, registrations: 1, uniquePayers: 2 })
    expect(computeTotals([])).toEqual({ payments: 0, volumeUsdc: 0, hires: 0, reviews: 0, registrations: 0, uniquePayers: 0 })
  })

  it("lists agents by id with their names, hirers included", () => {
    expect(listAgents(all)).toEqual([
      { id: "research", name: "Investigador" },
      { id: "writer", name: "Redactor" },
      { id: "orchestrator", name: "Supervisor" },
    ])
  })

  it("matches an agent by id or name, as hired agent or hirer, ignoring case", () => {
    expect(matchesAgent(all[0], "INVESTIGADOR")).toBe(true)
    expect(matchesAgent(all[0], "supervisor")).toBe(true)
    expect(matchesAgent(all[0], "writer")).toBe(false)
    expect(matchesAgent(all[0], null)).toBe(true)
  })

  it("filters by type and agent, paginates, and keeps totals to the agent filter", () => {
    const research = queryReceipts(all, { type: "all", agent: "research", page: 1, pageSize: 2 })
    expect(research).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 })
    expect(research.receipts.map((record) => record.type)).toEqual(["hire", "payment"])
    expect(research.totals).toMatchObject({ payments: 2, reviews: 1, registrations: 0 })
    expect(research.agents).toHaveLength(3)

    const page2 = queryReceipts(all, { type: "all", agent: "research", page: 2, pageSize: 2 })
    expect(page2.receipts.map((record) => record.type)).toEqual(["review"])
    // Past the end: the last page.
    expect(queryReceipts(all, { type: "all", agent: "research", page: 9, pageSize: 2 }).page).toBe(2)

    const payments = queryReceipts(all, { type: "payment", agent: null, page: 1, pageSize: 25 })
    expect(payments.total).toBe(3)
    expect(payments.totals.payments).toBe(4)

    const none = queryReceipts(all, { type: "review", agent: "nobody", page: 1, pageSize: 25 })
    expect(none).toMatchObject({ total: 0, totalPages: 1, page: 1, receipts: [] })
  })
})
