"use client"

import { useEffect, useState, useMemo } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import type { AgentCapabilityManifest } from "@/lib/agent-registry"
import type { AgentPresenceStatus } from "@/lib/agents/agent-health-store"

export interface AgentPresenceDotProps {
  status?: AgentPresenceStatus | null
  className?: string
  size?: number
}

/**
 * 10px border-white rounded-full presence indicator dot.
 * Designed to be overlaid on top of an avatar via CSS absolute positioning.
 */
export function AgentPresenceDot({
  status,
  className = "",
}: AgentPresenceDotProps) {
  const currentStatus = status ?? "unknown"

  const colorClass =
    currentStatus === "healthy"
      ? "bg-green-500"
      : currentStatus === "offline"
        ? "bg-red-500"
        : "bg-gray-400"

  return (
    <span
      role="status"
      aria-label={`Presence: ${currentStatus}`}
      data-testid="presence-dot"
      data-presence={currentStatus}
      className={`absolute bottom-0 right-0 h-[10px] w-[10px] rounded-full border border-white ${colorClass} ${className}`.trim()}
    />
  )
}

export interface AgentCardProps {
  agent: AgentCapabilityManifest
  presence?: AgentPresenceStatus
  filter?: string
}

export function AgentCard({ agent, presence = "unknown", filter }: AgentCardProps) {
  return (
    <Link href={`/agents/${encodeURIComponent(agent.agentId)}`}>
      <Card className="h-full bg-slate-950/80 border-slate-800 transition hover:border-slate-600">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            {/* Avatar with absolute-positioned 10px presence dot */}
            <div className="relative inline-block shrink-0">
              <Avatar className="h-10 w-10 border border-slate-700 bg-slate-900">
                <AvatarFallback className="bg-slate-800 text-slate-200 font-mono text-xs uppercase font-bold">
                  {agent.agentId.slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <AgentPresenceDot status={presence} />
            </div>

            <div className="min-w-0 flex-1">
              <CardTitle className="font-mono text-sm text-slate-100 truncate">
                {agent.agentId}
              </CardTitle>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className={`h-2 w-2 rounded-full ${
                    agent.status === "active"
                      ? "bg-emerald-400"
                      : agent.status === "working"
                        ? "bg-cyan-400"
                        : agent.status === "idle"
                          ? "bg-amber-400"
                          : agent.status === "degraded"
                            ? "bg-rose-400"
                            : "bg-slate-600"
                  }`}
                />
                <span className="font-mono text-xs text-slate-400">{agent.status}</span>
                {agent.degraded && (
                  <Badge
                    variant="outline"
                    className="border-rose-500/60 bg-rose-950/40 px-1.5 py-0 text-[10px] uppercase text-rose-300"
                  >
                    Degraded
                  </Badge>
                )}
                <span className="ml-auto font-mono text-xs text-slate-500">{agent.district}</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="mb-3 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1 font-mono text-xs text-slate-400">
            Errors 24h:{" "}
            <span className={agent.degraded ? "text-rose-300" : "text-slate-200"}>
              {agent.errorCount24h ?? 0}
            </span>
            {agent.degraded && <span className="ml-2 text-rose-300">Callable with warning</span>}
          </div>
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.slice(0, 5).map((cap) => {
              const isMatch =
                filter && cap.toLowerCase().includes(filter.trim().toLowerCase())
              return (
                <Badge
                  key={cap}
                  variant="outline"
                  className={`px-2 py-0.5 text-xs ${
                    isMatch
                      ? "border-cyan-500/60 bg-cyan-900/30 text-cyan-300"
                      : "border-slate-700 bg-slate-900/50 text-slate-400"
                  }`}
                >
                  {cap}
                </Badge>
              )
            })}
            {agent.capabilities.length > 5 && (
              <Badge
                variant="outline"
                className="border-slate-700 bg-slate-900/50 px-2 py-0.5 text-xs text-slate-500"
              >
                +{agent.capabilities.length - 5}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

export interface AgentsRegistryProps {
  agents: AgentCapabilityManifest[]
  filter?: string
  initialPresence?: Record<string, AgentPresenceStatus>
}

export function AgentsRegistry({
  agents,
  filter = "",
  initialPresence,
}: AgentsRegistryProps) {
  const [presenceMap, setPresenceMap] = useState<Record<string, AgentPresenceStatus>>(
    initialPresence ?? {},
  )

  // Filter agents based on capability
  const filteredAgents = useMemo(() => {
    if (!filter.trim()) return agents
    const search = filter.trim().toLowerCase()
    return agents.filter((a) =>
      a.capabilities.some((c) => c.toLowerCase().includes(search)),
    )
  }, [agents, filter])

  // Bulk fetch presence for displayed agents in batches of 50
  useEffect(() => {
    if (filteredAgents.length === 0) return

    const agentIds = filteredAgents.map((a) => a.agentId)
    const chunkSize = 50
    const chunks: string[][] = []

    for (let i = 0; i < agentIds.length; i += chunkSize) {
      chunks.push(agentIds.slice(i, i + chunkSize))
    }

    let isMounted = true

    Promise.all(
      chunks.map((chunk) =>
        fetch(`/api/agents/presence?ids=${encodeURIComponent(chunk.join(","))}`)
          .then((res) => (res.ok ? res.json() : {}))
          .catch(() => ({})),
      ),
    ).then((results) => {
      if (!isMounted) return
      const merged: Record<string, AgentPresenceStatus> = {}
      for (const res of results) {
        Object.assign(merged, res)
      }
      setPresenceMap((prev) => ({ ...prev, ...merged }))
    })

    return () => {
      isMounted = false
    }
  }, [filteredAgents])

  return (
    <div
      data-testid="agents-registry-grid"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {filteredAgents.map((agent) => (
        <AgentCard
          key={agent.agentId}
          agent={agent}
          presence={presenceMap[agent.agentId] ?? "unknown"}
          filter={filter}
        />
      ))}
    </div>
  )
}
