import { usdcAccountFor } from "@/lib/agent-wallet/fund-tx"
import { getKvStore } from "@/lib/security/kv-store"
import { DEVNET_REGISTRY_PROGRAM, USDC_DEVNET_MINT } from "@/lib/solana/payment-constants"
import { readReceiptLog, type ReceiptRecord } from "@/lib/receipts/log"
import { createRpc, fetchOnchainReceipts, type BackfillConfig, type BackfillResult } from "@/lib/receipts/onchain"
import { mergeReceipts } from "@/lib/receipts/query"

// The merged receipts list the API serves, cached briefly per instance so a page polling every
// 10 seconds (and many people watching it) costs one Redis read and, at most, a few RPC calls.

export const SNAPSHOT_TTL_MS = 10_000

export type ReceiptsSnapshot = {
  records: ReceiptRecord[]
  updatedAt: number
  sources: { app: number; onchain: number; onchainPending: number; onchainError: boolean; logError: boolean }
}

export type SnapshotDeps = {
  readLog: () => Promise<ReceiptRecord[]>
  /** Null when the backfill is off or not configured. */
  backfill: (() => Promise<BackfillResult>) | null
  now: () => number
}

export async function backfillConfig(env: Record<string, string | undefined> = process.env): Promise<BackfillConfig | null> {
  if (env.RECEIPTS_ONCHAIN_BACKFILL?.trim().toLowerCase() === "off") return null
  const treasury = env.X402_SOLANA_PAY_TO?.trim()
  if (!treasury) return null
  try {
    const treasuryAta = await usdcAccountFor(treasury, USDC_DEVNET_MINT)
    return { treasury, treasuryAta, mint: USDC_DEVNET_MINT, registryProgram: DEVNET_REGISTRY_PROGRAM, limit: 100 }
  } catch {
    return null
  }
}

function defaultDeps(): SnapshotDeps {
  return {
    readLog: () => readReceiptLog(),
    backfill: async () => {
      const config = await backfillConfig()
      if (!config) return { records: [], scanned: 0, pending: 0 }
      const rpc = createRpc(process.env.SOLANA_RPC?.trim() || "https://api.devnet.solana.com")
      return fetchOnchainReceipts(config, { rpc, store: getKvStore() })
    },
    now: Date.now,
  }
}

/** Builds a fresh snapshot. Each source fails on its own: the page shows what it could read. */
export async function buildSnapshot(deps: SnapshotDeps): Promise<ReceiptsSnapshot> {
  const [log, chain] = await Promise.allSettled([
    deps.readLog(),
    deps.backfill ? deps.backfill() : Promise.resolve<BackfillResult>({ records: [], scanned: 0, pending: 0 }),
  ])
  const appRecords = log.status === "fulfilled" ? log.value : []
  const chainResult = chain.status === "fulfilled" ? chain.value : { records: [], scanned: 0, pending: 0 }
  if (log.status === "rejected") console.warn("[receipts] could not read the log:", log.reason instanceof Error ? log.reason.message : "unknown error")
  if (chain.status === "rejected") console.warn("[receipts] on-chain backfill failed:", chain.reason instanceof Error ? chain.reason.message : "unknown error")
  return {
    records: mergeReceipts(appRecords, chainResult.records),
    updatedAt: deps.now(),
    sources: {
      app: appRecords.length,
      onchain: chainResult.records.length,
      onchainPending: chainResult.pending,
      onchainError: chain.status === "rejected",
      logError: log.status === "rejected",
    },
  }
}

const state: { snapshot: ReceiptsSnapshot | null; inflight: Promise<ReceiptsSnapshot> | null } = { snapshot: null, inflight: null }

export async function getReceiptsSnapshot(deps: SnapshotDeps = defaultDeps()): Promise<ReceiptsSnapshot> {
  const cached = state.snapshot
  if (cached && deps.now() - cached.updatedAt < SNAPSHOT_TTL_MS) return cached
  state.inflight ??= buildSnapshot(deps).then((snapshot) => {
    state.snapshot = snapshot
    return snapshot
  }).finally(() => {
    state.inflight = null
  })
  return state.inflight
}

/** Test seam: forget the cached snapshot. */
export function resetReceiptsSnapshotForTests() {
  state.snapshot = null
  state.inflight = null
}
