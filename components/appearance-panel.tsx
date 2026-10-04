"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AccessoryId, AgentAppearance, MoltbotAgent, SkinId } from "@/lib/types"
import {
  ACCESSORIES,
  BADGES,
  COLOR_CHANGE_COST_XLM,
  SKINS,
  getAgentLevel,
  getUnlockedAccessoryIds,
  getUnlockedBadgeIds,
  getUnlockedSkinIds,
} from "@/lib/cosmetics"
import { drawBot } from "@/lib/renderer"
import { SPRITE_CONFIGS } from "@/components/pixel-city"
import { getDistrictRobot, getRobotFrameIndex, shouldAnimateRobot } from "@/lib/robot-sprites"
import { STELLAR_ENABLED } from "@/lib/config/chains"

const HEX_RE = /^#[0-9a-fA-F]{6}$/

interface AppearancePanelProps {
  agents: MoltbotAgent[]
  selectedAgent: MoltbotAgent | null
  onUpdateAgentAppearance: (agentId: string, appearance: AgentAppearance) => void
}

async function getFreighter() {
  try {
    return await import("@stellar/freighter-api")
  } catch {
    return null
  }
}

function PreviewCanvas({ agent }: { agent: MoltbotAgent }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [sprite, setSprite] = useState<HTMLImageElement | null>(null)
  const [robotSheet, setRobotSheet] = useState<HTMLImageElement | null>(null)
  const tickRef = useRef(0)
  const cfg = SPRITE_CONFIGS[agent.spriteId % SPRITE_CONFIGS.length]
  const robotSet = getDistrictRobot(agent.district)

  useEffect(() => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => setSprite(img)
    img.src = cfg.path
  }, [cfg.path])

  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setRobotSheet(img)
    }
    img.src = robotSet.sheet
    return () => {
      cancelled = true
    }
  }, [robotSet.sheet])

  useEffect(() => {
    let raf = 0
    const render = (now: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = "#0a0e17"
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        tickRef.current += 1
        const previewAgent: MoltbotAgent = { ...agent, pixelX: 50, pixelY: 22, direction: "right" }
        // Only use the loaded strip if it belongs to this agent's district robot.
        const robot = robotSheet && robotSheet.src.endsWith(robotSet.sheet)
          ? {
              image: robotSheet,
              set: robotSet,
              frame: getRobotFrameIndex(now, robotSet.frames, robotSet.frameMs, shouldAnimateRobot(agent.status, false)),
            }
          : undefined
        drawBot(ctx, previewAgent, tickRef.current, false, sprite ?? undefined, cfg.crop, false, robot)
      }
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [agent, sprite, cfg.crop, robotSheet, robotSet])

  return (
    <canvas
      ref={canvasRef}
      width={100}
      height={90}
      style={{ background: "#0a0e17", borderRadius: 6, border: "1px solid #1e293b", flexShrink: 0 }}
    />
  )
}

export function AppearancePanel({ agents, selectedAgent, onUpdateAgentAppearance }: AppearancePanelProps) {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [colorInput, setColorInput] = useState(selectedAgent?.color ?? "#22d3ee")
  const [treasuryAddress, setTreasuryAddress] = useState<string | null>(null)

  useEffect(() => {
    setColorInput(selectedAgent?.color ?? "#22d3ee")
    setError(null)
  }, [selectedAgent?.id, selectedAgent?.color])

  // Pull persisted equip state from the server -- local agent state resets to
  // cosmetic defaults whenever the page reloads (agents are regenerated client-side).
  useEffect(() => {
    if (!selectedAgent) return
    let cancelled = false
    fetch(`/api/agents/${encodeURIComponent(selectedAgent.id)}/appearance`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok) return
        setTreasuryAddress(data.treasuryAddress ?? null)
        const persisted = data.appearance as AgentAppearance
        const current = selectedAgent.appearance
        const same =
          persisted.skin === current.skin &&
          persisted.customColor === current.customColor &&
          persisted.accessories.length === current.accessories.length &&
          persisted.accessories.every((a) => current.accessories.includes(a))
        if (!same) onUpdateAgentAppearance(selectedAgent.id, persisted)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // Only re-sync when the selected agent changes, not on every local appearance mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent?.id])

  const handleEquipSkin = useCallback(
    async (skinId: SkinId, level: number, agentId: string) => {
      setLoading(`skin-${skinId}`)
      setError(null)
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/appearance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "equip-skin", skinId, level }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "Could not equip skin")
        onUpdateAgentAppearance(agentId, data.appearance)
        toast.success(`Equipped ${SKINS.find((s) => s.id === skinId)?.name} skin`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not equip skin"
        setError(msg)
        toast.error("Equip failed", { description: msg })
      }
      setLoading(null)
    },
    [onUpdateAgentAppearance],
  )

  const handleToggleAccessory = useCallback(
    async (accessoryId: AccessoryId, agent: MoltbotAgent, badgeIds: string[]) => {
      const current = agent.appearance.accessories
      const next = current.includes(accessoryId) ? current.filter((a) => a !== accessoryId) : [...current, accessoryId]
      setLoading(`accessory-${accessoryId}`)
      setError(null)
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/appearance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "equip-accessories", accessoryIds: next, badgeIds }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "Could not update accessories")
        onUpdateAgentAppearance(agent.id, data.appearance)
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not update accessories"
        setError(msg)
        toast.error("Update failed", { description: msg })
      }
      setLoading(null)
    },
    [onUpdateAgentAppearance],
  )

  const handleBuyColor = useCallback(
    async (agent: MoltbotAgent) => {
      if (!HEX_RE.test(colorInput)) {
        setError("Enter a valid 6-digit hex color (e.g. #22d3ee)")
        return
      }
      if (!treasuryAddress) {
        setError("Color purchases are disabled -- treasury address not configured")
        return
      }
      if (!agent.wallet?.funded) {
        setError("Agent needs a funded Stellar wallet to pay for color changes -- assign one in the Wallet tab")
        return
      }
      setLoading("color")
      setError(null)
      try {
        const buildRes = await fetch("/api/stellar/build-tx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourcePublic: agent.wallet.publicKey,
            destination: treasuryAddress,
            amount: COLOR_CHANGE_COST_XLM,
          }),
        })
        const buildData = await buildRes.json()
        if (buildData.error) throw new Error(buildData.error)

        const freighter = await getFreighter()
        if (!freighter) throw new Error("Freighter wallet not available")

        const signResult: any = await freighter.signTransaction(buildData.xdr, {
          networkPassphrase: "Test SDF Network ; September 2015",
        })
        const signedXdr =
          typeof signResult === "string"
            ? signResult
            : signResult && typeof signResult === "object" && "signedTxXdr" in signResult
              ? (signResult.signedTxXdr as string)
              : null
        if (!signedXdr) throw new Error("Freighter did not return signed XDR")

        const submitRes = await fetch("/api/stellar/submit-tx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedXdr }),
        })
        const submitData = await submitRes.json()
        if (submitData.error) throw new Error(submitData.error)

        const appearanceRes = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/appearance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-color", color: colorInput, txHash: submitData.hash }),
        })
        const appearanceData = await appearanceRes.json()
        if (!appearanceData.ok) throw new Error(appearanceData.error || "Could not save new color")

        onUpdateAgentAppearance(agent.id, appearanceData.appearance)
        toast.success(`Agent color updated for ${COLOR_CHANGE_COST_XLM} XLM`, {
          description: submitData.hash ? `tx: ${submitData.hash.slice(0, 18)}…` : undefined,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Color purchase failed"
        setError(msg)
        toast.error("Purchase failed", { description: msg })
      }
      setLoading(null)
    },
    [colorInput, treasuryAddress, onUpdateAgentAppearance],
  )

  if (!selectedAgent) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 8,
          padding: 16,
          opacity: 0.6,
        }}
      >
        <div style={{ fontSize: 24, opacity: 0.4 }}>{"←"}</div>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b", textAlign: "center", lineHeight: 1.5 }}>
          Click an agent on the map to customize its appearance
        </span>
      </div>
    )
  }

  const agent = selectedAgent
  const level = getAgentLevel(agent)
  const badgeIds = getUnlockedBadgeIds(agent, agents)
  const unlockedSkins = new Set(getUnlockedSkinIds(agent))
  const unlockedAccessories = new Set(getUnlockedAccessoryIds(agent, agents))

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", height: "100%" }}>
      {/* Header + live preview */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", paddingBottom: 10, borderBottom: "1px solid #1e293b" }}>
        <PreviewCanvas agent={agent} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: agent.color }}>{agent.name}</div>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", marginTop: 2 }}>Level {level}</div>
          <div style={{ fontFamily: "monospace", fontSize: 9, color: "#475569", marginTop: 2 }}>
            {badgeIds.length} / {BADGES.length} badges earned
          </div>
        </div>
      </div>

      {/* Skins */}
      <div>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
          Skins
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {SKINS.map((skin) => {
            const unlocked = unlockedSkins.has(skin.id)
            const equipped = agent.appearance.skin === skin.id
            return (
              <button
                key={skin.id}
                disabled={!unlocked || equipped || loading !== null}
                onClick={() => handleEquipSkin(skin.id, level, agent.id)}
                title={unlocked ? skin.description : `Requires level ${skin.levelRequired}`}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: `1px solid ${equipped ? "#22d3ee" : "#1e293b"}`,
                  background: equipped ? "#22d3ee1a" : unlocked ? "#0f172a" : "#0a0e17",
                  cursor: unlocked && !equipped ? "pointer" : "default",
                  opacity: unlocked ? 1 : 0.5,
                  filter: unlocked ? "none" : "grayscale(1)",
                }}
              >
                <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: unlocked ? "#e2e8f0" : "#475569" }}>
                  {skin.name}
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#64748b", marginTop: 2 }}>
                  {unlocked ? (equipped ? "Equipped" : "Tap to equip") : `Lv. ${skin.levelRequired} required`}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Accessories */}
      <div>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
          Accessories
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {ACCESSORIES.map((accessory) => {
            const unlocked = unlockedAccessories.has(accessory.id)
            const equipped = agent.appearance.accessories.includes(accessory.id)
            const badge = BADGES.find((b) => b.id === accessory.badgeId)
            return (
              <button
                key={accessory.id}
                disabled={!unlocked || loading !== null}
                onClick={() => handleToggleAccessory(accessory.id, agent, badgeIds)}
                title={unlocked ? accessory.name : `Requires badge: ${badge?.name}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: `1px solid ${equipped ? "#34d399" : "#1e293b"}`,
                  background: equipped ? "#34d3991a" : unlocked ? "#0f172a" : "#0a0e17",
                  cursor: unlocked ? "pointer" : "default",
                  opacity: unlocked ? 1 : 0.5,
                  filter: unlocked ? "none" : "grayscale(1)",
                }}
              >
                <span style={{ fontSize: 14 }}>{unlocked ? accessory.emoji : "🔒"}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "monospace", fontSize: 10, fontWeight: 700, color: unlocked ? "#e2e8f0" : "#475569" }}>
                    {accessory.name}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 8, color: "#64748b" }}>
                    {unlocked ? (equipped ? "Equipped" : "Tap to equip") : badge?.name}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Color customization: paid in XLM via Freighter, so only shown when Stellar is enabled. */}
      {STELLAR_ENABLED && <div>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
          Agent Color
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="color"
            value={HEX_RE.test(colorInput) ? colorInput : "#22d3ee"}
            onChange={(e) => setColorInput(e.target.value)}
            aria-label="Pick agent color"
            style={{ width: 36, height: 36, padding: 0, border: "1px solid #1e293b", borderRadius: 4, cursor: "pointer", background: "none" }}
          />
          <input
            type="text"
            value={colorInput}
            onChange={(e) => setColorInput(e.target.value)}
            placeholder="#22d3ee"
            aria-label="Agent color hex value"
            style={{
              flex: 1,
              background: "#111827",
              border: "1px solid #1e293b",
              borderRadius: 4,
              padding: "6px 8px",
              fontFamily: "monospace",
              fontSize: 11,
              color: "#e2e8f0",
              outline: "none",
            }}
          />
        </div>
        <button
          onClick={() => handleBuyColor(agent)}
          disabled={loading !== null || colorInput.toLowerCase() === agent.color.toLowerCase()}
          style={{
            marginTop: 8,
            width: "100%",
            padding: "8px 10px",
            background: loading === "color" ? "#1e293b" : "#fbbf2422",
            border: "1px solid #fbbf2444",
            borderRadius: 4,
            color: "#fbbf24",
            fontFamily: "monospace",
            fontSize: 10,
            fontWeight: 700,
            cursor: loading !== null ? "not-allowed" : "pointer",
          }}
        >
          {loading === "color" ? "Processing payment..." : `Set Color — ${COLOR_CHANGE_COST_XLM} XLM`}
        </button>
        <div style={{ fontFamily: "monospace", fontSize: 8, color: "#475569", marginTop: 4 }}>
          Paid to the protocol treasury via Freighter, Stellar Testnet
        </div>
      </div>}

      {error && (
        <div
          style={{
            fontFamily: "monospace",
            fontSize: 10,
            color: "#f87171",
            padding: "6px 10px",
            background: "#f8717111",
            borderRadius: 4,
            border: "1px solid #f8717122",
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
