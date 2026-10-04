"use client"

import { useState, useSyncExternalStore } from "react"
import { ChevronDown, ChevronUp, Trophy } from "lucide-react"
import Link from "next/link"
import type { ActiveDistrictEvent, DistrictStanding } from "@/lib/gamification/events"

interface DistrictEventOverlayProps {
  event: ActiveDistrictEvent | null
  standings: DistrictStanding[]
  /** Distance from the top of the map; a narrow map moves the card below the top-right controls. */
  top?: number
}

function formatCountdown(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h ${minutes}m`
}

const noopSubscribe = () => () => {}

export function DistrictEventOverlay({ event, standings, top = 12 }: DistrictEventOverlayProps) {
  const [expanded, setExpanded] = useState(false)
  // Standings can differ between the server render and the browser (the server
  // and client agent rosters drift), which made React throw a hydration error and
  // regenerate the whole map tree. Show the leader only once on the client.
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false)
  if (!event) return null

  const leader = isClient ? standings[0] : undefined

  return (
    <section
      aria-label="Active district competition"
      style={{
        position: "absolute",
        top,
        left: 12,
        right: 12,
        zIndex: 6,
        width: "min(280px, calc(100vw - 24px))",
        maxHeight: expanded ? "min(42dvh, 320px)" : undefined,
        overflow: "auto",
        boxSizing: "border-box",
        padding: expanded ? 12 : "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(34,211,238,0.35)",
        background: "rgba(3,7,18,0.84)",
        boxShadow: "0 18px 48px rgba(0,0,0,0.35)",
        backdropFilter: "blur(8px)",
        fontFamily: "monospace",
      }}
    >
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: 0, border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}>
        <span style={{ display: "grid", placeItems: "center", width: 28, height: 28, flex: "0 0 auto", borderRadius: 8, background: "rgba(34,211,238,0.12)", color: "#67e8f9" }}><Trophy size={14} aria-hidden="true" /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 8, color: "#22d3ee", textTransform: "uppercase", letterSpacing: 1.3 }}>District challenge · {formatCountdown(event.secondsRemaining)}</span>
          <span style={{ display: "block", marginTop: 3, fontSize: 11, color: "#f8fafc", fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{event.challenge.name}</span>
          {!expanded && <span style={{ display: "block", marginTop: 2, fontSize: 9, color: "#94a3b8" }}>{leader ? `${leader.districtName} leads` : event.challenge.metric}</span>}
        </span>
        {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
      </button>
      {expanded && <>
      <div style={{ fontSize: 10, color: "#94a3b8", lineHeight: 1.5, margin: "10px 0" }}>
        {event.challenge.metric} · ends in {formatCountdown(event.secondsRemaining)}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {standings.slice(0, 5).map((standing) => (
          <Link key={standing.districtId} href={`/districts/${standing.districtId}/leaderboard`} style={{ display: "grid", gridTemplateColumns: "22px 1fr auto", alignItems: "center", gap: 6, textDecoration: "none" }} aria-label={`${standing.districtName} leaderboard`}>
            <div style={{ color: standing.color, fontSize: 11, fontWeight: 800 }}>#{standing.rank}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#cbd5e1", fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {standing.districtName}
              </div>
              <div style={{ height: 4, background: "#111827", borderRadius: 999, overflow: "hidden", marginTop: 3 }}>
                <div
                  style={{
                    width: `${leader ? Math.max(8, Math.min(100, (standing.score / Math.max(leader.score, 0.001)) * 100)) : 0}%`,
                    height: "100%",
                    background: standing.color,
                  }}
                />
              </div>
            </div>
            <div style={{ color: standing.rank <= 2 ? "#fbbf24" : "#64748b", fontSize: 10, fontWeight: 700 }}>
              {standing.formattedScore} {standing.multiplier > 1 ? `${standing.multiplier}×` : ""}
            </div>
          </Link>
        ))}
      </div>
      </>}
    </section>
  )
}
