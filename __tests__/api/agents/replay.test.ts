import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET, DELETE } from "@/app/api/agents/[id]/replay/route"
import { getAgentReplay, resetAgentReplayForTests } from "@/lib/events/agent-replay"
import { publishSystemEvent, subscribeToSystemEvents } from "@/lib/events/system-events"
import { createApiKey, resetApiKeyStore } from "@/lib/auth/api-keys"
import { evaluateAuth } from "@/lib/auth/middleware"
import type { Quest } from "@/lib/quests/quest-store"

function context(id = "bot-1") {
  return { params: Promise.resolve({ id }) }
}

function request(method = "GET", token = "") {
  return new Request("https://example.test/api/agents/bot-1/replay", {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

beforeEach(() => {
  resetAgentReplayForTests()
  resetApiKeyStore()
  vi.stubEnv("DEV_MODE", "false")
})

afterEach(() => {
  resetAgentReplayForTests()
  vi.unstubAllEnvs()
})

describe("per-agent event replay", () => {
  it("records bus events with their full payload and a recording timestamp", async () => {
    publishSystemEvent({ type: "task.started", agentId: "bot-1", task: { id: "task-1", title: "Index" } })
    const response = await GET(request(), context())
    const data = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(data).toMatchObject({ agentId: "bot-1", bufferSize: 50, count: 1 })
    expect(data.events[0]).toMatchObject({ type: "task.started", payload: { agentId: "bot-1", task: { id: "task-1", title: "Index" } } })
    expect(new Date(data.events[0].recordedAt).toISOString()).toBe(data.events[0].recordedAt)
  })

  it("evicts precisely the oldest event at the 51st event and survives repeated wraps", async () => {
    for (let index = 1; index <= 153; index++) {
      publishSystemEvent({ type: "task.completed", agentId: "bot-1", taskId: String(index), result: { summary: "done" } })
      if (index === 51) {
        expect(getAgentReplay("bot-1").map(event => event.payload.taskId)).toEqual(
          Array.from({ length: 50 }, (_, offset) => String(51 - offset)),
        )
      }
    }
    const data = await (await GET(request(), context())).json()
    expect(data.count).toBe(50)
    expect(data.events.map((event: { payload: { taskId: string } }) => event.payload.taskId)).toEqual(
      Array.from({ length: 50 }, (_, offset) => String(153 - offset)),
    )
  })

  it("keeps buffers isolated and ignores events without an agent", () => {
    publishSystemEvent({ type: "agent.status", agentId: "bot-1", status: "active" })
    publishSystemEvent({ type: "agent.status", agentId: "bot-2", status: "working" })
    publishSystemEvent({ type: "district.unlocked", districtId: "research" })
    expect(getAgentReplay("bot-1")).toHaveLength(1)
    expect(getAgentReplay("bot-2")[0].payload.agentId).toBe("bot-2")
    expect(getAgentReplay("missing")).toEqual([])
  })

  it("returns an explicit empty buffer for an agent with no events", async () => {
    expect(await (await GET(request(), context("missing"))).json()).toEqual({
      agentId: "missing", events: [], bufferSize: 50, count: 0,
    })
  })

  it("records different event types in publication order rather than sorting caller timestamps", () => {
    publishSystemEvent({ type: "agent.status", agentId: "bot-1", status: "active", occurredAt: "2026-10-02T10:00:00.000Z" })
    publishSystemEvent({ type: "agent.xp", agentId: "bot-1", xp: 10, level: 1, occurredAt: "2026-10-01T10:00:00.000Z" })
    publishSystemEvent({ type: "quest.completed", agentId: "bot-1", questId: "quest-1" })
    expect(getAgentReplay("bot-1").map(event => event.type)).toEqual(["quest.completed", "agent.xp", "agent.status"])
  })

  it("clears one agent without clearing another and accepts new events afterwards", async () => {
    for (const agentId of ["bot-1", "bot-2"]) publishSystemEvent({ type: "agent.status", agentId, status: "active" })
    expect((await DELETE(request("DELETE"), context())).status).toBe(200)
    expect((await (await GET(request(), context())).json()).count).toBe(0)
    expect(getAgentReplay("bot-2")).toHaveLength(1)
    publishSystemEvent({ type: "agent.status", agentId: "bot-1", status: "working" })
    expect(getAgentReplay("bot-1")).toHaveLength(1)
  })

  it("snapshots before listeners mutate payloads and protects records from reader mutation", () => {
    const release = subscribeToSystemEvents(event => {
      if (event.type === "task.started") event.task.title = "changed by listener"
    })
    try {
      publishSystemEvent({ type: "task.started", agentId: "bot-1", task: { id: "task-1", title: "original" } })
      const record = getAgentReplay("bot-1")[0]
      expect(record.payload.task).toEqual({ id: "task-1", title: "original" })
      record.payload.task = { id: "changed", title: "changed by reader" }
      expect(getAgentReplay("bot-1")[0].payload.task).toEqual({ id: "task-1", title: "original" })
    } finally {
      release()
    }
  })

  it("keeps nested listener publications newest first", () => {
    const release = subscribeToSystemEvents(event => {
      if (event.type === "task.started") {
        publishSystemEvent({ type: "agent.status", agentId: "bot-1", status: "working" })
      }
    })
    try {
      publishSystemEvent({ type: "task.started", agentId: "bot-1", task: { id: "task-1", title: "Nested" } })
      expect(getAgentReplay("bot-1").map(event => event.type)).toEqual(["agent.status", "task.started"])
    } finally {
      release()
    }
  })

  it.each(["quest.abandoned", "quest.expired"] as const)("associates %s cron events with the assigned agent", type => {
    const quest: Quest = {
      id: "quest-1", title: "Recover", status: type === "quest.abandoned" ? "abandoned" : "expired",
      assignedTo: "bot-1", applicants: ["bot-2"],
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
    }
    const publishQuest = (quest: Quest) => {
      if (type === "quest.abandoned") publishSystemEvent({ type, questId: quest.id, quest })
      else publishSystemEvent({ type, questId: quest.id, quest })
    }
    publishQuest(quest)
    expect(getAgentReplay("bot-1")[0]).toMatchObject({ type, payload: { quest } })
    expect(getAgentReplay("bot-2")).toEqual([])
    publishQuest({ ...quest, id: "unassigned", assignedTo: null })
    expect(getAgentReplay("bot-1")).toHaveLength(1)
  })

  it("uses the existing public GET middleware policy", async () => {
    expect(await evaluateAuth(request())).toMatchObject({ allowed: true, status: 200 })
    expect((await GET(request(), context())).status).toBe(200)
  })

  it.each(["", "wrong-gateway"])("middleware rejects unauthorized deletion (%s) without clearing data", async token => {
    publishSystemEvent({ type: "agent.status", agentId: "bot-1", status: "active" })
    expect(await evaluateAuth(request("DELETE", token))).toMatchObject({ allowed: false, status: 401 })
    expect(getAgentReplay("bot-1")).toHaveLength(1)
  })

  it("middleware rejects deletion with a valid key lacking agents:write", async () => {
    const { key } = await createApiKey({ name: "reader", scopes: ["telemetry:write"] })
    expect(await evaluateAuth(request("DELETE", key))).toMatchObject({ allowed: false, status: 403 })
  })

  it("allows a scoped agents:write key through middleware and the DELETE route", async () => {
    const { key } = await createApiKey({ name: "replay-operator", scopes: ["agents:write"] })
    publishSystemEvent({ type: "agent.status", agentId: "bot-1", status: "active" })
    const req = request("DELETE", key)
    expect(await evaluateAuth(req)).toMatchObject({ allowed: true, status: 200 })
    const response = await DELETE(req, context())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(getAgentReplay("bot-1")).toEqual([])
    expect(await response.text()).not.toContain(key)
  })
})
