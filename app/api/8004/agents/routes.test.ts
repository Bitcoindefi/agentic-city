import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Keypair } from "@solana/web3.js"

const identity = vi.hoisted(() => ({ getIdentityStatus: vi.fn(), registerAgentIdentity: vi.fn(), prepareFeedback: vi.fn() }))
vi.mock("@/lib/solana/agent-identity", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/solana/agent-identity")>()), ...identity }))
const userAuth = vi.hoisted(() => ({ getSessionUser: vi.fn(), isGoogleConfigured: vi.fn() }))
vi.mock("@/lib/auth/user-auth", () => userAuth)

import { GET as status } from "@/app/api/8004/agents/[id]/route"
import { GET as registration } from "@/app/api/8004/agents/[id]/registration.json/route"
import { POST as register } from "@/app/api/8004/agents/[id]/register/route"
import { POST as feedback } from "@/app/api/8004/agents/[id]/feedback/route"
import { IdentityError, agentAssetKeypair } from "@/lib/solana/agent-identity"
import { ownerTagFor } from "@/lib/solana/agent-owner"
import { REGISTRATION_LIMITS } from "@/lib/solana/registration-quota"
import { BROWSER_ID_COOKIE, browserIdCookie } from "@/lib/identity/browser-id"
import { createMemoryStore, getKvStore, setKvStoreForTests, type KvStore } from "@/lib/security/kv-store"
import { createMemoryReceiptBackend, readReceiptLog, setReceiptBackendForTests } from "@/lib/receipts/log"
import { firstSignature } from "@/lib/receipts/review-confirm"

/** The pending review the last prepared feedback left in the store (fee payer signature = 0x07 * 64). */
async function pendingReviewForTest() {
  const signature = firstSignature(Buffer.from(Uint8Array.from([2, ...new Array(64).fill(7), ...new Array(64).fill(0)])).toString("base64"))
  const raw = await getKvStore().get(`ac:receipts:pending-review:${signature}`)
  return raw ? JSON.parse(raw) : null
}

const ORIGIN = "https://agentic-city.test"
const UID = "5".repeat(32)
const browserCookie = (id: string) => `${BROWSER_ID_COOKIE}=${encodeURIComponent(browserIdCookie(id).value)}`
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const server = Keypair.fromSeed(new Uint8Array(32).fill(3))

function post(path: string, body: unknown, headers: Record<string, string | null> = {}) {
  const all: Record<string, string> = {}
  for (const [name, value] of Object.entries({ "content-type": "application/json", origin: ORIGIN, ...headers })) if (value !== null) all[name] = value
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: all, body: JSON.stringify(body) })
}

describe("8004 routes", () => {
  const env = { ...process.env }
  let cookie = ""
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "routes-test-secret"
    process.env.SOLANA_SERVER_SECRET = JSON.stringify(Array.from(server.secretKey))
    process.env.X402_SOLANA_PAY_TO = "F8HEGS2wyZhLDXsFXRti74bRiGNUmEFS4SANZBU3p5h"
    Object.values(identity).forEach((fn) => fn.mockReset())
    userAuth.getSessionUser.mockReset().mockResolvedValue(null)
    userAuth.isGoogleConfigured.mockReset().mockReturnValue(false)
    setKvStoreForTests(createMemoryStore())
    cookie = browserCookie(UID)
  })
  afterEach(() => {
    process.env = { ...env }
    setKvStoreForTests(null)
  })

  it("GET status returns the owner-scoped identity, the public treasury keys, or the error status", async () => {
    identity.getIdentityStatus.mockResolvedValue({ agentId: "a", asset: "A", registered: true, explorerUrl: "u", reputation: null })
    const ok = await (await status(new Request(ORIGIN, { headers: { cookie } }), ctx("a"))).json()
    expect(ok).toMatchObject({ ok: true, registered: true, treasury: { feePayer: server.publicKey.toBase58(), payTo: "F8HEGS2wyZhLDXsFXRti74bRiGNUmEFS4SANZBU3p5h" } })
    expect(identity.getIdentityStatus.mock.calls[0][0]).toEqual({ id: "a", ownerTag: ownerTagFor(`browser:${UID}`) })
    await status(new Request(ORIGIN), ctx("a"))
    expect(identity.getIdentityStatus.mock.calls[1][0]).toEqual({ id: "a", ownerTag: null })

    identity.getIdentityStatus.mockRejectedValue(new IdentityError("Agent identity is not configured on this server.", 503))
    expect((await status(new Request(ORIGIN), ctx("a"))).status).toBe(503)
    identity.getIdentityStatus.mockRejectedValue(new Error("rpc down at 10.0.0.1"))
    const failed = await status(new Request(ORIGIN), ctx("a"))
    expect(failed.status).toBe(502)
    expect((await failed.json()).error).toBe("Could not read the registry.")
  })

  it("serves the registration file with the derived asset, owner-scoped when tagged", async () => {
    const res = await registration(new Request(`${ORIGIN}/api/8004/agents/a/registration.json?n=Bot&m=model`), ctx("a"))
    const data = await res.json()
    expect(data).toMatchObject({ name: "Bot", x402Support: true })
    expect(data.registrations[0].agentId).toBe(agentAssetKeypair(server, "a").publicKey.toBase58())
    const tag = "c".repeat(20)
    const tagged = await (await registration(new Request(`${ORIGIN}/api/8004/agents/a/registration.json?o=${tag}`), ctx("a"))).json()
    expect(tagged.registrations[0].agentId).toBe(agentAssetKeypair(server, "a", tag).publicKey.toBase58())
    delete process.env.SOLANA_SERVER_SECRET
    expect((await (await registration(new Request(`${ORIGIN}/x`), ctx("a"))).json()).registrations).toEqual([])
  })

  it("register requires a same-origin request (Origin or Sec-Fetch-Site) but no sign-in", async () => {
    expect((await register(post("/api/8004/agents/a/register", {}, { origin: "https://evil.test", cookie }), ctx("a"))).status).toBe(403)
    expect((await register(post("/api/8004/agents/a/register", {}, { origin: null, cookie }), ctx("a"))).status).toBe(403)
    expect((await register(post("/api/8004/agents/a/register", {}, { origin: null, "sec-fetch-site": "cross-site", cookie }), ctx("a"))).status).toBe(403)
    expect(identity.registerAgentIdentity).not.toHaveBeenCalled()

    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: "s", alreadyRegistered: false })
    expect((await register(post("/api/8004/agents/a/register", {}, { origin: null, "sec-fetch-site": "same-origin", cookie }), ctx("a"))).status).toBe(200)

    // A first-time visitor (no cookie at all) registers too, and gets its browser id cookie.
    const fresh = await register(post("/api/8004/agents/a/register", { name: "Bot" }), ctx("a"))
    expect(fresh.status).toBe(200)
    const setCookie = fresh.headers.getSetCookie()
    expect(setCookie).toHaveLength(1)
    expect(setCookie[0]).toMatch(/^ac_uid=.+; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure$/)
    const tag = identity.registerAgentIdentity.mock.calls[1][0].ownerTag
    expect(tag).toMatch(/^[0-9a-f]{20}$/)
    expect(tag).not.toBe(ownerTagFor(`browser:${UID}`))
    // A returning browser keeps its id: no new cookie.
    expect((await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))).headers.getSetCookie()).toEqual([])
  })

  it("register is unavailable when the server cannot keep identities", async () => {
    delete process.env.SOLANA_SERVER_SECRET
    const res = await register(post("/api/8004/agents/a/register", {}), ctx("a"))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain("not configured")
  })

  it("register uses the Google account when the person chose to sign in, and works without it", async () => {
    userAuth.isGoogleConfigured.mockReturnValue(true)
    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: "s", alreadyRegistered: false })
    expect((await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))).status).toBe(200)
    expect(identity.registerAgentIdentity.mock.calls[0][0]).toMatchObject({ ownerTag: ownerTagFor(`browser:${UID}`) })

    userAuth.getSessionUser.mockResolvedValue({ name: "Ana", email: "ana@example.com", image: null })
    expect((await register(post("/api/8004/agents/a/register", { name: "Bot" }), ctx("a"))).status).toBe(200)
    expect(identity.registerAgentIdentity.mock.calls[1][0]).toMatchObject({ id: "a", name: "Bot", ownerTag: ownerTagFor("google:ana@example.com") })
  })

  it("register caps registrations per client IP", async () => {
    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: "s", alreadyRegistered: false })
    const ip = { "x-real-ip": "203.0.113.9" }
    for (let i = 0; i < REGISTRATION_LIMITS.perIpPerDay; i += 1) {
      expect((await register(post(`/api/8004/agents/a${i}/register`, {}, { ...ip, cookie: browserCookie(String(i % 10).repeat(32)) }), ctx(`a${i}`))).status).toBe(200)
    }
    const limited = await register(post("/api/8004/agents/z/register", {}, ip), ctx("z"))
    expect(limited.status).toBe(429)
    expect((await limited.json()).error).toContain(`${REGISTRATION_LIMITS.perIpPerDay} agents per day`)
  })

  it("register runs for a connected browser and maps treasury errors", async () => {
    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: "s", alreadyRegistered: false })
    const ok = await register(post("/api/8004/agents/a/register", { name: "Bot", model: "m", role: "r" }, { cookie }), ctx("a"))
    expect(await ok.json()).toMatchObject({ ok: true, asset: "A" })
    expect(identity.registerAgentIdentity.mock.calls[0][0]).toEqual({ id: "a", name: "Bot", role: "r", model: "m", ownerTag: ownerTagFor(`browser:${UID}`) })

    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: null, alreadyRegistered: true })
    expect((await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))).status).toBe(200)

    identity.registerAgentIdentity.mockRejectedValue(new Error("Attempt to debit an account but found no record of a prior credit. insufficient lamports"))
    const broke = await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))
    expect(broke.status).toBe(502)
    expect((await broke.json()).error).toContain("no devnet SOL")
    identity.registerAgentIdentity.mockRejectedValue(new IdentityError("not configured", 503))
    expect((await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))).status).toBe(503)
    identity.registerAgentIdentity.mockRejectedValue(new Error("internal rpc detail"))
    const hidden = await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))
    expect((await hidden.json()).error).not.toContain("internal rpc detail")
  })

  it("register enforces the per-owner daily quota, not counting failed or repeated registrations", async () => {
    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: null, alreadyRegistered: true })
    for (let i = 0; i < REGISTRATION_LIMITS.perOwnerPerDay + 2; i += 1) {
      expect((await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))).status).toBe(200)
    }
    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: "s", alreadyRegistered: false })
    for (let i = 0; i < REGISTRATION_LIMITS.perOwnerPerDay; i += 1) {
      expect((await register(post(`/api/8004/agents/a${i}/register`, {}, { cookie }), ctx(`a${i}`))).status).toBe(200)
    }
    const limited = await register(post("/api/8004/agents/z/register", {}, { cookie }), ctx("z"))
    expect(limited.status).toBe(429)
    expect((await limited.json()).error).toContain(`${REGISTRATION_LIMITS.perOwnerPerDay} agents per day`)
    // Another owner still has quota.
    const other = browserCookie("6".repeat(32))
    expect((await register(post("/api/8004/agents/z/register", {}, { cookie: other }), ctx("z"))).status).toBe(200)
  })

  it("register answers 429 at the global cap and 503 when the quota store is down", async () => {
    const store = createMemoryStore()
    const day = new Date().toISOString().slice(0, 10)
    for (let i = 0; i < REGISTRATION_LIMITS.globalPerDay; i += 1) await store.incr(`ac:8004:register:${day}:global`, 60)
    setKvStoreForTests(store)
    identity.registerAgentIdentity.mockResolvedValue({ asset: "A", signature: "s", alreadyRegistered: false })
    const capped = await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))
    expect(capped.status).toBe(429)
    expect((await capped.json()).error).toContain("Too many registrations today")

    const down: KvStore = { ...createMemoryStore(), incr: vi.fn().mockRejectedValue(new Error("KV INCR failed")) }
    setKvStoreForTests(down)
    expect((await register(post("/api/8004/agents/a/register", {}, { cookie }), ctx("a"))).status).toBe(503)
    expect(identity.registerAgentIdentity).not.toHaveBeenCalled()
  })

  it("register adds a new identity (not a repeated one) to the public receipts log", async () => {
    const backend = createMemoryReceiptBackend()
    setReceiptBackendForTests(backend)
    try {
      const asset = server.publicKey.toBase58()
      identity.registerAgentIdentity.mockResolvedValue({ asset, signature: "5".repeat(88), alreadyRegistered: false })
      expect((await register(post("/api/8004/agents/research/register", { name: "Investigador" }, { cookie }), ctx("research"))).status).toBe(200)
      identity.registerAgentIdentity.mockResolvedValue({ asset, signature: null, alreadyRegistered: true })
      expect((await register(post("/api/8004/agents/research/register", { name: "Investigador" }, { cookie }), ctx("research"))).status).toBe(200)
      const records = await readReceiptLog(backend)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ type: "registration", agentId: "research", agentName: "Investigador", identity: asset, payer: null })
      expect(JSON.stringify(records[0])).not.toContain(ownerTagFor(`browser:${UID}`) as string)
    } finally {
      setReceiptBackendForTests(null)
    }
  })

  it("feedback remembers the prepared review and only logs a reported signature it prepared", async () => {
    const tx = new Uint8Array(1 + 64 * 2 + 4)
    tx[0] = 2
    tx.fill(7, 1, 65)
    identity.prepareFeedback.mockResolvedValue({ transaction: Buffer.from(tx).toString("base64"), asset: "A" })
    expect((await feedback(post("/api/8004/agents/a/feedback", { score: 100, paymentSignature: "p", payer: "w", agentName: "Bot" }, { cookie }), ctx("a"))).status).toBe(200)
    const pending = await pendingReviewForTest()
    expect(pending).toMatchObject({ agentId: "a", agentName: "Bot", payer: "w", score: 100 })

    const unknown = await feedback(post("/api/8004/agents/a/feedback", { reviewSignature: "5".repeat(88) }), ctx("a"))
    expect(unknown.status).toBe(404)
    expect((await feedback(post("/api/8004/agents/a/feedback", { reviewSignature: "nope" }), ctx("a"))).status).toBe(400)
    expect((await feedback(post("/api/8004/agents/a/feedback", { reviewSignature: "5".repeat(88) }, { origin: "https://evil.test" }), ctx("a"))).status).toBe(403)
  })

  it("feedback needs a same-origin request and a payment, and returns the prepared transaction", async () => {
    expect((await feedback(post("/api/8004/agents/a/feedback", {}, { origin: "https://evil.test" }), ctx("a"))).status).toBe(403)
    expect((await feedback(post("/api/8004/agents/a/feedback", { score: 100, paymentSignature: "p", payer: "w" }, { origin: null }), ctx("a"))).status).toBe(403)
    expect((await feedback(post("/api/8004/agents/a/feedback", { score: 100 }), ctx("a"))).status).toBe(400)
    identity.prepareFeedback.mockResolvedValue({ transaction: "base64", asset: "A" })
    const ok = await feedback(post("/api/8004/agents/a/feedback", { score: 100, paymentSignature: "p", payer: "w" }, { cookie }), ctx("a"))
    expect(await ok.json()).toEqual({ ok: true, transaction: "base64", asset: "A" })
    expect(identity.prepareFeedback.mock.calls[0][0]).toEqual({ agentId: "a", ownerTag: ownerTagFor(`browser:${UID}`), score: 100, paymentSignature: "p", payer: "w" })
    identity.prepareFeedback.mockRejectedValue(new IdentityError("No x402 payment from this wallet to the agent was found.", 403))
    expect((await feedback(post("/api/8004/agents/a/feedback", { score: 100, paymentSignature: "p", payer: "w" }), ctx("a"))).status).toBe(403)
    identity.prepareFeedback.mockRejectedValue(new Error("rpc"))
    const failed = await feedback(post("/api/8004/agents/a/feedback", { score: 100, paymentSignature: "p", payer: "w" }), ctx("a"))
    expect(failed.status).toBe(502)
    expect((await failed.json()).error).toBe("Could not prepare the review.")
  })
})
