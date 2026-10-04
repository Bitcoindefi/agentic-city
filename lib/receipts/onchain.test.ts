import { describe, expect, it, vi } from "vitest"
import { createMemoryStore, type KvStore } from "@/lib/security/kv-store"
import {
  ONCHAIN_CACHE_KEY,
  RpcError,
  classifyTransaction,
  createRpc,
  fetchOnchainReceipts,
  type BackfillConfig,
  type ChainTransaction,
  type RpcCall,
} from "@/lib/receipts/onchain"

const TREASURY = "F8HEGS2wyZhLDXsFXRti74bRiGNUmEFS4SANZBU3p5h"
const ATA = "9Cc5TqtR7QYLcPZowey5gGwhXfNJn38xAqpUdDq3q3bc"
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const REGISTRY = "8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C"
const PAYER = "Bp6mXwYzAbCdEfGhJkLmNpQrStUvWxYz12345678abcd"
const ASSET = "AsseTXwYzAbCdEfGhJkLmNpQrStUvWxYz123456789ab"
const config: BackfillConfig = { treasury: TREASURY, treasuryAta: ATA, mint: MINT, registryProgram: REGISTRY, limit: 50 }
const sig = (c: string) => c.repeat(88)

function payment(blockTime: number, amount = 10000, opts: { payerOwner?: string; err?: unknown } = {}): ChainTransaction {
  return {
    blockTime,
    meta: {
      err: opts.err ?? null,
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: opts.payerOwner ?? PAYER, uiTokenAmount: { amount: "100000" } },
        { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "50000" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: opts.payerOwner ?? PAYER, uiTokenAmount: { amount: String(100000 - amount) } },
        { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: String(50000 + amount) } },
      ],
      logMessages: [],
    },
    transaction: { message: { accountKeys: ["Facilitator1111111111111111111111", PAYER, ATA], header: { numRequiredSignatures: 1 } } },
  }
}

function registryTx(blockTime: number, instruction: string, second: string): ChainTransaction {
  return {
    blockTime,
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], logMessages: [`Program ${REGISTRY} invoke [1]`, `Program log: Instruction: ${instruction}`] },
    transaction: { message: { accountKeys: [{ pubkey: TREASURY }, { pubkey: second }, { pubkey: REGISTRY }], header: { numRequiredSignatures: 2 } } },
  }
}

describe("classifyTransaction", () => {
  it("reads a treasury USDC payment with its payer and amount", () => {
    expect(classifyTransaction(sig("2"), payment(1_759_000_000), config)).toMatchObject({
      type: "payment", tx: sig("2"), amount: "10000", asset: "USDC", payer: `${PAYER.slice(0, 4)}…${PAYER.slice(-4)}`,
      timestamp: 1_759_000_000_000, source: "on-chain", agentId: null,
    })
  })

  it("reads 8004 registrations and reviews from the registry logs", () => {
    expect(classifyTransaction(sig("3"), registryTx(10, "RegisterWithOptions", ASSET), config)).toMatchObject({ type: "registration", identity: ASSET, amount: null })
    expect(classifyTransaction(sig("4"), registryTx(10, "GiveFeedback", PAYER), config)).toMatchObject({ type: "review", payer: `${PAYER.slice(0, 4)}…${PAYER.slice(-4)}` })
    expect(classifyTransaction(sig("5"), registryTx(10, "SetMetadata", PAYER), config)).toBeNull()
  })

  it("ignores failed, missing, outgoing and unrelated transactions", () => {
    expect(classifyTransaction(sig("2"), null, config)).toBeNull()
    expect(classifyTransaction(sig("2"), payment(1, 10000, { err: { InstructionError: [0, "x"] } }), config)).toBeNull()
    expect(classifyTransaction(sig("2"), payment(1, -5000), config)).toBeNull()
    const sponsored = payment(1, 10000, { payerOwner: TREASURY })
    expect(classifyTransaction(sig("2"), sponsored, config)).toBeNull()
    const noMeta = { ...payment(1), meta: null }
    expect(classifyTransaction(sig("2"), noMeta, config)).toBeNull()
  })

  it("survives odd balances and missing keys", () => {
    const odd = payment(0)
    odd.meta!.preTokenBalances![1].uiTokenAmount = { amount: "x" }
    odd.transaction.message = {}
    expect(classifyTransaction(sig("2"), odd, config)).toMatchObject({ type: "payment", amount: "60000" })
    const noPayer = payment(5)
    noPayer.meta!.preTokenBalances = noPayer.meta!.preTokenBalances!.slice(1)
    noPayer.meta!.postTokenBalances = noPayer.meta!.postTokenBalances!.slice(1)
    expect(classifyTransaction(sig("2"), noPayer, config)).toMatchObject({ payer: null })
  })
})

function fakeRpc(txs: Record<string, ChainTransaction | null | Error>, lists: { ata: Array<{ signature: string; blockTime: number; err?: unknown }>; owner: Array<{ signature: string; blockTime: number; err?: unknown }> }) {
  const calls: Array<{ method: string; params: unknown[] }> = []
  const rpc: RpcCall = async (method, params) => {
    calls.push({ method, params })
    if (method === "getSignaturesForAddress") return (params[0] === ATA ? lists.ata : lists.owner).map((item) => ({ err: null, ...item }))
    const value = txs[params[0] as string]
    if (value instanceof Error) throw value
    return value ?? null
  }
  return { rpc, calls }
}

describe("fetchOnchainReceipts", () => {
  it("merges both histories newest first, classifies each signature once and caches it", async () => {
    const store = createMemoryStore()
    const { rpc, calls } = fakeRpc(
      { [sig("2")]: payment(100), [sig("3")]: registryTx(300, "RegisterWithOptions", ASSET), [sig("4")]: registryTx(200, "GiveFeedback", PAYER), [sig("6")]: registryTx(50, "Other", PAYER) },
      {
        ata: [{ signature: sig("2"), blockTime: 100 }, { signature: sig("7"), blockTime: 400, err: { x: 1 } }],
        owner: [{ signature: sig("3"), blockTime: 300 }, { signature: sig("4"), blockTime: 200 }, { signature: sig("2"), blockTime: 100 }, { signature: sig("6"), blockTime: 50 }],
      },
    )
    const sleep = vi.fn(async () => undefined)
    const result = await fetchOnchainReceipts(config, { rpc, store, sleep })
    expect(result.records.map((record) => record.type)).toEqual(["registration", "review", "payment"])
    expect(result).toMatchObject({ scanned: 4, pending: 0 })
    expect(calls.filter((call) => call.method === "getTransaction")).toHaveLength(4)
    expect(calls[0].params[1]).toEqual({ limit: 50, commitment: "confirmed" })
    expect(sleep).toHaveBeenCalledWith(250)

    const cached = JSON.parse((await store.get(ONCHAIN_CACHE_KEY)) ?? "{}")
    expect(cached[sig("6")]).toBe(0)
    // Second run: everything is cached, so no getTransaction at all.
    const again = fakeRpc({}, { ata: [{ signature: sig("2"), blockTime: 100 }], owner: [{ signature: sig("3"), blockTime: 300 }] })
    const second = await fetchOnchainReceipts(config, { rpc: again.rpc, store, sleep })
    expect(again.calls.filter((call) => call.method === "getTransaction")).toHaveLength(0)
    expect(second.records.map((record) => record.type)).toEqual(["registration", "payment"])
  })

  it("backs off on rate limits and leaves what it could not read for the next refresh", async () => {
    let limited = 2
    const rpc: RpcCall = async (method, params) => {
      if (method === "getSignaturesForAddress") return params[0] === ATA ? [{ signature: sig("2"), blockTime: 3, err: null }, { signature: sig("3"), blockTime: 2, err: null }, { signature: sig("4"), blockTime: 1, err: null }] : null
      if (params[0] === sig("2") && limited > 0) {
        limited -= 1
        throw new RpcError("rate limited", 429)
      }
      if (params[0] === sig("3")) throw new RpcError("boom", -32000)
      return params[0] === sig("4") ? null : payment(3)
    }
    const sleep = vi.fn(async () => undefined)
    const result = await fetchOnchainReceipts(config, { rpc, sleep, spacingMs: 0 })
    expect(sleep.mock.calls.map((call) => (call as unknown[])[0])).toEqual([700, 1500])
    expect(result.records).toHaveLength(1)
    expect(result.pending).toBe(2)
  })

  it("stops at the time budget", async () => {
    let clock = 0
    const rpc: RpcCall = async (method) => {
      if (method === "getSignaturesForAddress") return [{ signature: sig("2"), blockTime: 2, err: null }, { signature: sig("3"), blockTime: 1, err: null }]
      clock += 5_000
      return payment(1)
    }
    const result = await fetchOnchainReceipts(config, { rpc, now: () => clock, budgetMs: 4_000, sleep: async () => undefined })
    expect(result.records).toHaveLength(1)
    expect(result.pending).toBe(1)
    // Out of budget, a rate limit is not retried.
    let tries = 0
    const limitedRpc: RpcCall = async (method) => {
      if (method === "getSignaturesForAddress") return [{ signature: sig("2"), blockTime: 2, err: null }]
      tries += 1
      throw new RpcError("rate limited", 429)
    }
    const none = await fetchOnchainReceipts(config, { rpc: limitedRpc, now: () => 0, budgetMs: 100, sleep: async () => undefined })
    expect(tries).toBe(1)
    expect(none.pending).toBe(1)
  })

  it("tolerates a broken cache and a failing cache write", async () => {
    const broken: KvStore = { ...createMemoryStore(), get: vi.fn().mockResolvedValue("[1,2]"), set: vi.fn().mockRejectedValue(new Error("KV SET failed")) }
    const { rpc } = fakeRpc({ [sig("2")]: payment(1) }, { ata: [{ signature: sig("2"), blockTime: 1 }], owner: [] })
    expect((await fetchOnchainReceipts(config, { rpc, store: broken, sleep: async () => undefined })).records).toHaveLength(1)
    const throwing: KvStore = { ...createMemoryStore(), get: vi.fn().mockRejectedValue(new Error("down")) }
    expect((await fetchOnchainReceipts(config, { rpc, store: throwing, sleep: async () => undefined })).records).toHaveLength(1)
    const garbage: KvStore = { ...createMemoryStore(), get: vi.fn().mockResolvedValue(JSON.stringify({ [sig("2")]: { type: "payment", tx: "bad" } })) }
    const { rpc: unused } = fakeRpc({}, { ata: [{ signature: sig("2"), blockTime: 1 }], owner: [] })
    expect((await fetchOnchainReceipts(config, { rpc: unused, store: garbage })).records).toEqual([])
  })
})

describe("createRpc", () => {
  it("posts JSON-RPC and maps errors", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [1] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -32602, message: "bad params" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<html>", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    const rpc = createRpc("https://rpc.test", fetchImpl as unknown as typeof fetch)
    expect(await rpc("getSlot", [])).toEqual([1])
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ jsonrpc: "2.0", method: "getSlot", params: [] })
    await expect(rpc("a", [])).rejects.toMatchObject({ code: 429 })
    await expect(rpc("b", [])).rejects.toMatchObject({ code: -32602, message: "b: bad params" })
    await expect(rpc("c", [])).rejects.toMatchObject({ code: 502 })
    await expect(rpc("d", [])).rejects.toMatchObject({ code: null })
    expect(await rpc("e", [])).toBeNull()
  })
})
