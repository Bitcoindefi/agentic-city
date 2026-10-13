import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { GET as getBulkPresence } from "@/app/api/agents/presence/route"
import { GET as getSingleHealth } from "@/app/api/agents/[id]/health/route"
import {
  recordAgentHeartbeat,
  resetAgentHealthStore,
  getAgentPresence,
  getBulkAgentPresence,
  OFFLINE_AFTER_MS,
} from "@/lib/agents/agent-health-store"

describe("Agent Presence (Issue #327)", () => {
  const baseNow = Date.parse("2026-09-15T00:00:00.000Z")

  beforeEach(() => {
    resetAgentHealthStore()
  })

  afterEach(() => {
    resetAgentHealthStore()
  })

  describe("lib/agents/agent-health-store presence helpers", () => {
    it("correctly identifies healthy, offline, and unknown agent presence", () => {
      // 1. Healthy: heartbeat within last 30s
      recordAgentHeartbeat("agent-active", {
        status: "active",
        nowMs: baseNow,
      })

      // 2. Offline: heartbeat older than 30s
      recordAgentHeartbeat("agent-dormant", {
        status: "active",
        nowMs: baseNow - OFFLINE_AFTER_MS - 5000,
      })

      // 3. Unknown: never sent a heartbeat
      expect(getAgentPresence("agent-active", baseNow)).toBe("healthy")
      expect(getAgentPresence("agent-dormant", baseNow)).toBe("offline")
      expect(getAgentPresence("agent-never-seen", baseNow)).toBe("unknown")

      const bulk = getBulkAgentPresence(
        ["agent-active", "agent-dormant", "agent-never-seen"],
        baseNow,
      )
      expect(bulk).toEqual({
        "agent-active": "healthy",
        "agent-dormant": "offline",
        "agent-never-seen": "unknown",
      })
    })
  })

  describe("GET /api/agents/presence endpoint", () => {
    it("returns presence map for mix of healthy, offline, and unknown agents", async () => {
      // Seed healthy agent (< 30s ago)
      recordAgentHeartbeat("agent-h1", {
        status: "active",
        nowMs: baseNow,
      })

      // Seed offline agent (> 30s ago)
      recordAgentHeartbeat("agent-o1", {
        status: "idle",
        nowMs: baseNow - 40_000,
      })

      // agent-u1 has never sent a heartbeat

      const req = new Request(
        `http://localhost/api/agents/presence?ids=agent-h1,agent-o1,agent-u1&now=${baseNow}`,
      )
      const res = await getBulkPresence(req)

      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data).toEqual({
        "agent-h1": "healthy",
        "agent-o1": "offline",
        "agent-u1": "unknown",
      })
    })

    it("supports repeated and comma-separated ids query parameters", async () => {
      recordAgentHeartbeat("agent-rep1", { status: "active", nowMs: baseNow })
      recordAgentHeartbeat("agent-rep2", { status: "offline", nowMs: baseNow })

      const req = new Request(
        `http://localhost/api/agents/presence?ids=agent-rep1&ids=agent-rep2,agent-rep3&now=${baseNow}`,
      )
      const res = await getBulkPresence(req)

      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data).toEqual({
        "agent-rep1": "healthy",
        "agent-rep2": "offline",
        "agent-rep3": "unknown",
      })
    })

    it("returns empty map when no ids are provided", async () => {
      const req = new Request("http://localhost/api/agents/presence")
      const res = await getBulkPresence(req)

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({})
    })

    it("enforces maximum 50 IDs limit and returns 400 when exceeded", async () => {
      const tooManyIds = Array.from({ length: 51 }, (_, i) => `agent-${i}`).join(",")
      const req = new Request(`http://localhost/api/agents/presence?ids=${tooManyIds}`)
      const res = await getBulkPresence(req)

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toMatch(/Maximum of 50 agent IDs allowed/i)
    })

    it("single endpoint GET /api/agents/:id/health returns status and 404 for unknown agent", async () => {
      recordAgentHeartbeat("agent-health-check", {
        status: "active",
        nowMs: baseNow,
      })

      const healthyReq = new Request("http://localhost/api/agents/agent-health-check/health")
      const healthyRes = await getSingleHealth(healthyReq, {
        params: Promise.resolve({ id: "agent-health-check" }),
      })
      expect(healthyRes.status).toBe(200)
      const healthyData = await healthyRes.json()
      expect(healthyData.ok).toBe(true)
      expect(healthyData.health.status).toBe("healthy")

      const unknownReq = new Request("http://localhost/api/agents/unknown-agent/health")
      const unknownRes = await getSingleHealth(unknownReq, {
        params: Promise.resolve({ id: "unknown-agent" }),
      })
      expect(unknownRes.status).toBe(404)
    })
  })

  describe("UI presence dot styling (components/agents-registry)", () => {
    it("renders green dot for healthy, red dot for offline, and grey dot for unknown", async () => {
      const { AgentPresenceDot } = await import("@/components/agents-registry")

      const greenDot = AgentPresenceDot({ status: "healthy" })
      expect(greenDot.props["data-presence"]).toBe("healthy")
      expect(greenDot.props.className).toContain("bg-green-500")
      expect(greenDot.props.className).toContain("h-[10px]")
      expect(greenDot.props.className).toContain("w-[10px]")
      expect(greenDot.props.className).toContain("border-white")
      expect(greenDot.props.className).toContain("rounded-full")
      expect(greenDot.props.className).toContain("absolute")

      const redDot = AgentPresenceDot({ status: "offline" })
      expect(redDot.props["data-presence"]).toBe("offline")
      expect(redDot.props.className).toContain("bg-red-500")
      expect(redDot.props.className).toContain("h-[10px]")
      expect(redDot.props.className).toContain("w-[10px]")
      expect(redDot.props.className).toContain("border-white")
      expect(redDot.props.className).toContain("rounded-full")

      const greyDot = AgentPresenceDot({ status: "unknown" })
      expect(greyDot.props["data-presence"]).toBe("unknown")
      expect(greyDot.props.className).toContain("bg-gray-400")
      expect(greyDot.props.className).toContain("h-[10px]")
      expect(greyDot.props.className).toContain("w-[10px]")
      expect(greyDot.props.className).toContain("border-white")
      expect(greyDot.props.className).toContain("rounded-full")

      // Defaults to unknown when status is undefined or null
      const defaultDot = AgentPresenceDot({})
      expect(defaultDot.props["data-presence"]).toBe("unknown")
      expect(defaultDot.props.className).toContain("bg-gray-400")
    })
  })
})

