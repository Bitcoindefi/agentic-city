import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const generate = vi.hoisted(() => vi.fn())
const requirePayment = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ai/byok-provider", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/byok-provider")>()), generateWithByokProvider: generate }))
vi.mock("@/lib/solana/x402", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/solana/x402")>()), requirePayment }))

import { POST } from "@/app/api/x402/agents/[id]/task/route"
import { createMemoryStore, setKvStoreForTests } from "@/lib/security/kv-store"
import { getPaymentAgent } from "@/lib/solana/payment-bindings"
import { createMemoryReceiptBackend, readReceiptLog, setReceiptBackendForTests } from "@/lib/receipts/log"
import { USDC_DEVNET_MINT } from "@/lib/solana/payment-constants"

const settle = { success: true, transaction: "settle-sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", payer: "payer" }
const paid = { ok: true, settle, payer: "payer", requirements: { amount: "10000", asset: "usdc-mint" } }
const agent = { name: "Investigador", role: "Research", connection: { provider: "openrouter", model: "x-ai/grok-4", apiKey: "or-key-123456" } }

function post(body: unknown, id = "agent-1") {
  return POST(new Request(`https://agentic-city.test/api/x402/agents/${id}/task`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
}

describe("POST /api/x402/agents/[id]/task", () => {
  beforeEach(() => {
    generate.mockReset().mockResolvedValue("respuesta")
    requirePayment.mockReset().mockResolvedValue(paid)
  })
  afterEach(() => vi.restoreAllMocks())

  it("charges first, then runs the agent and returns the result with a receipt", async () => {
    const res = await post({ task: "resumí x402", agent })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ ok: true, agentId: "agent-1", result: "respuesta", receipt: { transaction: "settle-sig", payer: "payer", amount: "10000", explorerUrl: "https://explorer.solana.com/tx/settle-sig?cluster=devnet" } })
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy()
    expect(requirePayment.mock.invocationCallOrder[0]).toBeLessThan(generate.mock.invocationCallOrder[0])
    expect(generate.mock.calls[0][0]).toEqual({ provider: "openrouter", model: "x-ai/grok-4", apiKey: "or-key-123456" })
  })

  it("records which agent the settled payment was for, so it can be reviewed", async () => {
    setKvStoreForTests(createMemoryStore())
    try {
      expect((await post({ task: "hola", agent })).status).toBe(200)
      expect(await getPaymentAgent("settle-sig")).toBe("legacy/agent-1")
      // A replayed signature never re-binds to another agent.
      await post({ task: "hola", agent }, "agent-2")
      expect(await getPaymentAgent("settle-sig")).toBe("legacy/agent-1")

      // If the store is down the paid task still completes.
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
      setKvStoreForTests({ ...createMemoryStore(), set: vi.fn().mockRejectedValue(new Error("KV SET failed")) })
      expect((await post({ task: "hola", agent })).status).toBe(200)
      expect(error).toHaveBeenCalled()
    } finally {
      setKvStoreForTests(null)
    }
  })

  it("adds a public receipt (no task text, short payer) to the receipts log", async () => {
    const backend = createMemoryReceiptBackend()
    setReceiptBackendForTests(backend)
    try {
      const tx = "5".repeat(88)
      const payer = "Bp6mXwYzAbCdEfGhJkLmNpQrStUvWxYz12345678abcd"
      requirePayment.mockResolvedValue({ ...paid, settle: { ...settle, transaction: tx }, payer, requirements: { amount: "10000", asset: USDC_DEVNET_MINT } })
      expect((await post({ task: "resumí mi contrato secreto", agent })).status).toBe(200)
      const [record] = await readReceiptLog(backend)
      expect(record).toMatchObject({ type: "payment", tx, amount: "10000", asset: "USDC", agentId: "agent-1", agentName: "Investigador", payer: "Bp6m…abcd" })
      expect(JSON.stringify(record)).not.toMatch(/secreto|or-key/)
    } finally {
      setReceiptBackendForTests(null)
    }
  })

  it("validates the task and the model before asking for payment", async () => {
    expect((await post({ task: "", agent })).status).toBe(400)
    expect((await post({ task: "x".repeat(2001), agent })).status).toBe(400)
    expect((await post({ task: "hola", agent: { connection: { provider: "nope", model: "m", apiKey: "k-12345678" } } })).status).toBe(400)
    expect((await post({ task: "hola", agent: { connection: { provider: "openai", model: "m", apiKey: "short" } } })).status).toBe(400)
    expect((await post({ task: "hola" })).status).toBe(400)
    expect(requirePayment).not.toHaveBeenCalled()
  })

  it("returns the payment challenge unchanged when unpaid", async () => {
    requirePayment.mockResolvedValue({ ok: false, response: new Response("{}", { status: 402 }) })
    const res = await post({ task: "hola", agent })
    expect(res.status).toBe(402)
    expect(generate).not.toHaveBeenCalled()
  })

  it("keeps the receipt when the model fails after payment", async () => {
    generate.mockRejectedValue(new Error("OpenRouter rejected the request (HTTP 402)."))
    const res = await post({ task: "hola", agent: { connection: agent.connection } })
    const data = await res.json()
    expect(res.status).toBe(502)
    expect(data).toMatchObject({ ok: false, error: "OpenRouter rejected the request (HTTP 402).", receipt: { transaction: "settle-sig" } })
  })

  it("rejects login-based connections when OpenRouter is not connected", async () => {
    const res = await POST(new Request("https://agentic-city.test/api/x402/agents/a/task", {
      method: "POST", headers: { origin: "https://agentic-city.test" },
      body: JSON.stringify({ task: "hola", agent: { connection: { provider: "openrouter", model: "m", apiKey: "", auth: "oauth" } } }),
    }), { params: Promise.resolve({ id: "a" }) })
    expect(res.status).toBe(401)
    expect(requirePayment).not.toHaveBeenCalled()
  })
})
