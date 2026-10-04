"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import { Activity, Bot, BriefcaseBusiness, MessageSquare, PanelBottomOpen, Palette, ScrollText, WalletCards, Wrench } from "lucide-react"
import { toast } from "sonner"
import { PixelCity, type FloatingOverlay, type ParticleTrigger, type TxAnimation } from "@/components/pixel-city"
import { SidebarPanel, SIDEBAR_TABS, type SidebarTabId } from "@/components/sidebar-panel"
import { AudioControls } from "@/components/audio-controls"
import { DistrictEventOverlay } from "@/components/open-stellar/district-event-overlay"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { MOCK_OFFERS } from "@/components/task-board"
import { CityAudioEngine } from "@/lib/audio/city-audio"
import { DISTRICTS, createAgents, generateChatMessage, getRandomTask } from "@/lib/data"
import { LEGAL_LINKS } from "@/lib/legal-links"
import { fetchCloudAgentsForAdmin } from "@/lib/admin-cloud-agents"
import { ThemeToggleNavbar } from "@/components/theme-toggle-navbar"
import { formatAssetAmount } from "@/lib/config/chains"
import type { PublishedSystemEvent } from "@/lib/events/system-events"
import { XP_AWARDS } from "@/lib/gamification/constants"
import { getActiveDistrictEvent, getDistrictStandings } from "@/lib/gamification/events"
import { upgradeAgentSkill } from "@/lib/gamification/skill-upgrades"
import { awardSkillXP, checkLevelUp, getXpToNextLevel } from "@/lib/gamification/xp"
import type { AgentAppearance, ChatMessage, LogEntry, MoltbotAgent, WalletTransaction } from "@/lib/types"

function nowTime() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

function secureRandom(): number {
  const array = new Uint32Array(1)
  const c = typeof crypto !== "undefined" ? crypto : (globalThis as any).crypto
  c.getRandomValues(array)
  return array[0] / 4294967296
}

const ONBOARDING_STEPS = [
  {
    title: "Agentic City",
    body: "The city starts with a simulated roster. Register API-connected agents in Admin to monitor their live status here.",
    hint: "← try clicking a bot",
  },
  {
    title: "Sidebar Controls",
    body: "The sidebar has tabs for AI models, connectors, team orchestration, chat, offers, skills, quests, appearance, and a Solana wallet to pay agents per task with x402.",
    hint: "→ explore the tabs",
  },
  {
    title: "Bring Your Own AI",
    body: "Open Modelos IA or Complementos from the sidebar to connect your own paid providers and tools, then build the agent team that runs missions.",
    hint: "connect models first",
  },
]

const MOBILE_NAV_ICONS: Record<SidebarTabId, ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>> = {
  overview: Activity,
  models: Bot,
  connectors: PanelBottomOpen,
  chat: MessageSquare,
  offers: BriefcaseBusiness,
  skills: Wrench,
  quests: ScrollText,
  wallet: WalletCards,
  appearance: Palette,
}

// The mobile nav: a 3-column grid of the tabs plus the Admin link, 56px rows, 6px gaps, 18px padding.
const MOBILE_NAV_ROWS = Math.ceil((SIDEBAR_TABS.length + 1) / 3)
const MOBILE_NAV_HEIGHT = MOBILE_NAV_ROWS * 56 + (MOBILE_NAV_ROWS - 1) * 6 + 18
// Challenge card (12 + 280px) plus the widest top-right overlay (city status, about 220px) and gaps.
const NARROW_MAP_WIDTH = 540
// Below the top-right column: the map controls end near 160px.
const CHALLENGE_TOP_NARROW = 168

interface AgentHealthApiSnapshot {
  agentId: string
  status: "healthy" | "stale" | "offline"
  runtimeStatus: "active" | "idle" | "working" | "error" | "offline"
  lastHeartbeat: string
  offlineForSeconds: number
  cpu: number | null
  memory: number | null
  currentTask: string | null
}

interface AgentPositionPayload {
  agentId: string
  pixelX: number
  pixelY: number
  targetX: number
  targetY: number
  direction: "left" | "right"
}

interface AgentPositionSnapshotPayload {
  type: "agent.positions.snapshot"
  positions: AgentPositionPayload[]
}

interface AgentPositionDeltaPayload {
  type: "agent.position"
  agents: AgentPositionPayload[]
}

function OnboardingModal({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const current = ONBOARDING_STEPS[step]
  const isLast = step === ONBOARDING_STEPS.length - 1

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 100,
      background: "rgba(3,7,18,0.88)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <div style={{
        background: "#111827",
        border: "1px solid #2a3a52",
        borderRadius: 16,
        boxSizing: "border-box",
        padding: "clamp(20px, 7vw, 32px)",
        maxWidth: 380,
        width: "min(90vw, 380px)",
        maxHeight: "calc(100dvh - 32px)",
        overflowY: "auto",
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
      }}>
        {/* Step dots */}
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 24 }}>
          {ONBOARDING_STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: i === step ? "#22d3ee" : "#2a3a52",
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>

        <div style={{
          fontFamily: "monospace",
          fontSize: 9,
          color: "#22d3ee",
          textTransform: "uppercase",
          letterSpacing: 2,
          marginBottom: 12,
        }}>
          {`Step ${step + 1} of ${ONBOARDING_STEPS.length}`}
        </div>

        <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#e2e8f0", marginBottom: 12 }}>
          {current.title}
        </div>

        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", lineHeight: 1.7, marginBottom: 16 }}>
          {current.body}
        </div>

        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#475569", marginBottom: 28 }}>
          {current.hint}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {step > 0 && (
            <button
              onClick={() => setStep(s => s - 1)}
              style={{
                flex: 1,
                padding: "8px 16px",
                background: "transparent",
                border: "1px solid #2a3a52",
                borderRadius: 6,
                color: "#64748b",
                fontFamily: "monospace",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Back
            </button>
          )}
          <button
            onClick={() => { if (isLast) { onDone() } else { setStep(s => s + 1) } }}
            style={{
              flex: 2,
              padding: "8px 16px",
              background: "#22d3ee22",
              border: "1px solid #22d3ee44",
              borderRadius: 6,
              color: "#22d3ee",
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            {isLast ? "Get started" : "Next"}
          </button>
        </div>

        <button
          onClick={onDone}
          style={{
            display: "block",
            width: "100%",
            marginTop: 12,
            background: "none",
            border: "none",
            color: "#334155",
            fontFamily: "monospace",
            fontSize: 10,
            cursor: "pointer",
          }}
        >
          skip
        </button>

        <div style={{
          display: "flex",
          justifyContent: "center",
          gap: 10,
          flexWrap: "wrap",
          marginTop: 16,
          borderTop: "1px solid #1f2a44",
          paddingTop: 14,
        }}>
          {LEGAL_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              style={{
                color: "#64748b",
                fontFamily: "monospace",
                fontSize: 10,
                textDecoration: "none",
              }}
            >
              {link.shortLabel}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

export function OpenStellarHub({ initialDistrictEvent }: { initialDistrictEvent: ReturnType<typeof getActiveDistrictEvent> }) {
  const [agents, setAgents] = useState<MoltbotAgent[]>(() => createAgents())
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [tick, setTick] = useState(0)
  const [txAnimations, setTxAnimations] = useState<TxAnimation[]>([])
  const [floatingOverlays, setFloatingOverlays] = useState<FloatingOverlay[]>([])
  const [particleTriggers, setParticleTriggers] = useState<ParticleTrigger[]>([])
  const agentLevelsRef = useRef<Map<string, number>>(new Map())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Keep the server and first client render identical; restore the saved tab in
  // the effect below after hydration.
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>("overview")
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false)
  const [isMobile, setIsMobile] = useState<boolean | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [colorBlindMode, setColorBlindMode] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [eventStreamConnected, setEventStreamConnected] = useState(false)
  const [hasRealtimeEvents, setHasRealtimeEvents] = useState(false)
  const fallbackLoggedRef = useRef(false)
  const positionStreamErrorLoggedRef = useRef(false)
  const [audioEngine] = useState(() => new CityAudioEngine())
  const [activeDistrictEvent, setActiveDistrictEvent] = useState(initialDistrictEvent)
  const lastLeadingDistrictRef = useRef<string | null>(null)

  useEffect(() => {
    return () => audioEngine.dispose()
  }, [audioEngine])

  // Width of the map area. On a narrow map (a phone, or a tablet with the sidebar open) the
  // challenge card at the top left would run into the top-right column (admin link, theme toggle,
  // city status, map controls), so it moves below that column.
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null)
  useEffect(() => {
    const element = canvasAreaRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => setCanvasWidth(Math.round(entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const challengeTop = canvasWidth !== null && canvasWidth < NARROW_MAP_WIDTH ? CHALLENGE_TOP_NARROW : 12

  // Show onboarding once on first visit
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const storedColorBlind = localStorage.getItem("colorblind-mode")
    const storedTab = localStorage.getItem("sidebar-tab") as SidebarTabId | null
    const queryColorBlind = params.get("colorblind")
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const mobileQuery = window.matchMedia("(max-width: 767px)")

    const colorBlindEnabled = queryColorBlind === "true" || storedColorBlind === "true"
    setColorBlindMode(colorBlindEnabled)
    if (queryColorBlind === "true") {
      localStorage.setItem("colorblind-mode", "true")
    }
    if (storedTab && SIDEBAR_TABS.some((tab) => tab.id === storedTab)) {
      setSidebarTab(storedTab)
    }
    setReduceMotion(prefersReducedMotion.matches)

    const handleMotionChange = (event: MediaQueryListEvent) => {
      setReduceMotion(event.matches)
    }

    const handleMobileChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches)
      setSidebarOpen(!event.matches)
      if (!event.matches) {
        setMobileControlsOpen(false)
      }
    }

    prefersReducedMotion.addEventListener("change", handleMotionChange)
    mobileQuery.addEventListener("change", handleMobileChange)
    setIsMobile(mobileQuery.matches)

    if (!localStorage.getItem("onboarding-seen")) {
      setShowOnboarding(true)
    }
    // Collapse sidebar by default on small screens
    if (mobileQuery.matches) {
      setSidebarOpen(false)
    }

    return () => {
      prefersReducedMotion.removeEventListener("change", handleMotionChange)
      mobileQuery.removeEventListener("change", handleMobileChange)
    }
  }, [])

  // Persist the active tab whenever it changes.
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("sidebar-tab", sidebarTab)
    }
  }, [sidebarTab])

  const handleColorBlindModeChange = useCallback((enabled: boolean) => {
    setColorBlindMode(enabled)
    localStorage.setItem("colorblind-mode", String(enabled))
  }, [])

  const handleDoneOnboarding = useCallback(() => {
    setShowOnboarding(false)
    localStorage.setItem("onboarding-seen", "1")
  }, [])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId]
  )

  const pushLog = useCallback((message: string, type: LogEntry["type"] = "info", agent = "system") => {
    setLogs((prev) => [
      ...prev.slice(-79),
      {
        id: Date.now() + Math.floor(secureRandom() * 1000),
        time: nowTime(),
        agent,
        message,
        type,
      },
    ])
  }, [])

  const agentsRef = useRef(agents)
  useEffect(() => {
    agentsRef.current = agents
    for (const agent of agents) {
      if (!agentLevelsRef.current.has(agent.id)) {
        agentLevelsRef.current.set(agent.id, agent.level ?? 1)
      }
    }
  }, [agents])

  useEffect(() => {
    pushLog("Agentic City frontend initialized", "success")
  }, [pushLog])

  const animateAgentToDistrict = useCallback((agent: MoltbotAgent) => {
    const district = DISTRICTS.find((candidate) => candidate.id === agent.district)
    if (!district) return

    setTxAnimations((prev) => [
      ...prev,
      {
        id: Date.now() + Math.floor(secureRandom() * 1000),
        fromX: agent.pixelX + 8,
        fromY: agent.pixelY + 10,
        toX: district.x + district.w / 2,
        toY: district.y + district.h / 2,
        startedAt: Date.now(),
        duration: 1600,
      },
    ])
  }, [])

  const showAgentOverlay = useCallback((agent: MoltbotAgent, text: string, color = "#fbbf24") => {
    setFloatingOverlays((prev) => [
      ...prev,
      {
        id: Date.now() + Math.floor(secureRandom() * 1000),
        x: agent.pixelX + 8,
        y: agent.pixelY,
        text,
        color,
        startedAt: Date.now(),
        duration: 2200,
      },
    ])
  }, [])

  const spawnParticles = useCallback(
    (type: ParticleTrigger["type"], x: number, y: number, opts?: ParticleTrigger["opts"]) => {
      setParticleTriggers((prev) => [
        ...prev,
        {
          id: Date.now() + Math.floor(secureRandom() * 1000),
          type,
          x,
          y,
          opts,
        },
      ])
    },
    []
  )


  const districtStandings = useMemo(
    () => getDistrictStandings(agents),
    [agents]
  )

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveDistrictEvent(getActiveDistrictEvent())
    }, 60_000)

    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const leader = districtStandings[0]
    if (!leader) return
    const previousLeader = lastLeadingDistrictRef.current
    lastLeadingDistrictRef.current = leader.districtId
    if (!previousLeader || previousLeader === leader.districtId) return

    const district = DISTRICTS.find((candidate) => candidate.id === leader.districtId)
    if (!district) return
    pushLog(`${leader.districtName} takes the lead in ${activeDistrictEvent.challenge.name}`, "success")
    spawnParticles("district-win", district.x + district.w / 2, district.y, {
      color: district.color,
      spreadW: district.w * 0.7,
    })
  }, [activeDistrictEvent.challenge.name, districtStandings, pushLog, spawnParticles])

  const applySystemEvent = useCallback((event: PublishedSystemEvent) => {
    const animatedAgentBox: { current: MoltbotAgent | null } = { current: null }

    setAgents((prev) =>
      prev.map((agent) => {
        if (agent.id !== event.agentId) return agent

        if (event.type === "agent.status") {
          return { ...agent, status: event.status }
        }

        if (event.type === "task.started") {
          return {
            ...agent,
            status: "working",
            currentTask: event.task.title,
            taskProgress: 0,
          }
        }

        if (event.type === "task.completed") {
          animatedAgentBox.current = agent
          const skillId = event.skillId ?? agent.skills[0]?.id
          return {
            ...agent,
            status: "active",
            currentTask: event.result.summary || getRandomTask(agent.district),
            taskProgress: 0,
            tasksCompleted: agent.tasksCompleted + 1,
            skills: awardSkillXP(agent.skills, skillId, XP_AWARDS.TASK_COMPLETED),
          }
        }

        if (event.type === "payment.received") {
          animatedAgentBox.current = agent
          return {
            ...agent,
            status: "active",
          }
        }

        if (event.type === "agent.xp") {
          const level = event.level
          return {
            ...agent,
            xp: event.totalXp ?? (agent.xp ?? 0) + event.xp,
            level,
            xpToNext: event.xpToNext ?? getXpToNextLevel(level),
          }
        }

        return agent
      })
    )

    if (event.type === "task.completed") {
      audioEngine.playEvent("task_complete")
      pushLog(`task completed: ${event.taskId} — ${event.result.summary}`, "success", event.agentId)
      const agent = animatedAgentBox.current
      if (agent) {
        animateAgentToDistrict(agent)
        showAgentOverlay(agent, "+task", "#34d399")
        const district = DISTRICTS.find((candidate) => candidate.id === agent.district)
        spawnParticles("xp-burst", agent.pixelX + 8, agent.pixelY, {
          color: district?.color ?? agent.color,
        })
      }
      return
    }

    if (event.type === "payment.received") {
      audioEngine.playEvent("payment_received")
      pushLog(`payment received on ${event.receipt.chain}: ${event.receipt.txHash.slice(0, 12)}...`, "success", event.agentId)
      const amount = event.receipt.amountUsd ? `$${event.receipt.amountUsd.toFixed(3)}` : event.receipt.chain
      toast.success("Payment received", { description: `${event.agentId} settled ${amount}` })
      const agent = animatedAgentBox.current
      if (agent) {
        animateAgentToDistrict(agent)
        showAgentOverlay(agent, `+${amount}`, "#fbbf24")
        const xlmAmount = `+${formatAssetAmount(event.receipt.amountUnits || "0.01")}`
        spawnParticles("payment-spark", agent.pixelX + 8, agent.pixelY + 10, {
          amount: xlmAmount,
        })
      }
      return
    }

    if (event.type === "agent.xp") {
      audioEngine.playEvent("level_up")
      pushLog(`XP update: +${event.xp}, level ${event.level}`, "success", event.agentId)
      const agent = agentsRef.current.find((candidate) => candidate.id === event.agentId)
      if (agent) {
        showAgentOverlay(agent, `+${event.xp} XP`, "#22d3ee")
        const previousLevel = agentLevelsRef.current.get(event.agentId) ?? event.level
        if (event.level > previousLevel) {
          toast.success("Agent leveled up", { description: `${agent.name} reached level ${event.level}` })
          spawnParticles("level-up", agent.pixelX + 8, agent.pixelY, {
            color: agent.color,
            level: event.level,
          })
        }
        agentLevelsRef.current.set(event.agentId, event.level)
      }
      return
    }

    if (event.type === "quest.completed") {
      const questTitle = event.quest?.title ?? event.questId ?? "Quest"
      const rewards = [
        typeof event.reward?.xp === "number" ? `+${event.reward.xp} XP` : null,
        event.reward?.xlm ? formatAssetAmount(event.reward.xlm) : null,
        event.reward?.badge ?? null,
        event.reward?.title ?? null,
      ].filter((reward): reward is string => Boolean(reward))
      const rewardDescription = rewards.length > 0 ? ` — ${rewards.join(" · ")}` : ""

      pushLog(`quest completed: ${questTitle}${rewardDescription}`, "success", event.agentId)
      toast.success("Quest completed", {
        description: `${questTitle}${rewardDescription}`,
      })
      return
    }

    if (event.type === "badge.unlocked") {
      audioEngine.playEvent("badge_unlock")
      pushLog(`badge unlocked: ${event.badge.name}`, "success", event.agentId)
      toast.success("Badge unlocked", { description: `${event.agentId}: ${event.badge.name}` })
      const agent = agentsRef.current.find((candidate) => candidate.id === event.agentId)
      if (agent) {
        showAgentOverlay(agent, event.badge.name, "#a78bfa")
        spawnParticles("badge-unlock", agent.pixelX + 8, agent.pixelY, {
          rarity: event.badge.rarity ?? "common",
        })
      }
      return
    }

    if (event.type === "district.unlocked") {
      audioEngine.playEvent("district_win")
      const districtId = "districtId" in event ? event.districtId : event.district?.id
      const district = DISTRICTS.find((candidate) => candidate.id === districtId)
      const districtName = ("district" in event && event.district?.name) || district?.name || districtId || "a district"
      pushLog(`district unlocked: ${districtName}`, "success", event.agentId ?? "system")
      toast.success("District unlocked", { description: String(districtName) })
      if (district) {
        spawnParticles("district-win", district.x + district.w / 2, district.y, {
          color: district.color,
          spreadW: district.w * 0.7,
        })
      }
      return
    }

    if (event.type === "task.started") {
      pushLog(`task started: ${event.task.title}`, "info", event.agentId)
      return
    }

    if (event.type === "agent.status") {
      if (event.status === "error") audioEngine.playEvent("agent_error")
      pushLog(`status changed: ${event.status}`, "info", event.agentId)
      return
    }

    if (event.type === "agent.registry") {
      pushLog(`registry ${event.action}: ${event.agent.agentId}`, "info", event.agentId)
      return
    }
  }, [animateAgentToDistrict, audioEngine, pushLog, showAgentOverlay, spawnParticles])

  useEffect(() => {
    const eventSource = new EventSource("/api/events")
    const eventTypes = [
      "agent.status",
      "task.started",
      "task.completed",
      "payment.received",
      "agent.xp",
      "quest.completed",
      "badge.unlocked",
      "district.unlocked",
      "agent.registry",
    ]

    const handleEvent = (message: MessageEvent) => {
      try {
        setHasRealtimeEvents(true)
        applySystemEvent(JSON.parse(String(message.data)) as PublishedSystemEvent)
      } catch {
        pushLog("received malformed real-time event", "warning")
      }
    }

    eventSource.onopen = () => {
      setEventStreamConnected(true)
      fallbackLoggedRef.current = false
      pushLog("real-time event stream connected", "success")
    }

    eventSource.onerror = () => {
      setEventStreamConnected(false)
      setHasRealtimeEvents(false)
      if (!fallbackLoggedRef.current) {
        pushLog("event stream unavailable; using local simulation fallback", "warning")
        fallbackLoggedRef.current = true
      }
      eventSource.close()
    }

    for (const eventType of eventTypes) {
      eventSource.addEventListener(eventType, handleEvent as EventListener)
    }

    return () => {
      for (const eventType of eventTypes) {
        eventSource.removeEventListener(eventType, handleEvent as EventListener)
      }
      eventSource.close()
    }
  }, [applySystemEvent, pushLog])

  useEffect(() => {
    const eventSource = new EventSource("/api/agents/stream")

    const applyPositions = (positions: AgentPositionPayload[]) => {
      if (positions.length === 0) return
      const positionsById = new Map(positions.map((position) => [position.agentId, position]))

      setAgents((prev) =>
        prev.map((agent) => {
          const position = positionsById.get(agent.id)
          if (!position) return agent

          return {
            ...agent,
            pixelX: position.pixelX,
            pixelY: position.pixelY,
            targetX: position.targetX,
            targetY: position.targetY,
            direction: position.direction,
          }
        }),
      )
    }

    const handleSnapshot = (message: MessageEvent) => {
      try {
        const payload = JSON.parse(String(message.data)) as AgentPositionSnapshotPayload
        applyPositions(payload.positions)
      } catch {
        pushLog("received malformed agent position snapshot", "warning")
      }
    }

    const handleDelta = (message: MessageEvent) => {
      try {
        const payload = JSON.parse(String(message.data)) as AgentPositionDeltaPayload
        applyPositions(payload.agents)
      } catch {
        pushLog("received malformed agent position delta", "warning")
      }
    }

    eventSource.onopen = () => {
      positionStreamErrorLoggedRef.current = false
    }

    eventSource.onerror = () => {
      if (!positionStreamErrorLoggedRef.current) {
        pushLog("agent position stream reconnecting", "warning")
        positionStreamErrorLoggedRef.current = true
      }
    }

    eventSource.addEventListener("agent.positions.snapshot", handleSnapshot as EventListener)
    eventSource.addEventListener("agent.position", handleDelta as EventListener)

    return () => {
      eventSource.removeEventListener("agent.positions.snapshot", handleSnapshot as EventListener)
      eventSource.removeEventListener("agent.position", handleDelta as EventListener)
      eventSource.close()
    }
  }, [pushLog])


  useEffect(() => {
    let stopped = false

    const syncCloudAgents = async () => {
      // Cloud agent provisioning is optional for the local simulation, and only admins have it.
      const result = await fetchCloudAgentsForAdmin()
      if (result.kind === "not-admin") {
        // Visitors have no admin session: stop polling so it does not burn the anonymous rate limit.
        window.clearInterval(interval)
        return
      }
      if (stopped || result.kind !== "agents" || result.agents.length === 0) return
      const cloudAgents = result.agents
      setAgents((prev) => {
        const existing = new Set(prev.map((agent) => agent.id))
        const nextCloudAgents = cloudAgents.filter((agent) => !existing.has(agent.id))
        return nextCloudAgents.length > 0 ? [...prev, ...nextCloudAgents] : prev
      })
    }

    // The first sync awaits its fetch before it can clear the interval, so `interval` is set by then.
    const interval = window.setInterval(syncCloudAgents, 15_000)
    void syncCloudAgents()
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let stopped = false

    const syncHealth = async () => {
      // The built-in bot-N roster is a front-end simulation, not an external
      // process. Only query agents that can report real runtime health.
      const snapshot = agentsRef.current.filter((agent) => !agent.id.startsWith("bot-"))
      if (snapshot.length === 0) return
      const settled = await Promise.allSettled(
        snapshot.map(async (agent) => {
          const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/health`, { cache: "no-store" })
          if (!res.ok) return null
          const data = await res.json()
          return data.health as AgentHealthApiSnapshot
        }),
      )

      if (stopped) return

      const healthById = new Map<string, AgentHealthApiSnapshot>()

      for (const item of settled) {
        if (item.status === "fulfilled" && item.value) {
          healthById.set(item.value.agentId, item.value)
        }
      }

      if (healthById.size === 0) return

      setAgents((prev) =>
        prev.map((agent) => {
          const health = healthById.get(agent.id)
          if (!health) return agent
          return {
            ...agent,
            status: health.status === "offline" ? "offline" : health.runtimeStatus,
            cpu: health.cpu ?? agent.cpu,
            memory: health.memory ?? agent.memory,
            currentTask: health.currentTask ?? agent.currentTask,
            lastHeartbeat: health.lastHeartbeat,
            offlineForSeconds: health.offlineForSeconds,
          }
        }),
      )
    }

    syncHealth()
    const healthId = window.setInterval(syncHealth, 30_000)

    return () => {
      stopped = true
      window.clearInterval(healthId)
    }
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTick((prev) => prev + 1)
    }, 1200)

    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (eventStreamConnected && hasRealtimeEvents) return

    const interval = window.setInterval(() => {
      setAgents((prev) =>
        prev.map((agent) => {
          if (agent.status === "offline") {
            return {
              ...agent,
              cpu: 0,
              memory: Math.max(0, agent.memory - 1),
              taskProgress: 0,
            }
          }

          const progressDelta = secureRandom() * 14
          const taskProgress = Math.min(100, agent.taskProgress + progressDelta)
          const finishedTask = taskProgress >= 100
          const gainedXp = finishedTask ? XP_AWARDS.TASK_COMPLETED + (progressDelta >= 12 ? XP_AWARDS.FAST_TASK_BONUS : 0) : 0
          const nextXp = (agent.xp ?? 0) + gainedXp
          const levelState = finishedTask ? checkLevelUp(nextXp, agent.level ?? 1) : null
          const skillId = agent.skills[0]?.id

          let status: MoltbotAgent["status"] = "working"
          if (finishedTask) {
            status = "active"
          } else if (secureRandom() < 0.04) {
            status = "idle"
          }

          return {
            ...agent,
            xp: finishedTask ? nextXp : agent.xp,
            level: levelState?.level ?? agent.level ?? 1,
            xpToNext: levelState?.xpToNext ?? agent.xpToNext ?? getXpToNextLevel(agent.level ?? 1),
            skills: finishedTask ? awardSkillXP(agent.skills, skillId, XP_AWARDS.TASK_COMPLETED) : agent.skills,
            cpu: Math.max(10, Math.min(98, agent.cpu + (secureRandom() - 0.5) * 10)),
            memory: Math.max(20, Math.min(95, agent.memory + (secureRandom() - 0.5) * 6)),
            status,
            taskProgress: finishedTask ? 0 : taskProgress,
            tasksCompleted: finishedTask ? agent.tasksCompleted + 1 : agent.tasksCompleted,
            currentTask: finishedTask ? getRandomTask(agent.district) : agent.currentTask,
          }
        })
      )
    }, 1200)

    return () => window.clearInterval(interval)
  }, [eventStreamConnected, hasRealtimeEvents])

  useEffect(() => {
    const chatInterval = window.setInterval(() => {
      setChatMessages((prev) => {
        const next = generateChatMessage(agentsRef.current)
        if (!next) return prev

        if (secureRandom() < 0.5) {
          pushLog(`relay ${next.fromName} -> ${next.toName}: ${next.message}`, "info", next.fromName)
        }

        return [...prev.slice(-79), next]
      })
    }, 2200)

    return () => window.clearInterval(chatInterval)
  }, [pushLog])

  // Prune finished tx animations
  useEffect(() => {
    if (txAnimations.length === 0) return
    const id = window.setInterval(() => {
      const now = Date.now()
      setTxAnimations(prev => prev.filter(a => now - a.startedAt < a.duration))
    }, 500)
    return () => window.clearInterval(id)
  }, [txAnimations.length])

  useEffect(() => {
    if (floatingOverlays.length === 0) return
    const id = window.setInterval(() => {
      const now = Date.now()
      setFloatingOverlays(prev => prev.filter(overlay => now - overlay.startedAt < overlay.duration))
    }, 500)
    return () => window.clearInterval(id)
  }, [floatingOverlays.length])

  // Particle triggers are one-shot — PixelCity consumes them into its ParticleSystem on
  // receipt, so this just garbage-collects the request objects shortly after.
  useEffect(() => {
    if (particleTriggers.length === 0) return
    const id = window.setTimeout(() => {
      setParticleTriggers([])
    }, 500)
    return () => window.clearTimeout(id)
  }, [particleTriggers])

  const handleSelectAgent = useCallback((id: string | null) => {
    setSelectedAgentId(id)

    const picked = agentsRef.current.find((agent) => agent.id === id)
    if (picked) {
      pushLog(`agent selected: ${picked.name} (${picked.model})`, "info", picked.name)
    }
  }, [pushLog])

  const handleUpdateAgentWallet = useCallback((agentId: string, wallet: MoltbotAgent["wallet"]) => {
    setAgents((prev) => {
      const updated = prev.map((agent) => (agent.id === agentId ? { ...agent, wallet } : agent))
      const updatedAgent = updated.find((agent) => agent.id === agentId)
      if (updatedAgent && wallet?.publicKey) {
        pushLog(`wallet linked: ${updatedAgent.name} -> ${wallet.publicKey.slice(0, 8)}...`, "success", updatedAgent.name)
      }
      return updated
    })
  }, [pushLog])

  const handleUpgradeSkill = useCallback((agentId: string, skillId: string) => {
    const currentAgent = agentsRef.current.find((agent) => agent.id === agentId)
    if (!currentAgent) {
      pushLog("skill upgrade blocked: agent not found", "warning", agentId)
      return
    }

    const preview = upgradeAgentSkill(currentAgent, skillId)
    if (!preview.result) {
      pushLog("skill upgrade blocked: skill not found", "warning", currentAgent.name)
      return
    }

    if (!preview.result.upgraded) {
      const blockedReason = preview.result.reason === "max-level" ? "already at max level" : "not enough XP"
      pushLog(`skill upgrade blocked: ${blockedReason}`, "warning", currentAgent.name)
      toast.error("Skill Upgrade Blocked", { description: `${currentAgent.name}: ${blockedReason}` })
      return
    }

    setAgents((prev) =>
      prev.map((agent) => (agent.id === agentId ? upgradeAgentSkill(agent, skillId).agent : agent)),
    )

    pushLog(`${preview.result.skill.name} upgraded to level ${preview.result.skill.level}`, "success", preview.agent.name)
    toast.success("Skill Upgraded!", { description: `${preview.agent.name} upgraded ${preview.result.skill.name} to Level ${preview.result.skill.level}` })
    showAgentOverlay(preview.agent, `${preview.result.skill.name} Lv.${preview.result.skill.level}`, preview.agent.color)
  }, [pushLog, showAgentOverlay])

  const handleUpdateAgentAppearance = useCallback((agentId: string, appearance: AgentAppearance) => {
    setAgents((prev) =>
      prev.map((agent) =>
        agent.id === agentId
          ? { ...agent, appearance, color: appearance.customColor || agent.color }
          : agent,
      ),
    )
  }, [])

  const handleAddTransaction = useCallback((tx: WalletTransaction) => {
    setTransactions((prev) => [tx, ...prev.slice(0, 99)])
    pushLog(`tx ${tx.fromName} -> ${tx.toName} (${tx.amount} XLM)`, "success", tx.fromName)

    // Spawn a tx animation between the two agents
    const current = agentsRef.current
    const fromAgent = current.find(a => a.name === tx.fromName)
    const toAgent = current.find(a => a.name === tx.toName)
    if (fromAgent && toAgent) {
      setTxAnimations(prev => [
        ...prev,
        {
          id: tx.id,
          fromX: fromAgent.pixelX + 8,
          fromY: fromAgent.pixelY + 10,
          toX: toAgent.pixelX + 8,
          toY: toAgent.pixelY + 10,
          startedAt: Date.now(),
          duration: 1800,
        },
      ])
    }
  }, [pushLog])

  const handleMobileTabSelect = useCallback((tab: SidebarTabId) => {
    setSidebarTab(tab)
    setMobileControlsOpen(true)
  }, [])

  const errorCount = agents.filter((agent) => agent.status === "error").length
  const walletAlert = agents.some((agent) => !agent.wallet || (agent.wallet.funded && parseFloat(agent.wallet.balance) < 10))
  const openOfferCount = MOCK_OFFERS.filter((offer) => offer.status === "open").length

  return (
    <div style={{
      width: "100%",
      height: "100dvh",
      boxSizing: "border-box",
      display: "flex",
      overflow: "hidden",
      background: "#030712",
      position: "relative",
      paddingBottom: isMobile ? "calc(132px + env(safe-area-inset-bottom))" : 0,
    }}>
      {showOnboarding && <OnboardingModal onDone={handleDoneOnboarding} />}

      {/* Canvas area */}
      <div ref={canvasAreaRef} style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
        {/* Top-right group: the admin link and the theme toggle share one row so neither covers
            the other. On a phone the admin link lives in the bottom nav, so only the toggle shows. */}
        <div style={{ position: "absolute", top: 14, right: 14, zIndex: 12, display: "flex", alignItems: "center", gap: 8 }}>
          {isMobile === false && (
            <a
              href="/explorer"
              aria-label="Recibos en cadena: pagos x402, contrataciones y 8004 en Solana devnet"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 11px",
                border: "1px solid #5eead488",
                borderRadius: 6,
                background: "rgba(3,7,18,0.88)",
                color: "#5eead4",
                fontFamily: "monospace",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1,
                textDecoration: "none",
                textTransform: "uppercase",
                boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
              }}
            >
              <ScrollText size={14} aria-hidden="true" />
              Recibos
            </a>
          )}
          {isMobile === false && (
            <a
              href="/admin"
              aria-label="Open Agentic City admin console"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 11px",
                border: "1px solid #22d3ee88",
                borderRadius: 6,
                background: "rgba(3,7,18,0.88)",
                color: "#67e8f9",
                fontFamily: "monospace",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1,
                textDecoration: "none",
                textTransform: "uppercase",
                boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
              }}
            >
              <Bot size={14} aria-hidden="true" />
              Arena Admin
            </a>
          )}
          <ThemeToggleNavbar />
        </div>
        <PixelCity
          agents={agents}
          districts={DISTRICTS}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
          tick={tick}
          txAnimations={txAnimations}
          colorBlindMode={colorBlindMode}
          reduceMotion={reduceMotion}
          floatingOverlays={floatingOverlays}
          particleTriggers={particleTriggers}
          audioEngine={audioEngine}
          districtStandings={districtStandings}
        />

        <DistrictEventOverlay event={activeDistrictEvent} standings={districtStandings} top={challengeTop} />

        <AudioControls
          engine={audioEngine}
          bottomOffset={isMobile ? "calc(148px + env(safe-area-inset-bottom))" : 16}
        />

        {isMobile === false && (
          <button
            onClick={() => setSidebarOpen(o => !o)}
            style={{
              position: "absolute",
              top: "50%",
              right: 0,
              transform: "translateY(-50%)",
              zIndex: 5,
              background: "#111827",
              border: "1px solid #2a3a52",
              borderRight: "none",
              borderRadius: "6px 0 0 6px",
              color: "#22d3ee",
              fontFamily: "monospace",
              fontSize: 14,
              padding: "10px 6px",
              cursor: "pointer",
              lineHeight: 1,
              transition: "background 0.15s",
            }}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? "›" : "‹"}
          </button>
        )}

        {isMobile === false && (
          <footer style={{
            position: "absolute",
            left: 12,
            bottom: 10,
            zIndex: 4,
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            padding: "7px 9px",
            background: "rgba(3,7,18,0.78)",
            border: "1px solid rgba(42,58,82,0.86)",
            borderRadius: 6,
            backdropFilter: "blur(6px)",
          }}>
            {LEGAL_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                style={{
                  color: "#94a3b8",
                  fontFamily: "monospace",
                  fontSize: 10,
                  textDecoration: "none",
                }}
              >
                {link.label}
              </a>
            ))}
          </footer>
        )}
      </div>

      {isMobile === false && sidebarOpen && (
        <SidebarPanel
          agents={agents}
          selectedAgent={selectedAgent}
          logs={logs}
          chatMessages={chatMessages}
          transactions={transactions}
          onSelectAgent={handleSelectAgent}
          onUpdateAgent={handleUpdateAgentWallet}
          onAddTransaction={handleAddTransaction}
          onUpgradeSkill={handleUpgradeSkill}
          onUpdateAgentAppearance={handleUpdateAgentAppearance}
          colorBlindMode={colorBlindMode}
          onColorBlindModeChange={handleColorBlindModeChange}
          activeTab={sidebarTab}
          onActiveTabChange={setSidebarTab}
        />
      )}

      {isMobile && (
        <>
          <button
            type="button"
            onClick={() => setMobileControlsOpen(true)}
            aria-label="Open agent controls"
            style={{
              position: "fixed",
              // Above the nav grid, not on it: at 144px it covered the Skills tab on a 390px phone.
              // Left side, because the audio controls sit on the right at that height.
              left: 16,
              bottom: `calc(${MOBILE_NAV_HEIGHT + 12}px + env(safe-area-inset-bottom))`,
              zIndex: 30,
              width: 48,
              height: 48,
              borderRadius: 24,
              border: "1px solid #22d3ee66",
              background: "#111827",
              color: "#22d3ee",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
              cursor: "pointer",
            }}
          >
            <PanelBottomOpen size={22} aria-hidden="true" />
          </button>

          <nav
            aria-label="Agent controls"
            style={{
              position: "fixed",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 25,
              boxSizing: "border-box",
              minHeight: "calc(132px + env(safe-area-inset-bottom))",
              padding: "8px 10px calc(10px + env(safe-area-inset-bottom))",
              background: "rgba(15,23,42,0.94)",
              borderTop: "1px solid #2a3a52",
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gridAutoFlow: "row",
              gap: 6,
              overflowX: "hidden",
              overflowY: "hidden",
              backdropFilter: "blur(12px)",
            }}
          >
            {SIDEBAR_TABS.map((tab) => {
              const Icon = MOBILE_NAV_ICONS[tab.id]
              const active = sidebarTab === tab.id
              const hasBadge =
                (tab.id === "chat" && chatMessages.length > 0) ||
                (tab.id === "overview" && errorCount > 0) ||
                (tab.id === "offers" && openOfferCount > 0) ||
                (tab.id === "wallet" && walletAlert)

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleMobileTabSelect(tab.id)}
                  aria-pressed={active}
                  aria-label={tab.label}
                  style={{
                    position: "relative",
                    minWidth: 0,
                    minHeight: 56,
                    padding: "4px 3px",
                    border: active ? "1px solid #22d3ee66" : "1px solid transparent",
                    borderRadius: 8,
                    background: active ? "#111827" : "transparent",
                    color: active ? "#22d3ee" : "#94a3b8",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    cursor: "pointer",
                    fontFamily: "monospace",
                    fontSize: 8,
                    fontWeight: active ? 700 : 400,
                    textTransform: "uppercase",
                  }}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.1 }}>
                    {tab.label}
                  </span>
                  {hasBadge && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: 7,
                        right: "22%",
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: tab.id === "wallet" ? "#fbbf24" : tab.id === "overview" ? "#f87171" : "#34d399",
                      }}
                    />
                  )}
                </button>
              )
            })}
            <a
              href="/admin"
              aria-label="Open Agentic City admin console"
              style={{
                minHeight: 54,
                padding: "4px 3px",
                border: "1px solid transparent",
                borderRadius: 8,
                color: "#22d3ee",
                textDecoration: "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                fontFamily: "monospace",
                fontSize: 8,
                textTransform: "uppercase",
              }}
            >
              <Bot size={18} aria-hidden="true" />
              <span style={{ lineHeight: 1.1 }}>Admin</span>
            </a>
          </nav>

          <Drawer open={mobileControlsOpen} onOpenChange={setMobileControlsOpen}>
            <DrawerContent
              aria-describedby={undefined}
              style={{
                // Starts below the top overlays (city card and map controls end near 160px), so the
                // open sheet does not cut them in half on a 390px phone.
                height: "min(84dvh, calc(100dvh - 168px), 720px)",
                maxWidth: "100vw",
                boxSizing: "border-box",
                background: "#111827",
                borderColor: "#2a3a52",
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
                overflow: "hidden",
              }}
            >
              <DrawerTitle className="sr-only">Agent controls</DrawerTitle>
              {/* The panel fills what the drag handle leaves: at height 100% it ran past the drawer's
                  bottom and clipped the chat composer and its send button on a 390px phone. */}
              <div style={{ flex: 1, minHeight: 0 }}>
              <SidebarPanel
                agents={agents}
                selectedAgent={selectedAgent}
                logs={logs}
                chatMessages={chatMessages}
                transactions={transactions}
                onSelectAgent={handleSelectAgent}
                onUpdateAgent={handleUpdateAgentWallet}
                onAddTransaction={handleAddTransaction}
                onUpgradeSkill={handleUpgradeSkill}
                onUpdateAgentAppearance={handleUpdateAgentAppearance}
                colorBlindMode={colorBlindMode}
                onColorBlindModeChange={handleColorBlindModeChange}
                activeTab={sidebarTab}
                onActiveTabChange={setSidebarTab}
                variant="mobile"
                showTabBar={false}
              />
              </div>
            </DrawerContent>
          </Drawer>
        </>
      )}
    </div>
  )
}
