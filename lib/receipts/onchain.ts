import type { KvStore } from "@/lib/security/kv-store"
import { sanitizeReceipt, type ReceiptRecord } from "@/lib/receipts/log"

// Backfill from the chain: payments made before the receipts log existed (or whose log write
// was lost) still show in the explorer. Two read-only address histories are scanned on devnet:
//  - the treasury's USDC account: every x402 payment (direct tasks and agent-to-agent hires)
//    lands there, so a positive USDC change for the treasury is a payment;
//  - the treasury wallet itself: it pays the fee of every 8004 registration and review, which
//    the 8004 program names in its logs ("Instruction: Register..." / "Instruction: GiveFeedback").
// Transactions never change once confirmed, so each classified signature is cached in the shared
// store and fetched from the RPC only once. The public devnet RPC rate-limits getTransaction
// hard, so new signatures are fetched one at a time, with backoff, within a time budget.

export const ONCHAIN_CACHE_KEY = "ac:receipts:onchain:v1"
const ONCHAIN_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
const ONCHAIN_CACHE_MAX = 800

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>

export class RpcError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message)
  }
}

export function createRpc(url: string, fetchImpl: typeof fetch = fetch): RpcCall {
  let id = 0
  return async (method, params) => {
    id += 1
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      cache: "no-store",
    })
    if (response.status === 429) throw new RpcError(`${method}: rate limited`, 429)
    const data = await response.json().catch(() => null) as { result?: unknown; error?: { code?: number; message?: string } } | null
    if (!data) throw new RpcError(`${method}: HTTP ${response.status}`, response.status)
    if (data.error) throw new RpcError(`${method}: ${String(data.error.message ?? "error").slice(0, 120)}`, typeof data.error.code === "number" ? data.error.code : null)
    return data.result ?? null
  }
}

export type BackfillConfig = {
  /** Treasury wallet (x402 pay-to, fee payer of 8004 transactions). */
  treasury: string
  /** The treasury's USDC token account. */
  treasuryAta: string
  mint: string
  registryProgram: string
  /** Signatures read per address. */
  limit?: number
}

type SignatureInfo = { signature: string; err: unknown; blockTime?: number | null }
type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { amount?: string } }

export type ChainTransaction = {
  blockTime?: number | null
  meta: {
    err?: unknown
    preTokenBalances?: TokenBalance[] | null
    postTokenBalances?: TokenBalance[] | null
    logMessages?: string[] | null
  } | null
  transaction: {
    message: {
      accountKeys?: Array<string | { pubkey: string }>
      header?: { numRequiredSignatures?: number }
    }
  }
}

const ZERO = BigInt(0)

function balanceChanges(meta: NonNullable<ChainTransaction["meta"]>, mint: string): Map<string, bigint> {
  const byIndex = new Map<number, { owner: string; pre: bigint; post: bigint }>()
  const add = (list: TokenBalance[] | null | undefined, field: "pre" | "post") => {
    for (const balance of list ?? []) {
      if (balance.mint !== mint || !balance.owner) continue
      const entry = byIndex.get(balance.accountIndex) ?? { owner: balance.owner, pre: ZERO, post: ZERO }
      try {
        entry[field] = BigInt(balance.uiTokenAmount?.amount ?? "0")
      } catch {
        entry[field] = ZERO
      }
      byIndex.set(balance.accountIndex, entry)
    }
  }
  add(meta.preTokenBalances, "pre")
  add(meta.postTokenBalances, "post")
  const byOwner = new Map<string, bigint>()
  for (const { owner, pre, post } of byIndex.values()) byOwner.set(owner, (byOwner.get(owner) ?? ZERO) + post - pre)
  return byOwner
}

function accountKeys(tx: ChainTransaction): string[] {
  return (tx.transaction?.message?.accountKeys ?? []).map((key) => (typeof key === "string" ? key : key?.pubkey ?? ""))
}

/**
 * Turns one confirmed transaction into a receipt, or null when it is not one of ours
 * (a failed transaction, a funding sponsorship, an outgoing transfer...).
 */
export function classifyTransaction(signature: string, tx: ChainTransaction | null, config: BackfillConfig): ReceiptRecord | null {
  if (!tx || !tx.meta || tx.meta.err) return null
  const timestamp = tx.blockTime ? tx.blockTime * 1000 : undefined
  const keys = accountKeys(tx)
  const signers = keys.slice(0, tx.transaction?.message?.header?.numRequiredSignatures ?? 1)
  const logs = tx.meta.logMessages ?? []

  if (keys.includes(config.registryProgram)) {
    const secondSigner = signers.length > 1 ? signers[1] : null
    if (logs.some((line) => /Instruction: GiveFeedback/.test(line))) {
      // The treasury pays the fee; the reviewer (the wallet that paid the agent) signs second.
      return sanitizeReceipt({ type: "review", tx: signature, payer: secondSigner, timestamp, source: "on-chain" })
    }
    if (logs.some((line) => /Instruction: Register/.test(line))) {
      // The new agent asset signs its own creation, after the treasury.
      return sanitizeReceipt({ type: "registration", tx: signature, identity: secondSigner, timestamp, source: "on-chain" })
    }
    return null
  }

  const changes = balanceChanges(tx.meta, config.mint)
  const received = changes.get(config.treasury) ?? ZERO
  if (received <= ZERO) return null
  let payer: string | null = null
  for (const [owner, change] of changes) {
    if (owner !== config.treasury && change < ZERO) {
      payer = owner
      break
    }
  }
  return sanitizeReceipt({ type: "payment", tx: signature, amount: received.toString(), asset: config.mint, payer, timestamp, source: "on-chain" })
}

/** Cached classification: a record, or 0 for a signature that is not a receipt. */
type CacheMap = Record<string, ReceiptRecord | 0>

async function readCache(store: KvStore | undefined): Promise<CacheMap> {
  if (!store) return {}
  try {
    const raw = await store.get(ONCHAIN_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : null
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CacheMap : {}
  } catch {
    return {}
  }
}

async function writeCache(store: KvStore | undefined, cache: CacheMap, keep: string[]): Promise<void> {
  if (!store) return
  const trimmed: CacheMap = {}
  for (const signature of keep.slice(0, ONCHAIN_CACHE_MAX)) {
    if (signature in cache) trimmed[signature] = cache[signature]
  }
  try {
    await store.set(ONCHAIN_CACHE_KEY, JSON.stringify(trimmed), ONCHAIN_CACHE_TTL_SECONDS)
  } catch {
    // Best-effort: the next refresh fetches again.
  }
}

export type BackfillDeps = {
  rpc: RpcCall
  store?: KvStore
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Stop fetching new transactions after this long; the rest wait for the next refresh. */
  budgetMs?: number
  /** Pause between getTransaction calls (public devnet rate limits). */
  spacingMs?: number
}

export type BackfillResult = { records: ReceiptRecord[]; scanned: number; pending: number }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function signaturesFor(rpc: RpcCall, address: string, limit: number): Promise<SignatureInfo[]> {
  const result = await rpc("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }])
  if (!Array.isArray(result)) return []
  return result.filter((item): item is SignatureInfo => Boolean(item) && typeof (item as SignatureInfo).signature === "string")
}

async function getTransactionWithRetry(deps: BackfillDeps, signature: string, deadline: number): Promise<ChainTransaction | null | undefined> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const backoff = [700, 1500, 3000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deps.rpc("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]) as ChainTransaction | null
    } catch (error) {
      const limited = error instanceof RpcError && error.code === 429
      if (!limited || attempt >= backoff.length || now() + backoff[attempt] > deadline) return undefined
      await sleep(backoff[attempt])
    }
  }
}

/** Reads recent treasury activity from the chain and returns it as receipts, newest first. */
export async function fetchOnchainReceipts(config: BackfillConfig, deps: BackfillDeps): Promise<BackfillResult> {
  const limit = Math.min(Math.max(config.limit ?? 100, 1), 1000)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + (deps.budgetMs ?? 6_000)

  const [payments, treasuryActivity] = await Promise.all([
    signaturesFor(deps.rpc, config.treasuryAta, limit),
    signaturesFor(deps.rpc, config.treasury, limit),
  ])
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const item of [...payments, ...treasuryActivity].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))) {
    if (item.err || seen.has(item.signature)) continue
    seen.add(item.signature)
    ordered.push(item.signature)
  }

  const cache = await readCache(deps.store)
  let fetched = 0
  let pending = 0
  for (const signature of ordered) {
    if (signature in cache) continue
    if (now() >= deadline) {
      pending += 1
      continue
    }
    if (fetched > 0 && deps.spacingMs !== 0) await sleep(deps.spacingMs ?? 250)
    const tx = await getTransactionWithRetry(deps, signature, deadline)
    fetched += 1
    if (tx === undefined) {
      pending += 1
      continue
    }
    // A null transaction is not indexed yet: leave it for the next refresh.
    if (tx === null) {
      pending += 1
      continue
    }
    cache[signature] = classifyTransaction(signature, tx, config) ?? 0
  }
  if (fetched > 0) await writeCache(deps.store, cache, ordered)

  const records = ordered.flatMap((signature) => {
    const cached = cache[signature]
    // Re-validated: the cache lives in a shared store and is read back as untyped JSON.
    const record = cached && typeof cached === "object" ? sanitizeReceipt({ ...cached, source: "on-chain" }, cached.timestamp) : null
    return record ? [record] : []
  })
  return { records, scanned: ordered.length, pending }
}
