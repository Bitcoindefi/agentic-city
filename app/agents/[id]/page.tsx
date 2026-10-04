import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { buildSevenDayXpSnapshots, getLevelProgress, type XpHistoryEventLike } from "@/lib/agents/xp-history-chart"
import { getXpToNextLevel } from "@/lib/gamification/xp"

import {
  AGENT_OG_SIZE,
  findAgentByLookup,
  getAgentCardStats,
  getAgentDistrict,
  getAgentOgPath,
  getAgentProfilePath,
} from "@/lib/og-card-data"

import { getAgentHealth } from "@/lib/agents/agent-health-store"
import { getReputation } from "@/lib/reputation/reputation-store"
import { getQuests } from "@/lib/gamification/quests"
import { getAgentXpHistory } from "@/lib/agents/xp-decay"
import { DISTRICTS } from "@/lib/data"
import { getRobotStillPath } from "@/lib/robot-sprites"

type AgentPageProps = {
  params: Promise<{ id: string }>
}

function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`
  }
  return "http://localhost:3000"
}

function absoluteUrl(path: string): string {
  return new URL(path, getBaseUrl()).toString()
}

function getBadgeRarityStyles(rarity?: string): string {
  switch (rarity) {
    case "legendary":
      return "border-purple-500/50 bg-purple-500/10 text-purple-200"
    case "epic":
      return "border-amber-500/50 bg-amber-500/10 text-amber-200"
    case "rare":
      return "border-cyan-500/50 bg-cyan-500/10 text-cyan-200"
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300"
  }
}

export async function generateMetadata({ params }: AgentPageProps): Promise<Metadata> {
  const { id } = await params
  const agent = findAgentByLookup(id)

  if (!agent) {
    return {
      title: "Agent not found - Agentic City",
    }
  }

  const stats = getAgentCardStats(agent)
  const district = getAgentDistrict(agent)
  const profileUrl = absoluteUrl(getAgentProfilePath(agent))
  const ogImage = absoluteUrl(getAgentOgPath(agent))
  const title = `${agent.name} - Agentic City Agent`
  const description = `Level ${stats.level} ${stats.tier} agent in ${district.name} with ${agent.tasksCompleted.toLocaleString("en-US")} completed tasks.`

  return {
    title,
    description,
    alternates: {
      canonical: profileUrl,
    },
    openGraph: {
      title,
      description,
      url: profileUrl,
      type: "profile",
      images: [
        {
          url: ogImage,
          width: AGENT_OG_SIZE.width,
          height: AGENT_OG_SIZE.height,
          alt: `${agent.name} Agentic City agent card`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  }
}

function getStatusBadgeStyle(status: string) {
  switch (status) {
    case 'active':
    case 'healthy':
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/50"
    case 'idle':
      return "bg-sky-500/20 text-sky-400 border-sky-500/50"
    case 'running':
      return "bg-blue-500/20 text-blue-400 border-blue-500/50"
    case 'working':
      return "bg-violet-500/20 text-violet-400 border-violet-500/50"
    case 'error':
      return "bg-rose-500/20 text-rose-400 border-rose-500/50"
    case 'degraded':
      return "bg-amber-500/20 text-amber-400 border-amber-500/50"
    case 'stopped':
      return "bg-orange-500/20 text-orange-400 border-orange-500/50"
    default:
      return "bg-slate-500/20 text-slate-400 border-slate-500/50"
  }
}

export default async function AgentPage({ params }: AgentPageProps) {
  const { id } = await params
  
  let metaData: any = null
  let healthData: any = null
  let reputationData: any = null
  let questsData: any = null
  let xpHistoryData: any = null

  try {
    const res = await fetch(absoluteUrl(`/api/agents/${id}`), { cache: 'no-store' })
    if (res.ok) metaData = await res.json()
  } catch (e) {
    console.warn(`Failed to fetch metadata for agent ${id}:`, e)
  }

  try {
    const res = await fetch(absoluteUrl(`/api/agents/${id}/health`), { cache: 'no-store' })
    if (res.ok) healthData = await res.json()
  } catch (e) {
    console.warn(`Failed to fetch health for agent ${id}:`, e)
  }

  try {
    const res = await fetch(absoluteUrl(`/api/protocol/reputation?actorId=${id}`), { cache: 'no-store' })
    if (res.ok) reputationData = await res.json()
  } catch (e) {
    console.warn(`Failed to fetch reputation for agent ${id}:`, e)
  }

  try {
    const res = await fetch(absoluteUrl(`/api/agents/${id}/quest-recommendations`), { cache: 'no-store' })
    if (res.ok) questsData = await res.json()
  } catch (e) {
    console.warn(`Failed to fetch quest recommendations for agent ${id}:`, e)
  }

  try {
    const res = await fetch(absoluteUrl(`/api/agents/${id}/xp/history?pageSize=100`), { cache: 'no-store' })
    if (res.ok) xpHistoryData = await res.json()
  } catch (e) {
    console.warn(`Failed to fetch XP history for agent ${id}:`, e)
  }

  const localAgent = findAgentByLookup(id)
  if (!metaData && !localAgent) {
    notFound()
  }

  // Parse Metadata
  let agentMetadata: any = null
  let capabilities: string[] = []
  if (metaData) {
    agentMetadata = metaData.agent
    capabilities = agentMetadata.capabilities || []
  } else if (localAgent) {
    agentMetadata = localAgent
    capabilities = localAgent.skills?.map((s: any) => s.name) || []
  }

  // Parse Health
  let isHealthy = false
  let uptime = "0s"
  let runtimeStatus = "offline"
  let currentTask = "No active task"

  if (healthData) {
    isHealthy = healthData.health?.status === 'healthy'
    uptime = healthData.health?.uptime || "0s"
    runtimeStatus = healthData.health?.runtimeStatus || healthData.health?.status || "offline"
    currentTask = healthData.health?.currentTask || "No active task"
  } else {
    const health = getAgentHealth(id)
    if (health) {
      isHealthy = health.status === 'healthy'
      uptime = health.uptime || "0s"
      runtimeStatus = health.runtimeStatus || health.status || "offline"
      currentTask = health.currentTask || "No active task"
    } else if (localAgent) {
      isHealthy = localAgent.status !== 'offline'
      uptime = `${getAgentCardStats(localAgent).uptime}%`
      runtimeStatus = localAgent.status || "active"
      currentTask = localAgent.currentTask || "No active task"
    }
  }

  // Parse Reputation & Badges
  let repScore = 0
  let badges: any[] = []
  let infractions = 0
  if (reputationData) {
    repScore = reputationData.reputation?.score || 0
    badges = reputationData.reputation?.metrics?.badges || reputationData.reputation?.badges || []
    infractions = reputationData.reputation?.metrics?.infractions || reputationData.reputation?.history?.filter((h: any) => h.delta < 0).length || 0
  } else {
    const reputation = getReputation(id)
    if (reputation) {
      repScore = reputation.score || 0
      badges = reputation.metrics?.badges || []
      infractions = reputation.metrics?.infractions || 0
    }
  }

  // Parse Quests
  let quests: any[] = []
  if (questsData) {
    quests = questsData.quests || []
  } else {
    quests = getQuests()
      .filter(q => q.status === "in_progress")
      .slice(0, 5)
  }

  const agentName = agentMetadata.name || agentMetadata.agentId || 'Unknown Agent'
  const initials = agentName.substring(0, 2).toUpperCase()
  const agentIdStr = agentMetadata.agentId || agentMetadata.id || id
  const tasksCompleted = agentMetadata.tasksCompleted ?? localAgent?.tasksCompleted ?? 0
  const totalXp = agentMetadata.xp ?? localAgent?.xp ?? 0
  const level = agentMetadata.level ?? localAgent?.level ?? 1
  const xpToNext = agentMetadata.xpToNext ?? getXpToNextLevel(level)

  let xpHistoryEvents: XpHistoryEventLike[] = []
  if (xpHistoryData) {
    xpHistoryEvents = Array.isArray(xpHistoryData.events) ? xpHistoryData.events : []
  } else {
    xpHistoryEvents = getAgentXpHistory(id) as XpHistoryEventLike[]
  }
  const xpSnapshots = buildSevenDayXpSnapshots(xpHistoryEvents)
  const xpProgress = getLevelProgress(totalXp, level)
  
  let districtName = "Unknown"
  if (agentMetadata.district) {
    districtName = typeof agentMetadata.district === 'string' ? agentMetadata.district : agentMetadata.district.name
  } else if (localAgent) {
    districtName = getAgentDistrict(localAgent).name
  }
  if (districtName === "Unknown" && agentMetadata.district) {
    const distObj = DISTRICTS.find((d: any) => d.id === agentMetadata.district)
    if (distObj) districtName = distObj.name
  }
  // District robot portrait: prefer the local agent's district id, then the metadata.
  const metadataDistrictId = typeof agentMetadata.district === 'string' ? agentMetadata.district : agentMetadata.district?.id
  const robotStill = getRobotStillPath(localAgent?.district ?? metadataDistrictId)

  return (
    <main className="min-h-screen bg-[#030712] px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <Link
          href="/"
          className="w-fit rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 transition hover:border-cyan-300/60"
        >
          Back to city
        </Link>
        
        {/* Header Section */}
        <Card className="bg-slate-950/80 border-slate-800 shadow-[0_24px_80px_rgba(2,8,23,0.45)]">
          <CardHeader className="flex flex-col sm:flex-row items-center gap-6 pb-6">
            <Avatar className="h-24 w-24 border-2 border-slate-800 bg-slate-900 flex-shrink-0">
              <AvatarImage src={robotStill} alt={agentName} className="object-contain p-1" />
              <AvatarFallback className="bg-slate-800 text-2xl font-mono text-cyan-300">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-2 items-center sm:items-start flex-1 text-center sm:text-left">
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <h1 className="font-pixel text-2xl sm:text-3xl uppercase text-slate-100" style={{ color: localAgent?.color }}>{agentName}</h1>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={isHealthy ? "default" : "destructive"} className={isHealthy ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" : ""}>
                    {isHealthy ? "Healthy" : "Offline"}
                  </Badge>
                  <Badge variant="outline" className={getStatusBadgeStyle(runtimeStatus)}>
                    {runtimeStatus.toUpperCase()}
                  </Badge>
                </div>
              </div>
              <p className="font-mono text-sm text-slate-400 mt-1">ID: {agentIdStr}</p>
              {/* Current Task */}
              <div className="mt-1 font-mono text-sm text-slate-300">
                <span className="text-slate-500">Current Task:</span> <span className="text-cyan-300 font-semibold">{currentTask}</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-xs text-cyan-400/80 mt-2 bg-cyan-950/30 px-3 py-1.5 rounded-full border border-cyan-900/50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                {districtName}
              </div>
            </div>
            <Link 
              href={`/credential/${encodeURIComponent(agentIdStr)}`} 
              className="mt-2 sm:mt-0 w-fit rounded-md border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-emerald-200 transition hover:border-emerald-300/60"
            >
              View Credential
            </Link>
          </CardHeader>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 flex flex-col gap-6">
            {/* Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Card className="bg-slate-950/80 border-slate-800">
                <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                  <span className="font-mono text-xs text-slate-400 mb-1">Reputation</span>
                  <span className="font-pixel text-2xl text-amber-400">{repScore}</span>
                </CardContent>
              </Card>
              <Card className="bg-slate-950/80 border-slate-800">
                <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                  <span className="font-mono text-xs text-slate-400 mb-1">Tasks Done</span>
                  <span className="font-pixel text-2xl text-cyan-400">{tasksCompleted}</span>
                </CardContent>
              </Card>
              <Card className="bg-slate-950/80 border-slate-800">
                <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                  <span className="font-mono text-xs text-slate-400 mb-1">Uptime</span>
                  <span className="font-pixel text-2xl text-emerald-400">{uptime}</span>
                </CardContent>
              </Card>
              <Card className="bg-slate-950/80 border-slate-800">
                <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                  <span className="font-mono text-xs text-slate-400 mb-1">Infractions</span>
                  <span className="font-pixel text-2xl text-rose-400">{infractions}</span>
                </CardContent>
              </Card>
            </div>


            {/* XP Progress */}
            <Card className="bg-slate-950/80 border-slate-800">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="font-mono uppercase tracking-wider text-sm text-slate-300">XP Growth</CardTitle>
                    <CardDescription className="mt-1 text-xs text-slate-500">7-day earned XP snapshot</CardDescription>
                  </div>
                  <Badge className="border-cyan-400/50 bg-cyan-400/10 px-3 py-1 font-mono text-cyan-200">Level {level}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Total XP</div>
                    <div className="mt-1 font-pixel text-xl text-cyan-300">{totalXp.toLocaleString("en-US")}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 sm:col-span-2">
                    <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
                      <span>Next level</span>
                      <span>{xpToNext > 0 ? `${Math.max(0, xpToNext - totalXp).toLocaleString("en-US")} XP needed` : "Max level"}</span>
                    </div>
                    <div className="h-3 overflow-hidden rounded-full bg-slate-800" aria-label={`Level ${level} progress`}>
                      <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-300" style={{ width: `${xpProgress.progressPercent}%` }} />
                    </div>
                  </div>
                </div>
                <XpSparkline snapshots={xpSnapshots} />
              </CardContent>
            </Card>

            {/* Capabilities */}
            <Card className="bg-slate-950/80 border-slate-800">
              <CardHeader className="pb-3">
                <CardTitle className="font-mono uppercase tracking-wider text-sm text-slate-300">Capabilities</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {capabilities.length > 0 ? capabilities.map((cap, i) => (
                    <Badge key={i} variant="outline" className="bg-blue-900/20 text-blue-300 border-blue-800/50 hover:bg-blue-900/40 px-3 py-1 text-xs">
                      {cap}
                    </Badge>
                  )) : (
                    <span className="text-sm text-slate-500 font-mono">No capabilities registered</span>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Badges */}
            <Card className="bg-slate-950/80 border-slate-800">
              <CardHeader className="pb-3">
                <CardTitle className="font-mono uppercase tracking-wider text-sm text-slate-300">Earned Badges</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {badges.length > 0 ? badges.map((badge, i) => (
                    <div key={i} className={`flex flex-col p-3 rounded-lg border gap-1.5 ${getBadgeRarityStyles(badge.rarity)}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-pixel text-xs leading-tight text-slate-100">{badge.name || badge.badgeId || badge.id}</span>
                        <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 rounded border border-current opacity-80">{badge.rarity || 'common'}</span>
                      </div>
                      {badge.description && <p className="font-mono text-[11px] text-slate-400 leading-normal">{badge.description}</p>}
                      {badge.earnedAt && (
                        <span className="font-mono text-[9px] text-slate-500 mt-auto">
                          Earned {new Date(badge.earnedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  )) : (
                    <div className="col-span-1 sm:col-span-2 lg:col-span-3 text-center p-4">
                      <span className="text-sm text-slate-500 font-mono">No badges earned yet. Complete daily quests to earn badges!</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Active Quests (Sidebar) */}
          <div className="flex flex-col gap-4">
            <h3 className="font-mono uppercase tracking-wider text-sm text-slate-300 mb-1 md:ml-1">Active Quests</h3>
            {quests.length > 0 ? quests.slice(0, 3).map((quest, i) => (
              <Card key={i} className="bg-slate-950/80 border-slate-800 overflow-hidden relative">
                <div className="absolute top-0 left-0 w-full h-1 bg-slate-800">
                  <div className="h-full bg-cyan-400" style={{ width: `${quest.progress || 0}%` }}></div>
                </div>
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm text-cyan-300 leading-tight">{quest.title}</CardTitle>
                  <CardDescription className="text-xs text-slate-400 line-clamp-2 mt-1">{quest.description}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 px-4 pb-4">
                  <div className="flex justify-between items-center text-xs font-mono mt-2 pt-2 border-t border-slate-800/50">
                    <span className="text-slate-500">{quest.progress || 0}%</span>
                    <span className="text-amber-400/80">+{quest.reward?.xp || 0} XP</span>
                  </div>
                </CardContent>
              </Card>
            )) : (
              <Card className="bg-slate-950/80 border-slate-800 border-dashed">
                <CardContent className="p-6 text-center">
                  <span className="text-sm text-slate-500 font-mono">No active quests</span>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}



function XpSparkline({ snapshots }: { snapshots: ReturnType<typeof buildSevenDayXpSnapshots> }) {
  const width = 560
  const height = 120
  const padding = 12
  const maxXp = Math.max(1, ...snapshots.map((point) => point.xp))
  const step = snapshots.length > 1 ? (width - padding * 2) / (snapshots.length - 1) : 0
  const points = snapshots.map((point, index) => {
    const x = padding + index * step
    const y = height - padding - (point.xp / maxXp) * (height - padding * 2)
    return { ...point, x, y }
  })
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ")
  const areaPath = `${path} L${width - padding},${height - padding} L${padding},${height - padding} Z`

  return (
    <div className="h-40 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <svg className="h-28 w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Seven-day XP earned sparkline" preserveAspectRatio="none">
        <path d={areaPath} fill="rgba(34, 211, 238, 0.12)" />
        <path d={path} fill="none" stroke="#22d3ee" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" vectorEffect="non-scaling-stroke" />
        {points.map((point) => (
          <g key={point.date}>
            <circle cx={point.x} cy={point.y} r="4" fill="#030712" stroke="#67e8f9" strokeWidth="2" vectorEffect="non-scaling-stroke">
              <title>{`${point.label}: ${point.xp} XP`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <div className="grid grid-cols-7 gap-1 font-mono text-[10px] text-slate-500">
        {snapshots.map((point) => (
          <div key={point.date} className="min-w-0 text-center" title={`${point.label}: ${point.xp} XP`}>
            <div className="truncate">{point.label}</div>
            <div className="text-cyan-300">{point.xp}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
