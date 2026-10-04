import { DISTRICTS, createAgents } from "@/lib/data"
import type { District, DistrictId, MoltbotAgent } from "@/lib/types"
import { formatAssetAmount } from "@/lib/config/chains"
import { getRobotStillPath } from "@/lib/robot-sprites"

export const AGENT_OG_SIZE = {
  width: 1200,
  height: 630,
} as const

export const DISTRICT_BACKGROUND_PATHS: Record<DistrictId, string> = {
  "data-center": "/bg-data-center.jpg",
  "comm-hub": "/bg-comm-hub.jpg",
  processing: "/bg-processing.jpg",
  defense: "/bg-defense.jpg",
  research: "/bg-research.jpg",
}

export interface AgentCardStats {
  level: number
  tier: "Bronze" | "Silver" | "Gold" | "Platinum"
  earnedXlm: string
  uptime: string
  skills: string[]
}

export function slugifyAgent(agent: Pick<MoltbotAgent, "id" | "name">): string {
  return agent.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || agent.id
}

import { getRegisteredAgent } from "@/lib/agent-registry"
import { getAgentXP, getXpToNextLevel } from "@/lib/gamification/xp"
import { listAgentTasks } from "@/lib/agents/task-queue"
import { getAgentHealth } from "@/lib/agents/agent-health-store"

function normalizeLookup(id: string): string {
  try {
    return decodeURIComponent(id).trim().toLowerCase()
  } catch {
    return id.trim().toLowerCase()
  }
}

export function findAgentByLookup(id: string, agents: MoltbotAgent[] = createAgents()): MoltbotAgent | null {
  const lookup = normalizeLookup(id)
  const found = agents.find((agent) => (
    agent.id.toLowerCase() === lookup ||
    agent.name.toLowerCase() === lookup ||
    slugifyAgent(agent) === lookup
  ))
  if (found) return found

  // Fallback to registered agent from the in-memory store
  const reg = getRegisteredAgent(decodeURIComponent(id)) || getRegisteredAgent(id)
  if (reg) {
    const progress = getAgentXP(reg.agentId)
    const tasksCompleted = listAgentTasks(reg.agentId)
      .filter((task) => task.status === "completed")
      .length
    const health = getAgentHealth(reg.agentId)
    const xpToNext = getXpToNextLevel(progress.level)
    
    return {
      id: reg.agentId,
      name: reg.agentId,
      model: reg.model,
      xp: progress.xp,
      level: progress.level,
      xpToNext,
      status: reg.status,
      district: reg.district,
      cpu: health?.cpu ?? 0,
      memory: health?.memory ?? 0,
      tasksCompleted,
      currentTask: health?.currentTask ?? null,
      taskProgress: 0,
      color: "#22d3ee",
      pixelX: 0,
      pixelY: 0,
      targetX: 0,
      targetY: 0,
      frame: 0,
      direction: "left",
      spriteId: 0,
      skills: reg.capabilities.map((c, i) => ({
        id: `${reg.district}-skill-${i}`,
        name: c,
        level: 1,
        maxLevel: 5,
        xp: 0,
        xpToNext: 100
      })),
      appearance: {
        skin: "default",
        accessories: [],
        customColor: null
      }
    }
  }

  return null
}

export function findDistrictByLookup(id: string): District | null {
  const lookup = normalizeLookup(id)
  return DISTRICTS.find((district) => (
    district.id.toLowerCase() === lookup ||
    district.name.toLowerCase() === lookup ||
    district.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === lookup
  )) ?? null
}

export function getAgentDistrict(agent: MoltbotAgent): District {
  return DISTRICTS.find((district) => district.id === agent.district) ?? DISTRICTS[0]
}

export function getAgentsForDistrict(districtId: DistrictId, agents: MoltbotAgent[] = createAgents()): MoltbotAgent[] {
  return agents.filter((agent) => agent.district === districtId)
}

export function getAgentCardStats(agent: MoltbotAgent): AgentCardStats {
  const totalSkillLevels = agent.skills.reduce((sum, skill) => sum + skill.level, 0)
  const level = Math.max(1, Math.floor(agent.tasksCompleted / 24) + Math.max(1, Math.floor(totalSkillLevels / 3)))
  const tier = level >= 28 ? "Platinum" : level >= 18 ? "Gold" : level >= 9 ? "Silver" : "Bronze"
  const earned = agent.tasksCompleted * 0.014 + totalSkillLevels * 0.08
  const uptime = Math.min(99.9, 96.5 + (agent.tasksCompleted % 34) / 10)

  return {
    level,
    tier,
    earnedXlm: earned.toFixed(1),
    uptime: uptime.toFixed(1),
    skills: agent.skills.slice(0, 5).map((skill) => skill.name),
  }
}

export function getAgentProfilePath(agent: MoltbotAgent): string {
  return `/agents/${slugifyAgent(agent)}`
}

export function getAgentOgPath(agent: MoltbotAgent): string {
  return `/api/og/agent/${slugifyAgent(agent)}`
}

export function getDistrictOgPath(district: District): string {
  return `/api/og/district/${district.id}`
}

/** Transparent still of the agent's district robot (PNG, safe for satori OG cards). */
export function getAgentSpritePath(agent: Pick<MoltbotAgent, "district">): string {
  return getRobotStillPath(agent.district)
}

export function formatAgentShareText(agent: MoltbotAgent): string {
  const stats = getAgentCardStats(agent)
  const district = getAgentDistrict(agent)

  return [
    `My AI agent ${agent.name} just hit Level ${stats.level} on Agentic City`,
    `${agent.tasksCompleted.toLocaleString("en-US")} tasks completed - ${formatAssetAmount(stats.earnedXlm)} earned - ${stats.uptime}% uptime`,
    `${district.name} District`,
  ].join("\n")
}

