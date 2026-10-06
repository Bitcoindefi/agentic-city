import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { GET as listOffers, POST as createOffer } from "@/app/api/task-offers/route"
import { DELETE as cancelOffer, GET as getOffer } from "@/app/api/task-offers/[id]/route"
import { resetTaskOffersForTests } from "@/lib/task-market/offers"

async function mockRequest(url: string, options?: RequestInit): Promise<Request> {
  return new Request(url, options)
}

async function mockContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) } as any
}

describe("Task offer API", () => {
  beforeEach(() => {
    resetTaskOffersForTests()
  })

  afterEach(() => {
    resetTaskOffersForTests()
  })

  it("creates and lists open offers by required capability", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600
    const createReq = await mockRequest("http://localhost:3000/api/task-offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postedBy: "agent-alpha",
        requiredCapability: "run-inference",
        payload: { prompt: "summarize this" },
        reward: "0.05 XLM",
        deadline,
      }),
    })

    const createRes = await createOffer(createReq)
    const createData = await createRes.json()
    expect(createRes.status).toBe(201)
    expect(createData.ok).toBe(true)
    expect(createData.offerId).toMatch(/^off_/)
    expect(createData.escrowTx).toMatch(/^escrow_/)
    expect(createData.offer.reward).toEqual({ amount: "0.05", asset: "XLM" })

    const listReq = await mockRequest("http://localhost:3000/api/task-offers?cap=run-inference")
    const listRes = await listOffers(listReq)
    const listData = await listRes.json()
    expect(listRes.status).toBe(200)
    expect(listData.ok).toBe(true)
    expect(listData.offers).toHaveLength(1)
    expect(listData.offers[0].offerId).toBe(createData.offerId)
  })

  it("returns a single offer by id", async () => {
    const createRes = await createOffer(await mockRequest("http://localhost:3000/api/task-offers", {
      method: "POST",
      body: JSON.stringify({
        postedBy: "agent-beta",
        requiredCapability: "classify",
        reward: { amount: "1.5", asset: "USDC" },
        deadline: Math.floor(Date.now() / 1000) + 3600,
      }),
    }))
    const { offerId } = await createRes.json()

    const response = await getOffer(
      await mockRequest(`http://localhost:3000/api/task-offers/${offerId}`),
      await mockContext({ id: offerId }),
    )
    const data = await response.json()
    expect(response.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.offer.postedBy).toBe("agent-beta")
  })

  it("lets only the poster cancel an open offer", async () => {
    const createRes = await createOffer(await mockRequest("http://localhost:3000/api/task-offers", {
      method: "POST",
      body: JSON.stringify({
        postedBy: "agent-owner",
        requiredCapability: "translate",
        reward: "0.25 XLM",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      }),
    }))
    const { offerId } = await createRes.json()

    const forbidden = await cancelOffer(
      await mockRequest(`http://localhost:3000/api/task-offers/${offerId}?agentId=other-agent`, { method: "DELETE" }),
      await mockContext({ id: offerId }),
    )
    expect(forbidden.status).toBe(403)

    const response = await cancelOffer(
      await mockRequest(`http://localhost:3000/api/task-offers/${offerId}`, {
        method: "DELETE",
        headers: { "x-agent-id": "agent-owner" },
      }),
      await mockContext({ id: offerId }),
    )
    const data = await response.json()
    expect(response.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.offer.status).toBe("cancelled")
    expect(data.refundTx).toMatch(/^refund_/)
  })

  it("rejects invalid rewards and expired deadlines", async () => {
    const invalidReward = await createOffer(await mockRequest("http://localhost:3000/api/task-offers", {
      method: "POST",
      body: JSON.stringify({
        postedBy: "agent-alpha",
        requiredCapability: "run-inference",
        reward: "free",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      }),
    }))
    expect(invalidReward.status).toBe(400)

    const expiredDeadline = await createOffer(await mockRequest("http://localhost:3000/api/task-offers", {
      method: "POST",
      body: JSON.stringify({
        postedBy: "agent-alpha",
        requiredCapability: "run-inference",
        reward: "0.05 XLM",
        deadline: Math.floor(Date.now() / 1000) - 1,
      }),
    }))
    expect(expiredDeadline.status).toBe(400)
  })
})
