import { describe, expect, it, vi } from "vitest"
import { getBase58Decoder } from "@solana/kit"
import { createMemoryStore, type KvStore } from "@/lib/security/kv-store"
import { createMemoryReceiptBackend, readReceiptLog } from "@/lib/receipts/log"
import type { RpcCall } from "@/lib/receipts/onchain"
import { confirmReview, firstSignature, rememberPendingReview } from "@/lib/receipts/review-confirm"

const PAYER = "Bp6mXwYzAbCdEfGhJkLmNpQrStUvWxYz12345678abcd"
const feePayerSignature = Uint8Array.from({ length: 64 }, (_, i) => i + 1)
const SIGNATURE = getBase58Decoder().decode(feePayerSignature)

/** A wire transaction: two signatures (the fee payer's filled in, the reviewer's still empty) and a message. */
function wireTransaction(first: Uint8Array = feePayerSignature): string {
  const bytes = new Uint8Array(1 + 64 * 2 + 10)
  bytes[0] = 2
  bytes.set(first, 1)
  return Buffer.from(bytes).toString("base64")
}

function statusRpc(statuses: Array<unknown>): RpcCall & { calls: number } {
  let index = 0
  const rpc = (async (method: string) => {
    rpc.calls += 1
    expect(method).toBe("getSignatureStatuses")
    const next = statuses[Math.min(index, statuses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return { value: [next] }
  }) as unknown as RpcCall & { calls: number }
  rpc.calls = 0
  return rpc
}

describe("firstSignature", () => {
  it("reads the fee payer's signature, which is the transaction id", () => {
    expect(firstSignature(wireTransaction())).toBe(SIGNATURE)
    expect(firstSignature(wireTransaction(new Uint8Array(64)))).toBeNull()
    expect(firstSignature(Buffer.from([0, 1, 2]).toString("base64"))).toBeNull()
    expect(firstSignature(Buffer.from(new Uint8Array(70).fill(200)).toString("base64"))).toBeNull()
  })
})

describe("rememberPendingReview + confirmReview", () => {
  it("logs a remembered review once the chain confirms it, only once", async () => {
    const store = createMemoryStore()
    const backend = createMemoryReceiptBackend()
    expect(await rememberPendingReview(wireTransaction(), { agentId: "research", agentName: "Investigador", payer: PAYER, score: 100 }, store)).toBe(SIGNATURE)

    const rpc = statusRpc([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }])
    const sleep = vi.fn(async () => undefined)
    expect(await confirmReview(SIGNATURE, "research", { rpc, store, backend, sleep, intervalMs: 5 })).toEqual({ ok: true, recorded: true })
    expect(sleep).toHaveBeenCalledWith(5)
    const [review] = await readReceiptLog(backend)
    expect(review).toMatchObject({ type: "review", tx: SIGNATURE, agentId: "research", agentName: "Investigador", score: 100, payer: `${PAYER.slice(0, 4)}…${PAYER.slice(-4)}` })

    // Reported again: nothing pending any more.
    expect(await confirmReview(SIGNATURE, "research", { rpc, store, backend, sleep })).toMatchObject({ ok: false, status: 404 })
  })

  it("refuses unknown, mismatched or malformed signatures without asking the chain", async () => {
    const store = createMemoryStore()
    const rpc = statusRpc([{ err: null, confirmationStatus: "finalized" }])
    await rememberPendingReview(wireTransaction(), { agentId: "research", payer: PAYER, score: 50 }, store)
    expect(await confirmReview("bad", "research", { rpc, store })).toMatchObject({ ok: false, status: 400 })
    expect(await confirmReview(SIGNATURE, "writer", { rpc, store })).toMatchObject({ ok: false, status: 404 })
    expect(await confirmReview("5".repeat(88), "research", { rpc, store })).toMatchObject({ ok: false, status: 404 })
    const broken: KvStore = { ...createMemoryStore(), get: vi.fn().mockResolvedValue("{nope") }
    expect(await confirmReview(SIGNATURE, "research", { rpc, store: broken })).toMatchObject({ ok: false, status: 404 })
    expect(rpc.calls).toBe(0)
  })

  it("drops a review that failed on-chain and gives up politely when it never confirms", async () => {
    const store = createMemoryStore()
    await rememberPendingReview(wireTransaction(), { agentId: "a", payer: PAYER, score: 10 }, store)
    const failed = statusRpc([{ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }])
    expect(await confirmReview(SIGNATURE, "a", { rpc: failed, store, sleep: async () => undefined })).toMatchObject({ ok: false, status: 409 })
    expect(await store.get(`ac:receipts:pending-review:${SIGNATURE}`)).toBeNull()

    await rememberPendingReview(wireTransaction(), { agentId: "a", payer: PAYER, score: 10 }, store)
    const flaky = statusRpc([new Error("rpc down"), null])
    expect(await confirmReview(SIGNATURE, "a", { rpc: flaky, store, attempts: 3, sleep: async () => undefined })).toMatchObject({ ok: false, status: 202 })
    expect(flaky.calls).toBe(3)
    expect(await store.get(`ac:receipts:pending-review:${SIGNATURE}`)).not.toBeNull()
  })

  it("never throws when the pending review cannot be stored", async () => {
    const down: KvStore = { ...createMemoryStore(), set: vi.fn().mockRejectedValue(new Error("KV SET failed")) }
    expect(await rememberPendingReview(wireTransaction(), { agentId: "a", payer: PAYER, score: 10 }, down)).toBeNull()
    expect(await rememberPendingReview("", { agentId: "a", payer: PAYER, score: 10 }, down)).toBeNull()
  })
})
