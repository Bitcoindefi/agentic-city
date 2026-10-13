import { getBadgeCatalogEntry, type BadgeRarity } from "@/lib/gamification/badge-catalog"
import { getAgentXP } from "@/lib/gamification/xp"
import { listPublishedEvents } from "@/lib/events/system-events"

export interface WeeklyQuestSummaryItem {
  questId: string
  title: string
  completedAt: string
}

export interface WeeklyBadgeSummaryItem {
  id: string
  name: string
  rarity?: BadgeRarity
  xpValue: number
  earnedAt: string
}

export interface AgentWeeklySummary {
  agentId: string
  agentName: string
  questsCompleted: WeeklyQuestSummaryItem[]
  xpEarned: number
  level: number
  previousLevel: number | null
  leveledUp: boolean
  leaderboardRank: number | null
  previousLeaderboardRank: number | null
  topBadge?: WeeklyBadgeSummaryItem
  weekStartsAt: string
  weekEndsAt: string
}

export interface WeeklySummaryTemplate {
  subject: string
  text: string
  html: string
}

const RARITY_WEIGHT: Record<BadgeRarity, number> = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 }

export function getPreviousSundayWindow(now = new Date()): { start: Date; end: Date } {
  const end = new Date(now)
  end.setUTCHours(0, 0, 0, 0)
  const daysSinceSunday = end.getUTCDay()
  end.setUTCDate(end.getUTCDate() - daysSinceSunday)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 7)
  return { start, end }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
}

function rankText(current: number | null, previous: number | null): string {
  if (current === null) return "Not ranked this week"
  if (previous === null) return `#${current} (new on leaderboard)`
  const delta = previous - current
  if (delta > 0) return `#${current} (up ${delta} from last week)`
  if (delta < 0) return `#${current} (down ${Math.abs(delta)} from last week)`
  return `#${current} (unchanged from last week)`
}

function eventTimeMs(event: { occurredAt?: string }): number {
  return new Date(event.occurredAt ?? 0).getTime()
}

function inWindow(event: { occurredAt?: string }, startMs: number, endMs: number): boolean {
  const ms = eventTimeMs(event)
  return ms >= startMs && ms < endMs
}

function questTitle(quest: unknown, questId: string): string {
  if (typeof quest === "object" && quest !== null && "title" in quest && typeof quest.title === "string") {
    return quest.title
  }
  return questId || "Quest completed"
}

function computeRank(agentIds: string[], startMs: number, endMs: number): Map<string, number> {
  const counts = new Map(agentIds.map((agentId) => [agentId, 0]))
  for (const event of listPublishedEvents()) {
    if (event.type !== "quest.completed" || !event.agentId || !inWindow(event, startMs, endMs)) continue
    counts.set(event.agentId, (counts.get(event.agentId) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const ranks = new Map<string, number>()
  let currentRank = 1
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i]![1] < sorted[i - 1]![1]) currentRank = i + 1
    ranks.set(sorted[i]![0], currentRank)
  }
  return ranks
}

export function buildAgentWeeklySummary(agentId: string, agentName: string, allAgentIds: string[], now = new Date()): AgentWeeklySummary {
  const { start, end } = getPreviousSundayWindow(now)
  const startMs = start.getTime()
  const endMs = end.getTime()
  const previousStartMs = startMs - 7 * 24 * 60 * 60 * 1000
  const events = listPublishedEvents().filter((event) => event.agentId === agentId && inWindow(event, startMs, endMs))
  const xpEvents = events.filter((event) => event.type === "agent.xp")
  const xpEarned = xpEvents.reduce((sum, event) => sum + event.xp, 0)
  const level = getAgentXP(agentId).level
  const previousLevel = xpEvents.length > 0 ? xpEvents[0]!.level - (xpEvents[0]!.xp > 0 && xpEvents[0]!.level > 1 ? 1 : 0) : null
  const badges = events.filter((event) => event.type === "badge.unlocked").map((event) => {
    const catalog = getBadgeCatalogEntry(event.badge.id)
    return { id: event.badge.id, name: event.badge.name, rarity: event.badge.rarity, xpValue: catalog?.xpValue ?? 0, earnedAt: event.occurredAt }
  }).sort((a, b) => (RARITY_WEIGHT[b.rarity ?? "common"] - RARITY_WEIGHT[a.rarity ?? "common"]) || b.xpValue - a.xpValue)
  return {
    agentId,
    agentName,
    questsCompleted: events.filter((event) => event.type === "quest.completed").map((event) => ({ questId: event.questId ?? "", title: questTitle(event.quest, event.questId ?? ""), completedAt: event.occurredAt })),
    xpEarned,
    level,
    previousLevel,
    leveledUp: xpEvents.some((event) => event.level > level - 1),
    leaderboardRank: computeRank(allAgentIds, startMs, endMs).get(agentId) ?? null,
    previousLeaderboardRank: computeRank(allAgentIds, previousStartMs, startMs).get(agentId) ?? null,
    topBadge: badges[0],
    weekStartsAt: start.toISOString(),
    weekEndsAt: end.toISOString(),
  }
}

export function renderWeeklySummaryEmail(summary: AgentWeeklySummary): WeeklySummaryTemplate {
  const questLines = summary.questsCompleted.length === 0 ? ["No quests completed this week. Your next quest is waiting."] : summary.questsCompleted.map((quest, index) => `${index + 1}. ${quest.title}`)
  const levelLine = summary.leveledUp ? `New level: ${summary.level}` : `Current level: ${summary.level}`
  const badgeLine = summary.topBadge ? `${summary.topBadge.name}${summary.topBadge.rarity ? ` (${summary.topBadge.rarity})` : ""}` : "No badges earned this week"
  const subject = `Open Stellar weekly summary for ${summary.agentName}`
  const text = [`Open Stellar weekly summary`, `Agent: ${summary.agentName}`, `Week: ${summary.weekStartsAt.slice(0, 10)} to ${summary.weekEndsAt.slice(0, 10)}`, "", `Quests completed: ${summary.questsCompleted.length}`, ...questLines, "", `XP earned: ${summary.xpEarned}`, levelLine, `Leaderboard rank: ${rankText(summary.leaderboardRank, summary.previousLeaderboardRank)}`, `Top badge: ${badgeLine}`].join("\n")
  const htmlQuests = summary.questsCompleted.length === 0 ? "<p>No quests completed this week. Your next quest is waiting.</p>" : `<ol>${summary.questsCompleted.map((quest) => `<li>${escapeHtml(quest.title)}</li>`).join("")}</ol>`
  const html = `<div style="font-family:Arial,sans-serif;color:#102033;line-height:1.5"><h1>Open Stellar weekly summary</h1><p><strong>Agent:</strong> ${escapeHtml(summary.agentName)}</p><p><strong>Week:</strong> ${summary.weekStartsAt.slice(0, 10)} to ${summary.weekEndsAt.slice(0, 10)}</p><h2>Quests completed: ${summary.questsCompleted.length}</h2>${htmlQuests}<p><strong>XP earned:</strong> ${summary.xpEarned}</p><p><strong>${summary.leveledUp ? "New" : "Current"} level:</strong> ${summary.level}</p><p><strong>Leaderboard rank:</strong> ${escapeHtml(rankText(summary.leaderboardRank, summary.previousLeaderboardRank))}</p><p><strong>Top badge:</strong> ${escapeHtml(badgeLine)}</p></div>`
  return { subject, text, html }
}
