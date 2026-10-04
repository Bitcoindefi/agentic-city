import { getBase58Decoder } from "@solana/kit"
import { getKvStore, type KvStore } from "@/lib/security/kv-store"
import { isSignature, recordReceipt, type ReceiptLogBackend } from "@/lib/receipts/log"
import type { RpcCall } from "@/lib/receipts/onchain"

// 8004 reviews are signed and sent by the reviewer's wallet in the browser, so the server only
// learns that one landed when the browser says so. To keep that honest:
//  1. when the server prepares a review it already signed it as fee payer, so the transaction
//     signature is known: it is remembered as a pending review for a few minutes;
//  2. the browser reports the signature after sending; only a remembered signature is accepted,
//     and only once the chain confirms it without error does it enter the receipts log.

export const PENDING_REVIEW_TTL_SECONDS = 15 * 60
const pendingKey = (signature: string) => `ac:receipts:pending-review:${signature}`

export type PendingReview = { agentId: string; agentName?: string | null; payer: string; score: number }

/**
 * The first signature of a serialized transaction (the fee payer's, which is the transaction id).
 * Null when it is missing or still empty.
 */
export function firstSignature(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"))
    const count = bytes[0] ?? 0
    // Compact-u16 under 128 is one byte; a review carries two signatures.
    if (count < 1 || count > 127 || bytes.length < 65) return null
    const signature = bytes.slice(1, 65)
    if (signature.every((byte) => byte === 0)) return null
    return getBase58Decoder().decode(signature)
  } catch {
    return null
  }
}

/** Best-effort: a review that cannot be remembered still goes ahead, it just will not be logged. */
export async function rememberPendingReview(preparedTransaction: string, review: PendingReview, store: KvStore = getKvStore()): Promise<string | null> {
  const signature = firstSignature(preparedTransaction)
  if (!signature) return null
  try {
    await store.set(pendingKey(signature), JSON.stringify(review), PENDING_REVIEW_TTL_SECONDS)
    return signature
  } catch {
    return null
  }
}

export type ConfirmDeps = {
  rpc: RpcCall
  store?: KvStore
  backend?: ReceiptLogBackend
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  intervalMs?: number
}

export type ConfirmResult =
  | { ok: true; recorded: boolean }
  | { ok: false; status: number; error: string }

type SignatureStatus = { err?: unknown; confirmationStatus?: string | null } | null

/** Logs a review the browser says it sent, once the chain confirms it. */
export async function confirmReview(signature: string, agentId: string, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (!isSignature(signature)) return { ok: false, status: 400, error: "Invalid review signature." }
  const store = deps.store ?? getKvStore()
  let pending: PendingReview | null = null
  try {
    const raw = await store.get(pendingKey(signature))
    pending = raw ? JSON.parse(raw) as PendingReview : null
  } catch {
    pending = null
  }
  if (!pending || pending.agentId !== agentId) return { ok: false, status: 404, error: "This review was not prepared here." }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts = deps.attempts ?? 8
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(deps.intervalMs ?? 1_500)
    let status: SignatureStatus = null
    try {
      const result = await deps.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]) as { value?: SignatureStatus[] } | null
      status = result?.value?.[0] ?? null
    } catch {
      continue
    }
    if (!status) continue
    if (status.err) {
      await store.del(pendingKey(signature)).catch(() => undefined)
      return { ok: false, status: 409, error: "The review failed on-chain." }
    }
    if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
      // Delete first: a second report of the same signature finds nothing to log.
      await store.del(pendingKey(signature)).catch(() => undefined)
      const recorded = await recordReceipt({
        type: "review",
        tx: signature,
        agentId: pending.agentId,
        agentName: pending.agentName ?? null,
        payer: pending.payer,
        score: pending.score,
      }, { backend: deps.backend })
      return { ok: true, recorded }
    }
  }
  return { ok: false, status: 202, error: "The review is not confirmed yet." }
}
