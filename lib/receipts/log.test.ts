import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RECEIPTS_CAP,
  RECEIPTS_KEY,
  addressExplorerUrl,
  createMemoryReceiptBackend,
  createRedisReceiptBackend,
  getReceiptBackend,
  parseStoredReceipt,
  readReceiptLog,
  recordReceipt,
  sanitizeReceipt,
  setReceiptBackendForTests,
  shortAddress,
  txExplorerUrl,
  type ReceiptLogBackend,
} from "@/lib/receipts/log"
import { USDC_DEVNET_MINT } from "@/lib/solana/payment-constants"

const SIG = "5".repeat(88)
const PAYER = "F8HEGS2wyZhLDXsFXRti74bRiGNUmEFS4SANZBU3p5h"
const SHORT = `${PAYER.slice(0, 4)}\u2026${PAYER.slice(-4)}`

describe("sanitizeReceipt", () => {
  it("keeps only public fields and shortens the payer", () => {
    const record = sanitizeReceipt({
      type: "payment",
      tx: SIG,
      amount: "10000",
      asset: USDC_DEVNET_MINT,
      agentId: "research",
      agentName: "Investigador",
      payer: PAYER,
      timestamp: 1_700_000_000_000,
      // Fields that must never reach the public log.
      ...({ task: "secret prompt", apiKey: "sk-123", owner: "abc" } as object),
    })
    expect(record).toEqual({
      id: `payment:${SIG}`,
      type: "payment",
      tx: SIG,
      network: "solana:devnet",
      amount: "10000",
      asset: "USDC",
      agentId: "research",
      agentName: "Investigador",
      counterpartId: null,
      counterpartName: null,
      payer: SHORT,
      identity: null,
      score: null,
      timestamp: 1_700_000_000_000,
      source: "app",
    })
    expect(JSON.stringify(record)).not.toMatch(/secret|sk-123|abc/)
  })

  it("rejects bad types and signatures, and cleans every field", () => {
    expect(sanitizeReceipt({ type: "refund" as never, tx: SIG })).toBeNull()
    expect(sanitizeReceipt({ type: "payment", tx: "not a signature" })).toBeNull()
    expect(sanitizeReceipt(null as never)).toBeNull()
    const record = sanitizeReceipt({
      type: "review",
      tx: SIG,
      amount: "12abc",
      agentName: `  Bot\u0000 ${"x".repeat(80)}`,
      payer: "short",
      score: 101,
      identity: "nope",
      timestamp: -5,
      source: "on-chain",
    }, 42)
    expect(record).toMatchObject({ amount: null, asset: null, payer: null, score: null, identity: null, timestamp: 42, source: "on-chain" })
    expect(record?.agentName).toHaveLength(40)
    expect(record?.agentName?.startsWith("Bot x")).toBe(true)
    expect(sanitizeReceipt({ type: "review", tx: SIG, score: 80 })?.score).toBe(80)
    expect(sanitizeReceipt({ type: "payment", tx: SIG, score: 80 })?.score).toBeNull()
    expect(sanitizeReceipt({ type: "payment", tx: SIG, amount: BigInt(10000) })?.amount).toBe("10000")
    expect(sanitizeReceipt({ type: "payment", tx: SIG, amount: 7, asset: PAYER })?.asset).toBe(SHORT)
    expect(sanitizeReceipt({ type: "payment", tx: SIG, amount: "0010", asset: "eurc!" })).toMatchObject({ amount: "10", asset: "eurc!" })
    expect(sanitizeReceipt({ type: "payment", tx: SIG, amount: "5" })?.asset).toBe("USDC")
    expect(sanitizeReceipt({ type: "registration", tx: SIG, identity: PAYER })?.identity).toBe(PAYER)
  })

  it("shortens addresses and keeps already short ones", () => {
    expect(shortAddress(PAYER)).toBe(`${PAYER.slice(0, 4)}…${PAYER.slice(-4)}`)
    expect(shortAddress(`${PAYER.slice(0, 4)}…${PAYER.slice(-4)}`)).toBe(`${PAYER.slice(0, 4)}…${PAYER.slice(-4)}`)
    expect(shortAddress("0OIl")).toBeNull()
    expect(shortAddress(12)).toBeNull()
  })

  it("builds explorer links", () => {
    expect(txExplorerUrl("abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet")
    expect(addressExplorerUrl("abc")).toBe("https://explorer.solana.com/address/abc?cluster=devnet")
  })
})

describe("recordReceipt / readReceiptLog", () => {
  afterEach(() => setReceiptBackendForTests(null))

  it("appends newest first and caps the list", async () => {
    const backend = createMemoryReceiptBackend()
    for (let i = 0; i < RECEIPTS_CAP + 5; i += 1) {
      // Base 9 digits shifted to 1-9: unique, valid base58.
      const tx = `${"6".repeat(80)}${i.toString(9).padStart(4, "0").replace(/\d/g, (d) => String(Number(d) + 1))}`
      expect(await recordReceipt({ type: "payment", tx, amount: "10000" }, { backend, now: i })).toBe(true)
    }
    const raw = await backend.range(RECEIPTS_KEY, RECEIPTS_CAP + 10)
    expect(raw).toHaveLength(RECEIPTS_CAP)
    const records = await readReceiptLog(backend)
    expect(records).toHaveLength(RECEIPTS_CAP)
    expect(records[0].timestamp).toBe(RECEIPTS_CAP + 4)
  })

  it("is best-effort: invalid input, a failing or a hanging store never throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(await recordReceipt({ type: "payment", tx: "bad" })).toBe(false)
    const failing: ReceiptLogBackend = { push: vi.fn().mockRejectedValue(new Error("KV LPUSH failed")), range: vi.fn() }
    expect(await recordReceipt({ type: "payment", tx: SIG }, { backend: failing })).toBe(false)
    const hanging: ReceiptLogBackend = { push: () => new Promise(() => undefined), range: vi.fn() }
    expect(await recordReceipt({ type: "payment", tx: SIG }, { backend: hanging, timeoutMs: 10 })).toBe(false)
    const odd: ReceiptLogBackend = { push: vi.fn().mockRejectedValue("boom"), range: vi.fn() }
    expect(await recordReceipt({ type: "payment", tx: SIG }, { backend: odd })).toBe(false)
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it("dedupes by id and skips malformed entries when reading", async () => {
    const backend = createMemoryReceiptBackend()
    await recordReceipt({ type: "payment", tx: SIG }, { backend })
    await recordReceipt({ type: "payment", tx: SIG }, { backend })
    await backend.push(RECEIPTS_KEY, "{not json", 10)
    await backend.push(RECEIPTS_KEY, JSON.stringify({ type: 3 }), 10)
    expect(await readReceiptLog(backend)).toHaveLength(1)
    expect(parseStoredReceipt("null")).toBeNull()
    expect(parseStoredReceipt(JSON.stringify({ type: "hire", tx: SIG }))?.timestamp).toBe(0)
  })

  it("uses the default (in-memory) backend unless one is forced", async () => {
    const env = { ...process.env }
    delete process.env.KV_REST_API_URL
    delete process.env.UPSTASH_REDIS_REST_URL
    try {
      expect(await recordReceipt({ type: "registration", tx: SIG })).toBe(true)
      expect(await readReceiptLog()).toHaveLength(1)
      expect(getReceiptBackend()).toBe(getReceiptBackend())
      const forced = createMemoryReceiptBackend()
      setReceiptBackendForTests(forced)
      expect(getReceiptBackend()).toBe(forced)
      process.env.KV_REST_API_URL = "https://kv.test"
      process.env.KV_REST_API_TOKEN = "token"
      setReceiptBackendForTests(null)
      expect(getReceiptBackend()).not.toBe(forced)
    } finally {
      process.env = env
    }
  })
})

describe("createRedisReceiptBackend", () => {
  it("pushes with LPUSH + LTRIM and reads with LRANGE", async () => {
    const calls: string[][] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const args = JSON.parse(String(init?.body)) as string[]
      calls.push(args)
      const result = args[0] === "LRANGE" ? ["a", 3, "b"] : 1
      return new Response(JSON.stringify({ result }), { status: 200 })
    })
    const backend = createRedisReceiptBackend({ url: "https://kv.test", token: "t" }, fetchImpl as unknown as typeof fetch)
    await backend.push("k", "v", 500)
    expect(await backend.range("k", 500)).toEqual(["a", "b"])
    expect(calls).toEqual([["LPUSH", "k", "v"], ["LTRIM", "k", "0", "499"], ["LRANGE", "k", "0", "499"]])
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer t" })
  })

  it("throws on Redis errors so the caller can treat them as best-effort", async () => {
    const failing = createRedisReceiptBackend({ url: "https://kv.test", token: "t" }, (async () => new Response(JSON.stringify({ error: "WRONGTYPE" }), { status: 200 })) as unknown as typeof fetch)
    await expect(failing.push("k", "v", 5)).rejects.toThrow("KV LPUSH failed")
    const notJson = createRedisReceiptBackend({ url: "https://kv.test", token: "t" }, (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch)
    await expect(notJson.range("k", 5)).rejects.toThrow("HTTP 502")
    const empty = createRedisReceiptBackend({ url: "https://kv.test", token: "t" }, (async () => new Response(JSON.stringify({ result: null }), { status: 200 })) as unknown as typeof fetch)
    expect(await empty.range("k", 5)).toEqual([])
  })
})
