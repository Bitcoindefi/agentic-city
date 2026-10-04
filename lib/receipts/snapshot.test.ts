import { afterEach, describe, expect, it, vi } from "vitest"
import { sanitizeReceipt, type ReceiptRecord } from "@/lib/receipts/log"
import { SNAPSHOT_TTL_MS, backfillConfig, buildSnapshot, getReceiptsSnapshot, resetReceiptsSnapshotForTests, type SnapshotDeps } from "@/lib/receipts/snapshot"

const TREASURY = "F8HEGS2wyZhLDXsFXRti74bRiGNUmEFS4SANZBU3p5h"
const record = (c: string, timestamp: number, source: "app" | "on-chain" = "app") => sanitizeReceipt({ type: "payment", tx: c.repeat(88), amount: "10000", timestamp, source }) as ReceiptRecord

describe("backfillConfig", () => {
  it("derives the treasury USDC account, and is off without a treasury or when disabled", async () => {
    const config = await backfillConfig({ X402_SOLANA_PAY_TO: TREASURY })
    expect(config).toMatchObject({ treasury: TREASURY, treasuryAta: "9Cc5TqtR7QYLcPZowey5gGwhXfNJn38xAqpUdDq3q3bc", limit: 100 })
    expect(await backfillConfig({})).toBeNull()
    expect(await backfillConfig({ X402_SOLANA_PAY_TO: TREASURY, RECEIPTS_ONCHAIN_BACKFILL: "OFF" })).toBeNull()
    expect(await backfillConfig({ X402_SOLANA_PAY_TO: "not-an-address" })).toBeNull()
  })
})

describe("buildSnapshot / getReceiptsSnapshot", () => {
  afterEach(() => resetReceiptsSnapshotForTests())

  it("merges the log and the chain and reports each source", async () => {
    const snapshot = await buildSnapshot({
      readLog: async () => [record("2", 200)],
      backfill: async () => ({ records: [record("2", 200, "on-chain"), record("3", 100, "on-chain")], scanned: 5, pending: 1 }),
      now: () => 1234,
    })
    expect(snapshot.records.map((item) => item.source)).toEqual(["app", "on-chain"])
    expect(snapshot).toMatchObject({ updatedAt: 1234, sources: { app: 1, onchain: 2, onchainPending: 1, onchainError: false, logError: false } })
  })

  it("shows what it could read when one source fails, and works with the backfill off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const failedChain = await buildSnapshot({ readLog: async () => [record("2", 1)], backfill: async () => { throw new Error("rpc down") }, now: () => 0 })
    expect(failedChain.records).toHaveLength(1)
    expect(failedChain.sources.onchainError).toBe(true)
    const failedLog = await buildSnapshot({ readLog: async () => { throw "kv down" }, backfill: null, now: () => 0 })
    expect(failedLog.records).toEqual([])
    expect(failedLog.sources).toMatchObject({ logError: true, onchainError: false })
    const odd = await buildSnapshot({ readLog: async () => [], backfill: async () => { throw "odd" }, now: () => 0 })
    expect(odd.sources.onchainError).toBe(true)
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it("caches for the TTL and shares one build between concurrent callers", async () => {
    let clock = 0
    const readLog = vi.fn(async () => [record("2", 1)])
    const deps: SnapshotDeps = { readLog, backfill: null, now: () => clock }
    const [a, b] = await Promise.all([getReceiptsSnapshot(deps), getReceiptsSnapshot(deps)])
    expect(a).toBe(b)
    expect(readLog).toHaveBeenCalledTimes(1)
    clock = SNAPSHOT_TTL_MS - 1
    await getReceiptsSnapshot(deps)
    expect(readLog).toHaveBeenCalledTimes(1)
    clock = SNAPSHOT_TTL_MS + 1
    await getReceiptsSnapshot(deps)
    expect(readLog).toHaveBeenCalledTimes(2)
  })
})
