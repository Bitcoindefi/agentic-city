import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "@/app/api/admin/send-weekly-summary/route"
import { registerAgent, resetAgentRegistryForTests } from "@/lib/agent-registry"
import { publishSystemEvent, resetPublishedEventsForTests } from "@/lib/events/system-events"
import { renderWeeklySummaryEmail, type AgentWeeklySummary } from "@/lib/email/weekly-summary"

const sendMock = vi.fn()

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function ResendMock() {
    return { emails: { send: sendMock } }
  }),
}))

const manifest = (agentId: string, email: string, emailOptOut = false) => ({
  agentId,
  email,
  emailOptOut,
  model: "claude-haiku-4-5",
  district: "data-center",
  capabilities: ["quests"],
  x402: { accepts: true },
  status: "active",
  endpoint: `https://example.com/${agentId}`,
})

beforeEach(() => {
  resetAgentRegistryForTests()
  resetPublishedEventsForTests()
  sendMock.mockReset()
  sendMock.mockResolvedValue({ data: { id: "sandbox-email" }, error: null })
  process.env.MOLTBOT_GATEWAY_TOKEN = "admin-token"
  process.env.RESEND_API_KEY = "re_test_sandbox"
})

describe("POST /api/admin/send-weekly-summary", () => {
  it("sends weekly summaries to registered agent emails and respects opt-out", async () => {
    registerAgent(manifest("agent-send", "Send@Example.com"))
    registerAgent(manifest("agent-opt-out", "optout@example.com", true))

    publishSystemEvent({
      type: "quest.completed",
      agentId: "agent-send",
      questId: "quest-1",
      quest: { title: "Map the nebula" },
      occurredAt: "2026-06-24T12:00:00.000Z",
    })
    publishSystemEvent({
      type: "agent.xp",
      agentId: "agent-send",
      xp: 75,
      totalXp: 75,
      level: 1,
      occurredAt: "2026-06-24T12:01:00.000Z",
    })
    publishSystemEvent({
      type: "badge.unlocked",
      agentId: "agent-send",
      badge: { id: "first-quest", name: "First Quest Completed", rarity: "common" },
      occurredAt: "2026-06-24T12:02:00.000Z",
    })

    const response = await POST(new Request("http://localhost/api/admin/send-weekly-summary", {
      method: "POST",
      headers: { authorization: "Bearer admin-token", "x-open-stellar-now": "2026-06-28T12:00:00.000Z" },
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "send@example.com",
      subject: "Open Stellar weekly summary for agent-send",
      text: expect.stringContaining("Map the nebula"),
      html: expect.stringContaining("First Quest Completed"),
    }))
    expect(body.results).toEqual([
      expect.objectContaining({ agentId: "agent-send", to: "send@example.com", skipped: false }),
      expect.objectContaining({ agentId: "agent-opt-out", to: "optout@example.com", skipped: true, reason: "agent opted out of email" }),
    ])
  })

  it("requires admin authorization", async () => {
    const response = await POST(new Request("http://localhost/api/admin/send-weekly-summary", { method: "POST" }))
    expect(response.status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe("weekly summary template", () => {
  const baseSummary: AgentWeeklySummary = {
    agentId: "agent-template",
    agentName: "agent-template",
    questsCompleted: [],
    xpEarned: 0,
    level: 1,
    previousLevel: null,
    leveledUp: false,
    leaderboardRank: null,
    previousLeaderboardRank: null,
    weekStartsAt: "2026-06-21T00:00:00.000Z",
    weekEndsAt: "2026-06-28T00:00:00.000Z",
  }

  it("renders the 0-quest scenario", () => {
    const email = renderWeeklySummaryEmail(baseSummary)
    expect(email.text).toContain("Quests completed: 0")
    expect(email.text).toContain("No quests completed this week")
    expect(email.html).toContain("Quests completed: 0")
  })

  it("renders the 5+-quest scenario", () => {
    const email = renderWeeklySummaryEmail({
      ...baseSummary,
      questsCompleted: Array.from({ length: 6 }, (_, index) => ({
        questId: `quest-${index}`,
        title: `Quest ${index + 1}`,
        completedAt: "2026-06-24T12:00:00.000Z",
      })),
      xpEarned: 360,
      level: 2,
      leveledUp: true,
      leaderboardRank: 1,
      previousLeaderboardRank: 3,
    })
    expect(email.text).toContain("Quests completed: 6")
    expect(email.text).toContain("6. Quest 6")
    expect(email.text).toContain("New level: 2")
    expect(email.html).toContain("<li>Quest 6</li>")
  })
})
