import { RECEIPT_TYPES, type ReceiptRecord, type ReceiptType } from "@/lib/receipts/log"

// Pure helpers behind GET /api/receipts: merge the app log with the on-chain backfill,
// filter, paginate and count.

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export type ReceiptFilters = { type: ReceiptType | "all"; agent: string | null; page: number; pageSize: number }

export type ReceiptTotals = {
  /** x402 payments settled, direct tasks and hires alike (one per transaction). */
  payments: number
  volumeUsdc: number
  hires: number
  reviews: number
  registrations: number
  uniquePayers: number
}

export type AgentOption = { id: string; name: string }

export type ReceiptPage = {
  receipts: ReceiptRecord[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  totals: ReceiptTotals
  agents: AgentOption[]
}

function toInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function parseFilters(params: URLSearchParams): ReceiptFilters {
  const rawType = (params.get("type") ?? "all").trim().toLowerCase()
  const type = (RECEIPT_TYPES as readonly string[]).includes(rawType) ? rawType as ReceiptType : "all"
  const agent = (params.get("agent") ?? "").trim().slice(0, 80) || null
  const page = Math.max(1, toInt(params.get("page"), 1))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, toInt(params.get("pageSize"), DEFAULT_PAGE_SIZE)))
  return { type, agent, page, pageSize }
}

/**
 * One list, newest first. The app log wins over the chain for the same transaction (it knows the
 * agent), and a hire wins over the plain payment the hired agent's endpoint recorded for it.
 */
export function mergeReceipts(appLog: ReceiptRecord[], onchain: ReceiptRecord[]): ReceiptRecord[] {
  const hiredTx = new Set(appLog.filter((record) => record.type === "hire").map((record) => record.tx))
  const seen = new Set<string>()
  const merged: ReceiptRecord[] = []
  for (const record of appLog) {
    if (record.type === "payment" && hiredTx.has(record.tx)) continue
    if (seen.has(record.id)) continue
    seen.add(record.id)
    merged.push(record)
  }
  const appTx = new Set(appLog.map((record) => record.tx))
  for (const record of onchain) {
    if (appTx.has(record.tx) || seen.has(record.id)) continue
    seen.add(record.id)
    merged.push(record)
  }
  return merged.sort((a, b) => b.timestamp - a.timestamp)
}

export function matchesAgent(record: ReceiptRecord, agent: string | null): boolean {
  if (!agent) return true
  const wanted = agent.toLowerCase()
  return [record.agentId, record.agentName, record.counterpartId, record.counterpartName]
    .some((value) => value !== null && value.toLowerCase() === wanted)
}

export function computeTotals(records: ReceiptRecord[]): ReceiptTotals {
  let payments = 0
  let hires = 0
  let reviews = 0
  let registrations = 0
  let volumeMicro = BigInt(0)
  const payers = new Set<string>()
  for (const record of records) {
    if (record.type === "payment" || record.type === "hire") {
      payments += 1
      if (record.type === "hire") hires += 1
      if (record.amount && record.asset === "USDC") volumeMicro += BigInt(record.amount)
      if (record.payer) payers.add(record.payer)
    } else if (record.type === "review") {
      reviews += 1
    } else {
      registrations += 1
    }
  }
  return { payments, volumeUsdc: Number(volumeMicro) / 1_000_000, hires, reviews, registrations, uniquePayers: payers.size }
}

/** Every agent named in the records, for the filter: by id, with its latest name. */
export function listAgents(records: ReceiptRecord[]): AgentOption[] {
  const byId = new Map<string, string>()
  const add = (id: string | null, name: string | null) => {
    if (!id || byId.has(id)) return
    byId.set(id, name ?? id)
  }
  for (const record of records) {
    add(record.agentId, record.agentName)
    add(record.counterpartId, record.counterpartName)
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Filters and paginates. Totals follow the agent filter (not the type one), so the cards stay meaningful. */
export function queryReceipts(all: ReceiptRecord[], filters: ReceiptFilters): ReceiptPage {
  const forAgent = all.filter((record) => matchesAgent(record, filters.agent))
  const filtered = filters.type === "all" ? forAgent : forAgent.filter((record) => record.type === filters.type)
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))
  const page = Math.min(filters.page, totalPages)
  const start = (page - 1) * filters.pageSize
  return {
    receipts: filtered.slice(start, start + filters.pageSize),
    page,
    pageSize: filters.pageSize,
    total,
    totalPages,
    totals: computeTotals(forAgent),
    agents: listAgents(all),
  }
}
