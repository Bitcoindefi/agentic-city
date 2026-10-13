import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  checkQuestExpiration,
  DEFAULT_QUEST_EXPIRY_WARNING_MS,
  getQuestExpiryWarningThresholdMs,
} from "@/lib/gamification/quests"
import { seedQuest, resetQuestStore } from "@/lib/gamification/quest-store"
import {
  resetNotificationStore,
  listNotifications,
} from "@/lib/notifications/notification-store"
import {
  subscribeToSystemEvents,
  resetPublishedSystemEventLogForTests,
  type PublishedSystemEvent,
} from "@/lib/events/system-events"
import { GET as getAgentNotifications } from "@/app/api/agents/[id]/notifications/route"
import { PATCH as markNotificationAsReadRoute } from "@/app/api/agents/[id]/notifications/[notificationId]/read/route"

describe("Quest Expiration Warnings (Issue #328)", () => {
  const originalEnv = process.env.QUEST_EXPIRY_WARNING_MS

  beforeEach(() => {
    resetQuestStore()
    resetNotificationStore()
    resetPublishedSystemEventLogForTests()
    delete process.env.QUEST_EXPIRY_WARNING_MS
  })

  afterEach(() => {
    resetQuestStore()
    resetNotificationStore()
    resetPublishedSystemEventLogForTests()
    if (originalEnv !== undefined) {
      process.env.QUEST_EXPIRY_WARNING_MS = originalEnv
    } else {
      delete process.env.QUEST_EXPIRY_WARNING_MS
    }
  })

  it("fires quest.expired event and creates notification when quest has < 24h remaining", () => {
    const receivedEvents: PublishedSystemEvent[] = []
    const unsubscribe = subscribeToSystemEvents((event) => {
      if (event.type === "quest.expired") {
        receivedEvents.push(event)
      }
    })

    const now = new Date("2026-09-15T00:00:00.000Z")
    // Quest expires in 12 hours (well inside 24h window)
    const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString()

    seedQuest({
      id: "quest-expiring-soon",
      title: "Expiring Quest",
      expiresAt,
      assignedAgentIds: ["agent-007"],
    })

    const warnings = checkQuestExpiration({ agentId: "agent-007", now })

    expect(warnings).toHaveLength(1)
    expect(warnings[0].questId).toBe("quest-expiring-soon")
    expect(warnings[0].agentId).toBe("agent-007")
    expect(warnings[0].expiresAt).toBe(expiresAt)
    expect(warnings[0].remainingMs).toBe(12 * 60 * 60 * 1000)

    // Check event emission on OS event bus
    expect(receivedEvents.length).toBeGreaterThanOrEqual(1)
    const event = receivedEvents.find((e) => e.type === "quest.expired" && e.questId === "quest-expiring-soon")
    expect(event).toBeDefined()
    expect(event?.agentId).toBe("agent-007")
    expect((event as any).remainingMs).toBe(12 * 60 * 60 * 1000)

    // Check notification store entry
    const notifications = listNotifications("agent-007", { type: "quest_expired", unreadOnly: true })
    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe("quest_expired")
    expect(notifications[0].questId).toBe("quest-expiring-soon")
    expect(notifications[0].expiresAt).toBe(expiresAt)

    unsubscribe()
  })

  it("threshold boundary: fires warning just inside 24h, but skips just outside 24h", () => {
    const now = new Date("2026-09-15T12:00:00.000Z")
    const thresholdMs = DEFAULT_QUEST_EXPIRY_WARNING_MS // 86,400,000 ms = 24h

    // 1. Just inside 24h window (24h minus 1 minute)
    const insideExpiresAt = new Date(now.getTime() + thresholdMs - 60_000).toISOString()
    seedQuest({
      id: "quest-inside-boundary",
      title: "Inside Boundary",
      expiresAt: insideExpiresAt,
      assignedAgentIds: ["agent-boundary"],
    })

    // 2. Just outside 24h window (24h plus 1 minute)
    const outsideExpiresAt = new Date(now.getTime() + thresholdMs + 60_000).toISOString()
    seedQuest({
      id: "quest-outside-boundary",
      title: "Outside Boundary",
      expiresAt: outsideExpiresAt,
      assignedAgentIds: ["agent-boundary"],
    })

    const warnings = checkQuestExpiration({ agentId: "agent-boundary", now })

    const insideWarning = warnings.find((w) => w.questId === "quest-inside-boundary")
    const outsideWarning = warnings.find((w) => w.questId === "quest-outside-boundary")

    expect(insideWarning).toBeDefined()
    expect(insideWarning?.remainingMs).toBeLessThan(thresholdMs)
    expect(outsideWarning).toBeUndefined()

    const notifications = listNotifications("agent-boundary", { type: "quest_expired" })
    expect(notifications.some((n) => n.questId === "quest-inside-boundary")).toBe(true)
    expect(notifications.some((n) => n.questId === "quest-outside-boundary")).toBe(false)
  })

  it("respects QUEST_EXPIRY_WARNING_MS environment variable threshold", () => {
    // Set custom threshold of 2 hours
    const customThresholdMs = 2 * 60 * 60 * 1000
    process.env.QUEST_EXPIRY_WARNING_MS = String(customThresholdMs)

    expect(getQuestExpiryWarningThresholdMs()).toBe(customThresholdMs)

    const now = new Date("2026-09-15T00:00:00.000Z")

    // Quest A: 1 hour remaining (inside 2h custom threshold)
    seedQuest({
      id: "quest-custom-inside",
      title: "Custom Inside",
      expiresAt: new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString(),
      assignedAgentIds: ["agent-custom"],
    })

    // Quest B: 3 hours remaining (outside 2h custom threshold, even though < 24h)
    seedQuest({
      id: "quest-custom-outside",
      title: "Custom Outside",
      expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      assignedAgentIds: ["agent-custom"],
    })

    const warnings = checkQuestExpiration({ agentId: "agent-custom", now })

    expect(warnings.some((w) => w.questId === "quest-custom-inside")).toBe(true)
    expect(warnings.some((w) => w.questId === "quest-custom-outside")).toBe(false)
  })

  it("skips completed quests and already expired quests", () => {
    const now = new Date("2026-09-15T00:00:00.000Z")
    const soonExpiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()

    seedQuest({
      id: "quest-completed",
      title: "Completed",
      expiresAt: soonExpiresAt,
      status: "completed",
      assignedAgentIds: ["agent-status"],
    })

    seedQuest({
      id: "quest-already-expired",
      title: "Already Expired",
      expiresAt: new Date(now.getTime() - 1000).toISOString(),
      status: "expired",
      assignedAgentIds: ["agent-status"],
    })

    const warnings = checkQuestExpiration({ agentId: "agent-status", now })
    expect(warnings).toHaveLength(0)
  })

  it("GET /api/agents/:id/notifications?type=quest_expired returns pending warnings", async () => {
    const now = new Date("2026-09-15T00:00:00.000Z")
    const expiresAt = new Date(now.getTime() + 10 * 60 * 60 * 1000).toISOString()

    seedQuest({
      id: "quest-api-test",
      title: "API Test Quest",
      expiresAt,
      assignedAgentIds: ["agent-api-1"],
    })

    checkQuestExpiration({ agentId: "agent-api-1", now })

    const req = new Request("http://localhost/api/agents/agent-api-1/notifications?type=quest_expired")
    const res = await getAgentNotifications(req, {
      params: Promise.resolve({ id: "agent-api-1" }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect(data[0].questId).toBe("quest-api-test")
    expect(data[0].expiresAt).toBe(expiresAt)
    expect(typeof data[0].remainingMs).toBe("number")
  })

  it("clearing notification via PATCH /api/agents/:id/notifications/:id/read works", async () => {
    const now = new Date("2026-09-15T00:00:00.000Z")
    const expiresAt = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString()

    seedQuest({
      id: "quest-clear-test",
      title: "Clear Test",
      expiresAt,
      assignedAgentIds: ["agent-clear"],
    })

    checkQuestExpiration({ agentId: "agent-clear", now })

    // Verify notification is unread initially
    const unreadBefore = listNotifications("agent-clear", { type: "quest_expired", unreadOnly: true })
    expect(unreadBefore).toHaveLength(1)
    const notifId = unreadBefore[0].id

    // Call PATCH /api/agents/:id/notifications/:notificationId/read
    const patchReq = new Request(`http://localhost/api/agents/agent-clear/notifications/${encodeURIComponent(notifId)}/read`, {
      method: "PATCH",
    })
    const patchRes = await markNotificationAsReadRoute(patchReq, {
      params: Promise.resolve({ id: "agent-clear", notificationId: notifId }),
    })

    expect(patchRes.status).toBe(200)
    const patchData = await patchRes.json()
    expect(patchData.ok).toBe(true)
    expect(patchData.cleared).toBe(true)

    // Verify GET /api/agents/:id/notifications?type=quest_expired now returns empty
    const getReq = new Request("http://localhost/api/agents/agent-clear/notifications?type=quest_expired")
    const getRes = await getAgentNotifications(getReq, {
      params: Promise.resolve({ id: "agent-clear" }),
    })
    const getData = await getRes.json()
    expect(getData).toHaveLength(0)
  })
})
