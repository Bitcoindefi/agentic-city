import { getRedisConfig } from "@/lib/security/kv-store"
import { USDC_DEVNET_MINT } from "@/lib/solana/payment-constants"

// Public receipts log: one small, non-sensitive record per on-chain event the app causes
// (x402 payment settled, agent-to-agent hire paid, 8004 identity registered, 8004 review sent).
// It feeds the public explorer at /explorer and GET /api/receipts.
//
// Only public facts go in: the transaction signature, the amount, the agent's public id and
// name, a short payer address and the time. Never prompts, task text, keys or owner ids:
// sanitizeReceipt() builds each record field by field, so anything else a caller passes is dropped.
//
// Writes are best-effort: recordReceipt() never throws and gives up after a short timeout,
// because a payment that already settled must not fail over a log line.

export const RECEIPTS_KEY = "ac:receipts:v1"
export const RECEIPTS_CAP = 500
export const RECEIPT_NETWORK = "solana:devnet"
const WRITE_TIMEOUT_MS = 2_000

export type ReceiptType = "payment" | "hire" | "registration" | "review"
export const RECEIPT_TYPES: readonly ReceiptType[] = ["payment", "hire", "registration", "review"]
export type ReceiptSource = "app" | "on-chain"

export type ReceiptRecord = {
  /** `${type}:${tx}`: one record per event. */
  id: string
  type: ReceiptType
  /** Solana transaction signature. */
  tx: string
  network: string
  /** Amount in the asset's base units (USDC has 6 decimals), or null when nothing was paid. */
  amount: string | null
  asset: string | null
  /** The agent's public id (the hired agent, for a hire). */
  agentId: string | null
  agentName: string | null
  /** For a hire: the agent that hired. */
  counterpartId: string | null
  counterpartName: string | null
  /** Short payer address ("AbCd…WxYz"). */
  payer: string | null
  /** 8004 asset address of the agent identity, for registrations. */
  identity: string | null
  /** 0-100 review score. */
  score: number | null
  /** Milliseconds since the epoch. */
  timestamp: number
  source: ReceiptSource
}

export type ReceiptInput = {
  type: ReceiptType
  tx: string
  amount?: string | number | bigint | null
  asset?: string | null
  agentId?: string | null
  agentName?: string | null
  counterpartId?: string | null
  counterpartName?: string | null
  payer?: string | null
  identity?: string | null
  score?: number | null
  timestamp?: number
  source?: ReceiptSource
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SHORT_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/

export function isSignature(value: unknown): value is string {
  return typeof value === "string" && SIGNATURE.test(value)
}

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value)
}

/** "F8HEGS2w...p5h" style: first 4 and last 4 characters. Already short addresses pass through. */
export function shortAddress(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (SHORT_ADDRESS.test(trimmed)) return trimmed
  if (!ADDRESS.test(trimmed)) return null
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
  return text || null
}

function cleanAmount(value: ReceiptInput["amount"]): string | null {
  if (value === null || value === undefined) return null
  const text = typeof value === "string" ? value.trim() : String(value)
  return /^\d{1,20}$/.test(text) ? text.replace(/^0+(?=\d)/, "") : null
}

function cleanAsset(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const asset = value.trim()
  if (asset === USDC_DEVNET_MINT || asset.toUpperCase() === "USDC") return "USDC"
  if (BASE58.test(asset)) return shortAddress(asset)
  return cleanText(asset, 12)
}

/** Builds a public record from the input, or null when it is not a valid receipt. */
export function sanitizeReceipt(input: ReceiptInput, now: number = Date.now()): ReceiptRecord | null {
  if (!input || !RECEIPT_TYPES.includes(input.type)) return null
  if (!isSignature(input.tx)) return null
  const score = typeof input.score === "number" && Number.isInteger(input.score) && input.score >= 0 && input.score <= 100 ? input.score : null
  const timestamp = typeof input.timestamp === "number" && Number.isFinite(input.timestamp) && input.timestamp > 0 ? Math.floor(input.timestamp) : now
  const amount = cleanAmount(input.amount)
  return {
    id: `${input.type}:${input.tx}`,
    type: input.type,
    tx: input.tx,
    network: RECEIPT_NETWORK,
    amount,
    asset: amount === null ? null : cleanAsset(input.asset) ?? "USDC",
    agentId: cleanText(input.agentId, 80),
    agentName: cleanText(input.agentName, 40),
    counterpartId: cleanText(input.counterpartId, 80),
    counterpartName: cleanText(input.counterpartName, 40),
    payer: shortAddress(input.payer),
    identity: isAddress(input.identity) ? input.identity : null,
    score: input.type === "review" ? score : null,
    timestamp,
    source: input.source === "on-chain" ? "on-chain" : "app",
  }
}

/** Parses one stored record; null for anything malformed (an old or foreign entry). */
export function parseStoredReceipt(raw: string): ReceiptRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ReceiptRecord>
    if (!value || typeof value !== "object" || typeof value.type !== "string" || typeof value.tx !== "string") return null
    return sanitizeReceipt({ ...value, type: value.type as ReceiptType, tx: value.tx }, typeof value.timestamp === "number" ? value.timestamp : 0)
  } catch {
    return null
  }
}

/** The list the log lives in: newest first, capped. */
export interface ReceiptLogBackend {
  push(key: string, value: string, cap: number): Promise<void>
  range(key: string, count: number): Promise<string[]>
}

export function createRedisReceiptBackend(config: { url: string; token: string }, fetchImpl: typeof fetch = fetch): ReceiptLogBackend {
  async function command(args: Array<string | number>): Promise<unknown> {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
      cache: "no-store",
    })
    const data = await response.json().catch(() => null) as { result?: unknown; error?: string } | null
    if (!response.ok || !data || data.error) throw new Error(`KV ${String(args[0])} failed (HTTP ${response.status}).`)
    return data.result ?? null
  }
  return {
    async push(key, value, cap) {
      await command(["LPUSH", key, value])
      await command(["LTRIM", key, 0, cap - 1])
    },
    async range(key, count) {
      const result = await command(["LRANGE", key, 0, count - 1])
      return Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : []
    },
  }
}

export function createMemoryReceiptBackend(): ReceiptLogBackend {
  const lists = new Map<string, string[]>()
  return {
    async push(key, value, cap) {
      const list = lists.get(key) ?? []
      list.unshift(value)
      lists.set(key, list.slice(0, cap))
    },
    async range(key, count) {
      return (lists.get(key) ?? []).slice(0, count)
    },
  }
}

const globalState = globalThis as typeof globalThis & { __agenticCityReceiptLog__?: ReceiptLogBackend }
let override: ReceiptLogBackend | null = null

export function getReceiptBackend(): ReceiptLogBackend {
  if (override) return override
  const redis = getRedisConfig()
  if (redis) return createRedisReceiptBackend(redis)
  globalState.__agenticCityReceiptLog__ ??= createMemoryReceiptBackend()
  return globalState.__agenticCityReceiptLog__
}

/** Test seam: force a backend (null restores the default and clears the in-memory one). */
export function setReceiptBackendForTests(backend: ReceiptLogBackend | null) {
  override = backend
  if (!backend) delete globalState.__agenticCityReceiptLog__
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Appends one receipt to the public log. Best-effort: returns false (and logs a warning)
 * instead of throwing, so the payment, hire or registration that called it is never affected.
 */
export async function recordReceipt(input: ReceiptInput, options: { backend?: ReceiptLogBackend; now?: number; timeoutMs?: number } = {}): Promise<boolean> {
  try {
    const record = sanitizeReceipt(input, options.now ?? Date.now())
    if (!record) return false
    const backend = options.backend ?? getReceiptBackend()
    await withTimeout(backend.push(RECEIPTS_KEY, JSON.stringify(record), RECEIPTS_CAP), options.timeoutMs ?? WRITE_TIMEOUT_MS)
    return true
  } catch (error) {
    console.warn("[receipts] could not record a receipt:", error instanceof Error ? error.message : "unknown error")
    return false
  }
}

/** The log, newest first, deduplicated by record id. Throws when the backend fails. */
export async function readReceiptLog(backend: ReceiptLogBackend = getReceiptBackend()): Promise<ReceiptRecord[]> {
  const raw = await backend.range(RECEIPTS_KEY, RECEIPTS_CAP)
  const seen = new Set<string>()
  const records: ReceiptRecord[] = []
  for (const item of raw) {
    const record = parseStoredReceipt(item)
    if (!record || seen.has(record.id)) continue
    seen.add(record.id)
    records.push(record)
  }
  return records
}

export function txExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`
}

export function addressExplorerUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`
}
