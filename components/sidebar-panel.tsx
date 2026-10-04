"use client"

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react"
import { Bell, BrainCircuit, CheckCheck, Copy, Download, PlugZap, Share2 } from "lucide-react"
import { toast } from "sonner"
import type { AgentAppearance, MoltbotAgent, LogEntry, ChatMessage, WalletTransaction } from "@/lib/types"
import { DISTRICTS } from "@/lib/data"
import { formatAgentShareText, getAgentOgPath, getAgentProfilePath, slugifyAgent } from "@/lib/og-card-data"
import { ChatPanel } from "./chat-panel"
import { SkillsPanel } from "./skills-panel"
import { WalletPanel } from "./wallet-panel"
import dynamic from "next/dynamic"

// Wallet Standard discovery only exists in the browser.
const PaidTaskPanel = dynamic(() => import("./x402/paid-task-panel").then((mod) => mod.PaidTaskPanel), { ssr: false })
const AgentWalletPanel = dynamic(() => import("./x402/agent-wallet-panel").then((mod) => mod.AgentWalletPanel), { ssr: false })
import { AppearancePanel } from "./appearance-panel"
import { QuestsPanel } from "./quests-panel"
import { MOCK_OFFERS, TaskBoard, getTaskOfferCounts } from "./task-board"
import { ConnectionsPanel } from "./admin/connections-panel"
import { STELLAR_ENABLED } from "@/lib/config/chains"

export type SidebarTabId = "overview" | "models" | "connectors" | "chat" | "offers" | "skills" | "quests" | "wallet" | "appearance"

interface NotificationItem {
  id: string
  cursor: string
  agentId: string
  type: "agent_offline" | "quest_completed" | "reputation_updated"
  title: string
  body: string
  resourceHref: string
  resourceLabel: string
  createdAt: string
}

export const SIDEBAR_TABS: { id: SidebarTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Modelos IA" },
  { id: "connectors", label: "Complementos" },
  { id: "chat", label: "Chat" },
  { id: "offers", label: "Offers" },
  { id: "skills", label: "Skills" },
  { id: "quests", label: "Quests" },
  { id: "wallet", label: "Wallet" },
  { id: "appearance", label: "Appearance" },
]

interface SidebarPanelProps {
  agents: MoltbotAgent[]
  selectedAgent: MoltbotAgent | null
  logs: LogEntry[]
  chatMessages: ChatMessage[]
  transactions: WalletTransaction[]
  onSelectAgent: (id: string | null) => void
  onUpdateAgent: (agentId: string, wallet: MoltbotAgent["wallet"]) => void
  onAddTransaction: (tx: WalletTransaction) => void
  onUpgradeSkill: (agentId: string, skillId: string) => void
  onUpdateAgentAppearance: (agentId: string, appearance: AgentAppearance) => void
  colorBlindMode: boolean
  onColorBlindModeChange: (enabled: boolean) => void
  activeTab?: SidebarTabId
  onActiveTabChange?: (tab: SidebarTabId) => void
  variant?: "desktop" | "mobile"
  showTabBar?: boolean
}

function StatBox({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      background: "#1a2235",
      borderRadius: 6,
      padding: "8px 10px",
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div suppressHydrationWarning style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
    </div>
  )
}

function getReputationTier(score: number) {
  if (score >= 1000) return "Platinum"
  if (score >= 500) return "Gold"
  if (score >= 200) return "Silver"
  if (score >= 50) return "Bronze"
  return "Unrated"
}

function tierColor(tier: string) {
  return { Platinum: "#e0e7ff", Gold: "#fbbf24", Silver: "#cbd5e1", Bronze: "#d97706", Unrated: "#64748b" }[tier] ?? "#64748b"
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ background: "#0a0e17", borderRadius: 4, height: 8, overflow: "hidden" }}>
      <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
    </div>
  )
}

const statusSymbols: Record<string, string> = {
  active: "+",
  working: "*",
  idle: "o",
  error: "x",
  offline: "-",
}

function ShareActionButton({
  label,
  title,
  color,
  icon,
  onClick,
}: {
  label: string
  title: string
  color: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        width: "100%",
        minHeight: 30,
        padding: "6px 8px",
        background: `${color}1a`,
        border: `1px solid ${color}44`,
        borderRadius: 5,
        color,
        cursor: "pointer",
        fontFamily: "monospace",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1.1,
        textTransform: "uppercase",
      }}
    >
      {icon}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  )
}

function AgentShareControls({ agent }: { agent: MoltbotAgent }) {
  const getAbsoluteUrl = (path: string) => {
    if (typeof window === "undefined") return path
    return new URL(path, window.location.origin).toString()
  }

  const profileUrl = getAbsoluteUrl(getAgentProfilePath(agent))
  const imageUrl = getAbsoluteUrl(getAgentOgPath(agent))

  const handleShareX = () => {
    const params = new URLSearchParams({
      text: formatAgentShareText(agent),
      url: profileUrl,
    })
    window.open(`https://twitter.com/intent/tweet?${params.toString()}`, "_blank", "noopener,noreferrer")
  }

  const handleCopyImage = async () => {
    try {
      await navigator.clipboard.writeText(imageUrl)
      toast.success("Image URL copied")
    } catch {
      toast.error("Could not copy image URL")
    }
  }

  const handleDownload = async () => {
    try {
      const response = await fetch(imageUrl)
      if (!response.ok) throw new Error("image fetch failed")
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = `agentic-city-${slugifyAgent(agent)}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
      toast.success("OG card downloaded")
    } catch {
      toast.error("Could not download OG card")
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
        Share Card
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
        <ShareActionButton
          label="Share on X"
          title="Share this agent profile on X"
          color="#22d3ee"
          icon={<Share2 size={13} aria-hidden="true" />}
          onClick={handleShareX}
        />
        <ShareActionButton
          label="Copy image URL"
          title="Copy this agent OG image URL"
          color="#34d399"
          icon={<Copy size={13} aria-hidden="true" />}
          onClick={handleCopyImage}
        />
        <ShareActionButton
          label="Download PNG"
          title="Download this agent OG image"
          color="#fbbf24"
          icon={<Download size={13} aria-hidden="true" />}
          onClick={handleDownload}
        />
      </div>
    </div>
  )
}

function formatNotificationType(type: NotificationItem["type"]): string {
  if (type === "agent_offline") return "Offline"
  if (type === "quest_completed") return "Quest"
  return "Rep"
}

function NotificationBell({ agentId }: { agentId: string | null }) {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)

  const loadNotifications = useCallback(async () => {
    if (!agentId) {
      setNotifications([])
      setUnreadCount(0)
      return
    }

    try {
      const response = await fetch(`/api/notifications?agentId=${encodeURIComponent(agentId)}&limit=10`, { cache: "no-store" })
      if (!response.ok) throw new Error("Notification API unavailable")
      const data = await response.json()
      setNotifications(Array.isArray(data.notifications) ? data.notifications : [])
      setUnreadCount(typeof data.unreadCount === "number" ? data.unreadCount : 0)
    } catch {
      setNotifications([])
      setUnreadCount(0)
    }
  }, [agentId])

  useEffect(() => {
    loadNotifications()
    const timer = window.setInterval(loadNotifications, 15_000)
    return () => window.clearInterval(timer)
  }, [loadNotifications])

  const markAllRead = async () => {
    if (!agentId) return

    const response = await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    })
    if (!response.ok) {
      toast.error("Could not mark notifications read")
      return
    }

    setUnreadCount(0)
    setNotifications([])
  }

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value)
          loadNotifications()
        }}
        disabled={!agentId}
        title={agentId ? "Notifications" : "Select an agent for notifications"}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
        style={{
          position: "relative",
          width: 34,
          height: 38,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          borderBottom: "2px solid transparent",
          color: agentId ? "#94a3b8" : "#475569",
          cursor: agentId ? "pointer" : "not-allowed",
        }}
      >
        <Bell size={15} aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 5,
              right: 3,
              minWidth: 15,
              height: 15,
              borderRadius: 8,
              background: "#f87171",
              color: "#fff",
              fontSize: 8,
              fontFamily: "monospace",
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
            }}
          >
            {unreadCount > 99 ? "99" : unreadCount}
          </span>
        )}
      </button>

      {open && agentId && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: "absolute",
            right: 0,
            top: 40,
            width: 286,
            maxHeight: 360,
            overflow: "hidden",
            zIndex: 40,
            background: "#0f172a",
            border: "1px solid #2a3a52",
            borderRadius: 6,
            boxShadow: "0 16px 40px rgba(2, 6, 23, 0.45)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 10, borderBottom: "1px solid #263449" }}>
            <div style={{ color: "#e2e8f0", fontSize: 11, fontFamily: "monospace", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.7 }}>
              Notifications
            </div>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              title="Mark all notifications read"
              aria-label="Mark all notifications read"
              style={{
                width: 26,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: unreadCount > 0 ? "#22d3ee22" : "#111827",
                border: `1px solid ${unreadCount > 0 ? "#22d3ee55" : "#334155"}`,
                borderRadius: 5,
                color: unreadCount > 0 ? "#67e8f9" : "#475569",
                cursor: unreadCount > 0 ? "pointer" : "not-allowed",
              }}
            >
              <CheckCheck size={14} aria-hidden="true" />
            </button>
          </div>

          <div style={{ maxHeight: 306, overflow: "auto", padding: notifications.length > 0 ? 6 : 10 }}>
            {notifications.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 11, fontFamily: "monospace" }}>No unread alerts</div>
            ) : (
              notifications.map((notification) => (
                <a
                  key={notification.id}
                  href={notification.resourceHref}
                  style={{
                    display: "block",
                    padding: "8px 7px",
                    borderRadius: 5,
                    color: "#cbd5e1",
                    textDecoration: "none",
                    border: "1px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
                    <span style={{ color: "#22d3ee", fontSize: 9, fontFamily: "monospace", fontWeight: 800, textTransform: "uppercase" }}>
                      {formatNotificationType(notification.type)}
                    </span>
                    <span style={{ color: "#475569", fontSize: 9, fontFamily: "monospace" }}>
                      {new Date(notification.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 12, fontFamily: "monospace", fontWeight: 700, marginBottom: 2 }}>
                    {notification.title}
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 10, lineHeight: 1.35 }}>
                    {notification.body}
                  </div>
                  <div style={{ color: "#64748b", fontSize: 9, fontFamily: "monospace", marginTop: 4 }}>
                    {notification.resourceLabel}
                  </div>
                </a>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AgentRow({
  agent,
  isSelected,
  colorBlindMode,
  onClick,
}: {
  agent: MoltbotAgent
  isSelected: boolean
  colorBlindMode?: boolean
  onClick: () => void
}) {
  const statusColors: Record<string, string> = {
    active: "#34d399", working: "#fbbf24", idle: "#64748b", error: "#f87171", offline: "#1e293b",
  }
  return (
    <button
      type="button"
      onClick={onClick}
      role="option"
      aria-selected={isSelected}
      aria-label={`${agent.name}, ${agent.status}, CPU ${agent.cpu} percent, ${agent.currentTask || "no active task"}`}
      style={{
        position: "relative",
        zIndex: isSelected ? 2 : 1,
        pointerEvents: "auto",
        touchAction: "manipulation",
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 8px",
        background: isSelected ? "#1e293b" : "transparent",
        border: isSelected ? "1px solid #2a3a52" : "1px solid transparent",
        borderRadius: 6,
        cursor: "pointer",
        color: "#e2e8f0",
        textAlign: "left",
        transition: "background 0.15s",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: colorBlindMode ? 14 : 8,
          height: colorBlindMode ? 14 : 8,
          borderRadius: colorBlindMode ? 3 : "50%",
          background: statusColors[agent.status],
          color: "#020617",
          flexShrink: 0,
          fontSize: 10,
          lineHeight: "14px",
          textAlign: "center",
          fontFamily: "monospace",
          fontWeight: 700,
        }}
      >
        {colorBlindMode ? statusSymbols[agent.status] ?? "•" : ""}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: agent.color }}>{agent.name}</span>
          {agent.deployment === "cloud" ? (
            <span style={{ border: "1px solid #38bdf855", borderRadius: 999, padding: "1px 5px", fontSize: 9, color: "#7dd3fc", fontFamily: "monospace" }}>cloud</span>
          ) : null}
        </div>
        <div style={{ fontSize: 10, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {agent.currentTask || agent.status}
        </div>
      </div>
      <div suppressHydrationWarning style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace" }}>{agent.cpu}%</div>
    </button>
  )
}

function OverviewTab({
  agents,
  selectedAgent,
  logs,
  onSelectAgent,
  colorBlindMode,
  onColorBlindModeChange,
}: {
  agents: MoltbotAgent[]
  selectedAgent: MoltbotAgent | null
  logs: LogEntry[]
  onSelectAgent: (id: string | null) => void
  colorBlindMode: boolean
  onColorBlindModeChange: (enabled: boolean) => void
}) {
  const [logExpanded, setLogExpanded] = useState(false)

  const active = agents.filter(a => a.status === "active" || a.status === "working").length
  const working = agents.filter(a => a.status === "working").length
  const errors = agents.filter(a => a.status === "error").length
  const totalTasks = agents.reduce((s, a) => s + a.tasksCompleted, 0)
  const offerCounts = selectedAgent ? getTaskOfferCounts(selectedAgent.id, MOCK_OFFERS) : null
  const [reputation, setReputation] = useState<{ score: number; tier: string } | null>(null)
  const [attestation, setAttestation] = useState<{ hash: string; stellarExpertUrl: string } | null>(null)
  const [mintingAttestation, setMintingAttestation] = useState(false)
  const selectedAgentId = selectedAgent?.id ?? null

  useEffect(() => {
    if (!selectedAgentId) {
      setReputation(null)
      setAttestation(null)
      return
    }

    let cancelled = false
    fetch(`/api/protocol/reputation?actorId=${encodeURIComponent(selectedAgentId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const score = typeof data?.reputation?.score === "number" ? data.reputation.score : 0
        setReputation({ score, tier: String(data?.reputation?.tier || getReputationTier(score)) })
      })
      .catch(() => {
        if (!cancelled) setReputation(null)
      })
    return () => { cancelled = true }
  }, [selectedAgentId])

  const mintReputationAttestation = useCallback(async () => {
    if (!selectedAgentId) return
    setMintingAttestation(true)
    try {
      const res = await fetch('/api/protocol/reputation/attestation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorId: selectedAgentId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Mint failed')
      setReputation({ score: data.reputation.score, tier: data.reputation.tier })
      setAttestation(data.attestation)
      toast.success('Reputation attestation minted', { description: data.attestation.hash.slice(0, 18) + '…' })
    } catch (error) {
      toast.error('Attestation mint failed', { description: error instanceof Error ? error.message : 'Unknown error' })
    }
    setMintingAttestation(false)
  }, [selectedAgentId])

  const logTypeColors: Record<string, string> = {
    info: "#60a5fa", success: "#34d399", error: "#f87171", warning: "#fbbf24",
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Stats */}
      <div style={{ padding: 12, borderBottom: "1px solid #2a3a52" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>
            City Overview
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#94a3b8", fontFamily: "monospace" }}>
            <input
              type="checkbox"
              checked={colorBlindMode}
              onChange={(event) => onColorBlindModeChange(event.target.checked)}
              aria-label="Toggle color-blind mode"
            />
            Shapes
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <StatBox label="Active" value={active} color="#34d399" />
          <StatBox label="Working" value={working} color="#fbbf24" />
          <StatBox label="Errors" value={errors} color="#f87171" />
          <StatBox label="Tasks Done" value={totalTasks} color="#22d3ee" />
        </div>
      </div>

      {/* Selected agent detail */}
      {selectedAgent && (
        <div style={{ padding: 12, borderBottom: "1px solid #2a3a52", background: "#0f172a" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: selectedAgent.color, fontFamily: "monospace" }}>
                {selectedAgent.name}
              </span>
              <span style={{ fontFamily: "monospace", fontSize: 9, fontWeight: 800, color: tierColor(reputation?.tier || "Unrated"), border: `1px solid ${tierColor(reputation?.tier || "Unrated")}55`, borderRadius: 999, padding: "2px 6px", textTransform: "uppercase" }}>
                {reputation?.tier || "unrated"}
              </span>
            </div>
            <button
              onClick={() => onSelectAgent(null)}
              style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
              aria-label="Close agent detail"
            >
              x
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>
            Model: {selectedAgent.model}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>
            District: {DISTRICTS.find(d => d.id === selectedAgent.district)?.name}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
            {"Status: "}
            <span style={{ color: selectedAgent.status === "error" ? "#f87171" : "#34d399", fontWeight: 600 }}>
              {selectedAgent.status.toUpperCase()}
            </span>
          </div>

          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>{"CPU " + selectedAgent.cpu + "%"}</div>
          <ProgressBar value={selectedAgent.cpu} color="#22d3ee" />
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4, marginTop: 6 }}>{"Memory " + selectedAgent.memory + "%"}</div>
          <ProgressBar value={selectedAgent.memory} color="#a78bfa" />

          {selectedAgent.currentTask && (
            <>
              <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4, marginTop: 6 }}>
                {"Task: " + selectedAgent.currentTask}
              </div>
              <ProgressBar value={selectedAgent.taskProgress} color={selectedAgent.color} />
            </>
          )}

          <div suppressHydrationWarning style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
            {"Completed: " + selectedAgent.tasksCompleted + " tasks"}
          </div>

          <div style={{ marginTop: 8, padding: 8, border: "1px solid #1e293b", borderRadius: 6, background: "#111827" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>
              <span>Reputation</span>
              <span style={{ color: tierColor(reputation?.tier || "Unrated"), fontWeight: 700 }}>{reputation?.score ?? "--"}/1300</span>
            </div>
            <ProgressBar value={Math.min(100, ((reputation?.score ?? 0) / 1300) * 100)} color={tierColor(reputation?.tier || "Unrated")} />
            {/* The attestation is minted on Soroban, so it only shows when Stellar is enabled. */}
            {STELLAR_ENABLED && <button
              onClick={mintReputationAttestation}
              disabled={mintingAttestation}
              style={{ width: "100%", marginTop: 8, padding: "6px 8px", background: "#22d3ee22", color: "#67e8f9", border: "1px solid #22d3ee44", borderRadius: 4, cursor: mintingAttestation ? "wait" : "pointer", fontFamily: "monospace", fontSize: 10, fontWeight: 700 }}
            >
              {mintingAttestation ? "Minting..." : "Mint reputation attestation"}
            </button>}
            {STELLAR_ENABLED && attestation && (
              <a href={attestation.stellarExpertUrl} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 6, color: "#38bdf8", fontFamily: "monospace", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {attestation.hash}
              </a>
            )}
          </div>
          {offerCounts && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <StatBox label="Posted" value={offerCounts.posted} color="#67e8f9" />
              <StatBox label="Filled" value={offerCounts.filled} color="#34d399" />
            </div>
          )}

          <AgentShareControls agent={selectedAgent} />
        </div>
      )}

      {/* Agent list */}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 8px" }}>
        <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, padding: "0 4px" }}>
          {"Agents (" + agents.length + ")"}
        </div>
        <div role="listbox" aria-label="Agents" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {agents.map(a => (
            <AgentRow
              key={a.id}
              agent={a}
              isSelected={selectedAgent?.id === a.id}
              colorBlindMode={colorBlindMode}
              onClick={() => onSelectAgent(a.id)}
            />
          ))}
        </div>
      </div>

      {/* Activity log — expandable */}
      <div style={{
        height: logExpanded ? 280 : 140,
        borderTop: "1px solid #2a3a52",
        overflow: "auto",
        padding: 8,
        transition: "height 0.2s ease",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>
            Activity Log
          </div>
          <button
            onClick={() => setLogExpanded(e => !e)}
            style={{
              background: "none",
              border: "none",
              color: "#475569",
              cursor: "pointer",
              fontSize: 10,
              fontFamily: "monospace",
              padding: "2px 4px",
              transition: "color 0.15s",
            }}
            title={logExpanded ? "Collapse log" : "Expand log"}
          >
            {logExpanded ? "▼" : "▲"}
          </button>
        </div>
        <div role="status" aria-live="polite" aria-label="Activity log content">
          {logs.slice(-40).reverse().map(log => (
            <div key={log.id} style={{ fontSize: 10, marginBottom: 3, display: "flex", gap: 6, lineHeight: 1.4 }}>
              <span style={{ color: "#475569", flexShrink: 0, fontFamily: "monospace" }}>{log.time}</span>
              <span style={{ color: logTypeColors[log.type] || "#94a3b8" }}>
                <strong>{log.agent}</strong> {log.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function SidebarPanel({
  agents,
  selectedAgent,
  logs,
  chatMessages,
  transactions,
  onSelectAgent,
  onUpdateAgent,
  onAddTransaction,
  onUpgradeSkill,
  onUpdateAgentAppearance,
  colorBlindMode,
  onColorBlindModeChange,
  activeTab: controlledActiveTab,
  onActiveTabChange,
  variant = "desktop",
  showTabBar = true,
}: SidebarPanelProps) {
  // Start with null to avoid SSR/client hydration mismatch.
  // The server always renders 'overview' (null resolves to it), and after
  // mount we synchronously read localStorage and correct the tab if needed.
  const [uncontrolledActiveTab, setUncontrolledActiveTab] = useState<SidebarTabId | null>(null)
  const hydratedRef = useRef(false)

  // On mount: restore persisted tab from localStorage (client-only).
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const storedTab = localStorage.getItem("sidebar-tab") as SidebarTabId | null
    if (storedTab && SIDEBAR_TABS.some((tab) => tab.id === storedTab)) {
      setUncontrolledActiveTab(storedTab)
    } else {
      setUncontrolledActiveTab("overview")
    }
  }, [])

  const activeTab = controlledActiveTab ?? uncontrolledActiveTab ?? "overview"

  const setActiveTab = useCallback(
    (tab: SidebarTabId) => {
      setUncontrolledActiveTab(tab)
      localStorage.setItem("sidebar-tab", tab)
      onActiveTabChange?.(tab)
    },
    [onActiveTabChange],
  )

  // Persist whenever activeTab changes (handles controlled-mode changes too).
  useEffect(() => {
    if (!hydratedRef.current) return
    localStorage.setItem("sidebar-tab", activeTab)
  }, [activeTab])

  const chatCount = chatMessages.length
  const errorCount = agents.filter(a => a.status === "error").length
  // The low-balance dot tracks the legacy Stellar agent wallets.
  const walletAlert = STELLAR_ENABLED && agents.some(a => !a.wallet || (a.wallet.funded && parseFloat(a.wallet.balance) < 10))
  const openOfferCount = MOCK_OFFERS.filter(offer => offer.status === "open").length
  const tabIconMap: Partial<Record<SidebarTabId, ReactNode>> = {
    models: <BrainCircuit size={14} aria-hidden="true" />,
    connectors: <PlugZap size={14} aria-hidden="true" />,
  }

  return (
    <div style={{
      width: variant === "mobile" ? "100%" : 320,
      height: "100%",
      background: "#111827",
      borderLeft: variant === "mobile" ? "none" : "1px solid #2a3a52",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      flexShrink: 0,
    }}>
      {showTabBar && (
        <div style={{
          display: "flex",
          borderBottom: "1px solid #2a3a52",
          background: "#0f172a",
          flexShrink: 0,
          overflowX: "auto",
          scrollbarWidth: "thin",
        }}>
          {SIDEBAR_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              aria-label={`${tab.label} tab`}
              suppressHydrationWarning
              style={{
                flex: "0 0 auto",
                minHeight: variant === "mobile" ? 46 : undefined,
                padding: variant === "mobile" ? "12px 9px" : "10px 9px",
                background: activeTab === tab.id ? "#111827" : "transparent",
                border: "none",
                borderBottom: activeTab === tab.id ? "2px solid #22d3ee" : "2px solid transparent",
                color: activeTab === tab.id ? "#22d3ee" : "#64748b",
                fontFamily: "monospace",
                fontSize: variant === "mobile" ? 11 : 10,
                fontWeight: activeTab === tab.id ? 700 : 400,
                cursor: "pointer",
                transition: "all 0.15s",
                position: "relative",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                {tabIconMap[tab.id]}
                <span>{tab.label}</span>
              </span>
              {tab.id === "chat" && chatCount > 0 && (
                <span style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#34d399",
                }} />
              )}
              {tab.id === "offers" && openOfferCount > 0 && (
                <span style={{
                  position: "absolute",
                  top: 3,
                  right: 2,
                  minWidth: 14,
                  height: 14,
                  borderRadius: 7,
                  background: "#22d3ee",
                  color: "#020617",
                  fontSize: 8,
                  fontFamily: "monospace",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 2px",
                }}>
                  {openOfferCount}
                </span>
              )}
              {tab.id === "overview" && errorCount > 0 && (
                <span style={{
                  position: "absolute",
                  top: 3,
                  right: 2,
                  minWidth: 14,
                  height: 14,
                  borderRadius: 7,
                  background: "#f87171",
                  color: "#fff",
                  fontSize: 8,
                  fontFamily: "monospace",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 2px",
                }}>
                  {errorCount}
                </span>
              )}
              {tab.id === "wallet" && walletAlert && (
                <span style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#fbbf24",
                }} />
              )}
            </button>
          ))}
          <NotificationBell agentId={selectedAgent?.id ?? null} />
          <a
            href="/explorer"
            title="Recibos en cadena: pagos x402, contrataciones y 8004 en Solana devnet"
            style={{
              padding: "10px 8px",
              background: "transparent",
              borderBottom: "2px solid transparent",
              color: "#5eead4",
              fontFamily: "monospace",
              fontSize: 10,
              fontWeight: 400,
              cursor: "pointer",
              textDecoration: "none",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              display: "flex",
              alignItems: "center",
              whiteSpace: "nowrap",
              transition: "color 0.15s",
              flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "#99f6e4")}
            onMouseLeave={e => (e.currentTarget.style.color = "#5eead4")}
          >
            Recibos ↗
          </a>
          <a
            href="/admin"
            style={{
              padding: "10px 8px",
              background: "transparent",
              borderBottom: "2px solid transparent",
              color: "#22d3ee",
              fontFamily: "monospace",
              fontSize: 10,
              fontWeight: 400,
              cursor: "pointer",
              textDecoration: "none",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              display: "flex",
              alignItems: "center",
              whiteSpace: "nowrap",
              transition: "color 0.15s",
              flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "#67e8f9")}
            onMouseLeave={e => (e.currentTarget.style.color = "#22d3ee")}
          >
            Admin ↗
          </a>
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTab === "overview" && (
          <OverviewTab
            agents={agents}
            selectedAgent={selectedAgent}
            logs={logs}
            onSelectAgent={onSelectAgent}
            colorBlindMode={colorBlindMode}
            onColorBlindModeChange={onColorBlindModeChange}
          />
        )}
        {activeTab === "chat" && (
          <ChatPanel messages={chatMessages} />
        )}
        {activeTab === "models" && (
          <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
            <ConnectionsPanel compact initialSection="models" />
          </div>
        )}
        {activeTab === "connectors" && (
          <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
            <ConnectionsPanel compact initialSection="connectors" />
          </div>
        )}
        {activeTab === "offers" && (
          <TaskBoard agents={agents} selectedAgent={selectedAgent} />
        )}
        {activeTab === "skills" && (
          <SkillsPanel selectedAgent={selectedAgent} agents={agents} onUpgradeSkill={onUpgradeSkill} />
        )}
        {activeTab === "quests" && (
          <QuestsPanel selectedAgentId={selectedAgent?.id ?? null} />
        )}
        {activeTab === "wallet" && (
          <div className="h-full space-y-3 overflow-y-auto p-3">
          <AgentWalletPanel />
          <PaidTaskPanel />
          {/* Legacy Stellar wallet (Freighter, XLM, Friendbot): hidden unless NEXT_PUBLIC_ENABLE_STELLAR is on. */}
          {STELLAR_ENABLED && (
            <WalletPanel
              agents={agents}
              selectedAgent={selectedAgent}
              transactions={transactions}
              onUpdateAgent={onUpdateAgent}
              onAddTransaction={onAddTransaction}
            />
          )}
          </div>
        )}
        {activeTab === "appearance" && (
          <AppearancePanel
            agents={agents}
            selectedAgent={selectedAgent}
            onUpdateAgentAppearance={onUpdateAgentAppearance}
          />
        )}
      </div>
    </div>
  )
}
