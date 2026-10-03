"use client"

import { useRef, useEffect, useCallback, useState, useMemo } from "react"
import NextImage from "next/image"
import { LocateFixed, Map as MapIcon, Minus, Plus } from "lucide-react"
import type { MoltbotAgent, District } from "@/lib/types"
import { drawGrid, drawRoads, drawDistrict, drawBot } from "@/lib/renderer"
import type { DistrictStanding } from "@/lib/gamification/events"
import { ParticleSystem, type ParticleEvent, type ParticleOpts } from "@/lib/renderer/particles"
import type { CityAudioEngine } from "@/lib/audio/city-audio"
import {
  ROBOT_FRAME_MS,
  ROBOT_SPRITE_SETS,
  getDistrictRobot,
  getRobotFrameIndex,
  robotPhaseFor,
  shouldAnimateRobot,
} from "@/lib/robot-sprites"

const BG_IMAGES: Record<string, string> = {
  "data-center": "/bg-data-center.jpg",
  "comm-hub": "/bg-comm-hub.jpg",
  processing: "/bg-processing.jpg",
  defense: "/bg-defense.jpg",
  research: "/bg-research.jpg",
}

export interface SpriteConfig {
  path: string
  crop?: [number, number, number, number]
}

export interface FloatingOverlay {
  id: number
  x: number
  y: number
  text: string
  color: string
  startedAt: number
  duration: number
}

// Legacy tinted sprite set. The map now draws the per-district robots from
// lib/robot-sprites.ts; these stay as the fallback while (or if) a sheet fails to load.
export const SPRITE_CONFIGS: SpriteConfig[] = [
  { path: "/sprites/robot-tv.gif" },
  { path: "/sprites/robot-tank.gif" },
  { path: "/sprites/robot-blue.gif", crop: [0.3, 0.5, 0.4, 0.5] },
  { path: "/sprites/robot-gold.gif" },
  { path: "/sprites/robot-runner.gif", crop: [0.5, 0, 0.5, 1] },
  { path: "/sprites/robot-heavy.webp" },
  { path: "/sprites/robot-green.gif" },
]

export interface TxAnimation {
  id: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  startedAt: number
  duration: number
}

export interface ParticleTrigger {
  id: number
  type: ParticleEvent
  x: number
  y: number
  opts?: ParticleOpts
}

interface CityBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  districts: District[],
  agents: MoltbotAgent[],
  zoom: number,
  panOffset: { x: number; y: number },
  cityBounds: CityBounds,
  scale: number,
  colorBlindMode = false
) {
  const mapW = 160
  const mapH = 100
  const mapX = w - mapW - 20
  const mapY = 60

  ctx.save()
  // Background
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)"
  ctx.strokeStyle = "rgba(34, 211, 238, 0.5)"
  ctx.lineWidth = 1
  ctx.beginPath()
  if ((ctx as any).roundRect) {
    (ctx as any).roundRect(mapX, mapY, mapW, mapH, 8)
  } else {
    ctx.rect(mapX, mapY, mapW, mapH)
  }
  ctx.fill()
  ctx.stroke()

  const { minX, minY } = cityBounds

  ctx.translate(mapX + 10, mapY + 10)
  ctx.scale(scale, scale)
  ctx.translate(-minX + 100, -minY + 100)

  // Draw districts
  districts.forEach(d => {
    ctx.fillStyle = d.bgColor + (colorBlindMode ? "dd" : "aa")
    ctx.fillRect(d.x, d.y, d.w, d.h)
    ctx.strokeStyle = d.color
    ctx.lineWidth = 1 / scale
    ctx.strokeRect(d.x, d.y, d.w, d.h)
  })

  // Draw agents
  agents.forEach(a => {
    ctx.fillStyle = a.color
    ctx.beginPath()
    ctx.arc(a.pixelX + 8, a.pixelY + 10, 12 / (scale * 20), 0, Math.PI * 2)
    ctx.fill()
  })

  // Draw viewport rect
  const viewX = -panOffset.x / zoom
  const viewY = -panOffset.y / zoom
  const viewW = w / zoom
  const viewH = h / zoom
  ctx.strokeStyle = "#fff"
  ctx.lineWidth = 1 / scale
  ctx.strokeRect(viewX, viewY, viewW, viewH)

  ctx.restore()
}

interface PixelCityProps {
  agents: MoltbotAgent[]
  districts: District[]
  selectedAgentId: string | null
  onSelectAgent: (id: string | null) => void
  tick: number
  txAnimations?: TxAnimation[]
  colorBlindMode?: boolean
  reduceMotion?: boolean
  floatingOverlays?: FloatingOverlay[]
  particleTriggers?: ParticleTrigger[]
  audioEngine?: CityAudioEngine
  districtStandings?: DistrictStanding[]
}

const statusSymbols: Record<string, string> = {
  active: "●",
  working: "◆",
  idle: "○",
  error: "✕",
  offline: "—",
}

interface ScreenPoint {
  x: number
  y: number
}

const MIN_ZOOM = 0.55
const MAX_ZOOM = 4

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function distance(a: ScreenPoint, b: ScreenPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function PixelCity({
  agents,
  districts,
  selectedAgentId,
  onSelectAgent,
  tick,
  txAnimations = [],
  colorBlindMode = false,
  reduceMotion = false,
  floatingOverlays = [],
  particleTriggers = [],
  audioEngine,
  districtStandings = [],
}: PixelCityProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particleCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const particleSystemRef = useRef<ParticleSystem>(new ParticleSystem())
  const processedParticleIdsRef = useRef<Set<number>>(new Set())
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({})
  const [sprites, setSprites] = useState<HTMLImageElement[]>([])
  const spriteCrops = useRef<(([number, number, number, number]) | undefined)[]>([])
  const [robotSheets, setRobotSheets] = useState<Record<string, HTMLImageElement>>({})
  const [robotClock, setRobotClock] = useState(0)
  const [hoveredAgent, setHoveredAgent] = useState<MoltbotAgent | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [showMinimap, setShowMinimap] = useState(false)
  const [mounted, setMounted] = useState(false)
  const zoomRef = useRef(zoom)
  const panOffsetRef = useRef(panOffset)
  const pointersRef = useRef(new Map<number, ScreenPoint>())
  const touchStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pinchRef = useRef<{
    startDistance: number
    worldMidpoint: ScreenPoint
  } | null>(null)
  const suppressClickRef = useRef(false)
  const initializedViewRef = useRef(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    panOffsetRef.current = panOffset
  }, [panOffset])

  const cityBounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    districts.forEach(d => {
      minX = Math.min(minX, d.x)
      minY = Math.min(minY, d.y)
      maxX = Math.max(maxX, d.x + d.w)
      maxY = Math.max(maxY, d.y + d.h)
    })
    // Fallback if no districts
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 1000; maxY = 1000 }
    return { minX, minY, maxX, maxY }
  }, [districts])

  const minimapScale = useMemo(() => {
    const mapW = 160
    const mapH = 100
    const { minX, minY, maxX, maxY } = cityBounds
    const cityW = maxX - minX + 200
    const cityH = maxY - minY + 200
    return Math.min((mapW - 20) / cityW, (mapH - 20) / cityH)
  }, [cityBounds])

  const clampPan = useCallback(
    (nextPan: { x: number; y: number }, nextZoom: number, width: number, height: number) => {
      const margin = 36
      const cityW = cityBounds.maxX - cityBounds.minX
      const cityH = cityBounds.maxY - cityBounds.minY
      let x = nextPan.x
      let y = nextPan.y

      if (cityW * nextZoom <= width - margin * 2) {
        x = width / 2 - (cityBounds.minX + cityW / 2) * nextZoom
      } else {
        x = clamp(x, width - margin - cityBounds.maxX * nextZoom, margin - cityBounds.minX * nextZoom)
      }

      if (cityH * nextZoom <= height - margin * 2) {
        y = height / 2 - (cityBounds.minY + cityH / 2) * nextZoom
      } else {
        y = clamp(y, height - margin - cityBounds.maxY * nextZoom, margin - cityBounds.minY * nextZoom)
      }

      return { x, y }
    },
    [cityBounds],
  )

  const fitViewToContainer = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const cityW = cityBounds.maxX - cityBounds.minX
    const cityH = cityBounds.maxY - cityBounds.minY
    const nextZoom = clamp(Math.min((rect.width - 32) / cityW, (rect.height - 96) / cityH, 1), MIN_ZOOM, 1)
    const nextPan = clampPan(
      {
        x: rect.width / 2 - (cityBounds.minX + cityW / 2) * nextZoom,
        y: rect.height / 2 - (cityBounds.minY + cityH / 2) * nextZoom,
      },
      nextZoom,
      rect.width,
      rect.height,
    )
    setZoom(nextZoom)
    setPanOffset(nextPan)
  }, [cityBounds, clampPan])

  const screenToWorld = useCallback((x: number, y: number): ScreenPoint => {
    const currentZoom = zoomRef.current
    const currentPan = panOffsetRef.current
    return {
      x: (x - currentPan.x) / currentZoom,
      y: (y - currentPan.y) / currentZoom,
    }
  }, [])

  // Preload all background images and robot sprites
  useEffect(() => {
    const loaded: Record<string, HTMLImageElement> = {}
    const loadedSprites: (HTMLImageElement | null)[] = new Array(SPRITE_CONFIGS.length).fill(null)
    const crops: (([number, number, number, number]) | undefined)[] = SPRITE_CONFIGS.map(c => c.crop)
    spriteCrops.current = crops
    let count = 0
    const totalBg = Object.keys(BG_IMAGES).length
    const totalSprites = SPRITE_CONFIGS.length
    const total = totalBg + totalSprites

    const checkDone = () => {
      if (count === total) {
        setImages({ ...loaded })
        setSprites(loadedSprites.filter(Boolean) as HTMLImageElement[])
      }
    }

    Object.entries(BG_IMAGES).forEach(([key, src]) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => { loaded[key] = img; count++; checkDone() }
      img.onerror = () => { count++; checkDone() }
      img.src = src
    })

    SPRITE_CONFIGS.forEach((cfg, idx) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => { loadedSprites[idx] = img; count++; checkDone() }
      img.onerror = () => { count++; checkDone() }
      img.src = cfg.path
    })
  }, [])

  // District robot strips load independently so a slow sheet never blocks the map.
  useEffect(() => {
    let cancelled = false
    for (const set of ROBOT_SPRITE_SETS) {
      const img = new Image()
      img.onload = () => {
        if (!cancelled) setRobotSheets((prev) => ({ ...prev, [set.district]: img }))
      }
      img.src = set.sheet
    }
    return () => {
      cancelled = true
    }
  }, [])

  // Walk-cycle clock for the robot strips. Skipped under reduced motion.
  useEffect(() => {
    if (reduceMotion || Object.keys(robotSheets).length === 0) return
    const id = window.setInterval(() => setRobotClock(performance.now()), ROBOT_FRAME_MS)
    return () => window.clearInterval(id)
  }, [reduceMotion, robotSheets])

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const particleCanvas = particleCanvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
    const ctx = canvas.getContext("2d")
    if (ctx) ctx.scale(dpr, dpr)

    if (particleCanvas) {
      particleCanvas.width = rect.width * dpr
      particleCanvas.height = rect.height * dpr
      particleCanvas.style.width = `${rect.width}px`
      particleCanvas.style.height = `${rect.height}px`
      const pctx = particleCanvas.getContext("2d")
      if (pctx) pctx.scale(dpr, dpr)
    }
    if (!initializedViewRef.current) {
      initializedViewRef.current = true
      const cityW = cityBounds.maxX - cityBounds.minX
      const cityH = cityBounds.maxY - cityBounds.minY
      const nextZoom = clamp(Math.min((rect.width - 32) / cityW, (rect.height - 96) / cityH, 1), MIN_ZOOM, 1)
      const nextPan = clampPan(
        {
          x: rect.width / 2 - (cityBounds.minX + cityW / 2) * nextZoom,
          y: rect.height / 2 - (cityBounds.minY + cityH / 2) * nextZoom,
        },
        nextZoom,
        rect.width,
        rect.height,
      )
      setZoom(nextZoom)
      setPanOffset(nextPan)
    } else {
      setPanOffset((current) => clampPan(current, zoomRef.current, rect.width, rect.height))
    }
  }, [cityBounds, clampPan])

  useEffect(() => {
    resizeCanvas()
    window.addEventListener("resize", resizeCanvas)
    const observer = new ResizeObserver(() => resizeCanvas())
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener("resize", resizeCanvas)
      observer.disconnect()
    }
  }, [resizeCanvas])

  // Consume declarative particle triggers fired from SSE events (XP, payments, level-ups, badges, district wins).
  useEffect(() => {
    const system = particleSystemRef.current
    const currentIds = new Set(particleTriggers.map((trigger) => trigger.id))

    for (const trigger of particleTriggers) {
      if (processedParticleIdsRef.current.has(trigger.id)) continue
      processedParticleIdsRef.current.add(trigger.id)
      system.emit(trigger.type, trigger.x, trigger.y, trigger.opts)
    }

    for (const id of processedParticleIdsRef.current) {
      if (!currentIds.has(id)) processedParticleIdsRef.current.delete(id)
    }
  }, [particleTriggers])

  // Drive the particle system on its own animation-frame loop, independent of the
  // tick-driven city redraw, so physics (gravity, bounce, rise/fade) stay smooth.
  useEffect(() => {
    if (reduceMotion) return
    let frameId: number
    let lastTime = performance.now()

    const loop = (now: number) => {
      const dt = Math.min(now - lastTime, 50)
      lastTime = now
      const system = particleSystemRef.current
      system.update(dt)

      const canvas = particleCanvasRef.current
      const ctx = canvas?.getContext("2d")
      if (ctx && canvas) {
        const dpr = window.devicePixelRatio || 1
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
        system.draw(ctx)
      }

      frameId = requestAnimationFrame(loop)
    }

    frameId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frameId)
  }, [reduceMotion])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr

    ctx.clearRect(0, 0, w, h)

    ctx.save()
    ctx.translate(panOffset.x, panOffset.y)
    ctx.scale(zoom, zoom)

    drawGrid(ctx, w / zoom, h / zoom)
    drawRoads(ctx, districts)

    for (const d of districts) {
      const standing = districtStandings.find((s) => s.districtId === d.id)
      drawDistrict(
        ctx,
        d,
        tick,
        images[d.id],
        colorBlindMode,
        standing
          ? {
              scoreLabel: standing.formattedScore,
              rank: standing.rank,
              multiplier: standing.multiplier,
              isLeading: standing.rank === 1,
            }
          : null,
      )
    }

    // Re-derive leaderboard enrichment so the renderer can draw top-3 crowns
    // and per-district leader rings (regressed out by PR #206, restored here).
    const topGlobalRanks = new Map(
      [...agents]
        .sort((a, b) => b.tasksCompleted - a.tasksCompleted)
        .slice(0, 3)
        .map((a, i) => [a.id, i + 1] as const),
    )
    const districtLeaderIds = new Set(
      districts
        .map(
          (dist) =>
            [...agents]
              .filter((a) => a.district === dist.id)
              .sort((a, b) => b.tasksCompleted - a.tasksCompleted)[0]?.id,
        )
        .filter(Boolean),
    )

    const sorted = [...agents].sort((a, b) => a.pixelY - b.pixelY)
    for (const agent of sorted) {
      const spriteIdx = agent.spriteId % sprites.length
      const agentSprite = sprites[spriteIdx] || sprites[0]
      const crop = spriteCrops.current[agent.spriteId % SPRITE_CONFIGS.length]
      const enriched = {
        ...agent,
        leaderboardRank: topGlobalRanks.get(agent.id),
        isDistrictLeader: districtLeaderIds.has(agent.id),
      }
      const robotSet = getDistrictRobot(agent.district)
      const robotImage = robotSheets[robotSet.district]
      const isMoving = Math.hypot(agent.targetX - agent.pixelX, agent.targetY - agent.pixelY) > 1.5
      const robot = robotImage
        ? {
            image: robotImage,
            set: robotSet,
            frame: getRobotFrameIndex(
              robotClock,
              robotSet.frames,
              robotSet.frameMs,
              shouldAnimateRobot(agent.status, isMoving, reduceMotion),
              robotPhaseFor(agent.id),
            ),
          }
        : undefined
      drawBot(ctx, enriched, tick, agent.id === selectedAgentId, agentSprite, crop, colorBlindMode, robot)
    }

    if (!reduceMotion) {
      const now = Date.now()
      for (const anim of txAnimations) {
        const elapsed = now - anim.startedAt
        const t = Math.min(1, elapsed / anim.duration)
        if (t >= 1) continue

        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t

        ctx.save()
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.85
        ctx.strokeStyle = "#fbbf24"
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.lineDashOffset = -elapsed * 0.08

        const headX = anim.fromX + (anim.toX - anim.fromX) * eased
        const headY = anim.fromY + (anim.toY - anim.fromY) * eased

        ctx.beginPath()
        ctx.moveTo(anim.fromX, anim.fromY)
        ctx.lineTo(headX, headY)
        ctx.stroke()

        ctx.setLineDash([])
        ctx.globalAlpha = Math.sin(t * Math.PI)
        ctx.fillStyle = "#fbbf24"
        ctx.beginPath()
        ctx.arc(headX, headY, 4, 0, Math.PI * 2)
        ctx.fill()

        ctx.restore()
      }
    }

    ctx.restore()

    if (showMinimap) {
      drawMinimap(ctx, w, h, districts, agents, zoom, panOffset, cityBounds, minimapScale, colorBlindMode)
    }
  }, [agents, districts, selectedAgentId, tick, images, sprites, robotSheets, robotClock, txAnimations, reduceMotion, zoom, panOffset, showMinimap, cityBounds, minimapScale, colorBlindMode, districtStandings])

  // District audio focus follows agent presence. Kept out of the draw effect so the
  // robot walk clock (every ROBOT_FRAME_MS) does not keep rescheduling gain ramps.
  useEffect(() => {
    if (audioEngine) {
      const weights = new Map<string, number>()
      for (const d of districts) weights.set(d.id, 0)
      for (const agent of agents) {
        if (agent.status === "offline") continue
        const visualDistrict = districts.find(
          (d) => agent.pixelX >= d.x && agent.pixelX <= d.x + d.w && agent.pixelY >= d.y && agent.pixelY <= d.y + d.h
        )
        const id = visualDistrict?.id ?? agent.district
        const presence = agent.status === "working" ? 1.5 : 1
        weights.set(id, (weights.get(id) ?? 0) + presence)
      }
      const maxWeight = Math.max(1, ...weights.values())
      for (const d of districts) {
        const volume = 0.18 + 0.82 * ((weights.get(d.id) ?? 0) / maxWeight)
        audioEngine.setDistrictFocus(d.id, volume)
      }
    }
  }, [agents, districts, audioEngine])

  const hitTestAgent = useCallback(
    (mx: number, my: number): MoltbotAgent | null => {
      const worldX = (mx - panOffset.x) / zoom
      const worldY = (my - panOffset.y) / zoom
      for (const agent of agents) {
        const dx = worldX - (agent.pixelX + 8)
        const dy = worldY - (agent.pixelY + 10)
        if (Math.sqrt(dx * dx + dy * dy) < 20) return agent
      }
      return null
    },
    [agents, zoom, panOffset]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      audioEngine?.init()
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const found = hitTestAgent(mx, my)
      onSelectAgent(found?.id ?? null)
    },
    [audioEngine, hitTestAgent, onSelectAgent]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const found = hitTestAgent(mx, my)
      setHoveredAgent(found)
      if (found) {
        setTooltipPos({ x: mx + 12, y: my - 8 })
        canvas.style.cursor = "pointer"
      } else {
        setTooltipPos(null)
        canvas.style.cursor = "crosshair"
      }
    },
    [hitTestAgent]
  )

  const handleMouseLeave = useCallback(() => {
    setHoveredAgent(null)
    setTooltipPos(null)
    const canvas = canvasRef.current
    if (canvas) canvas.style.cursor = "crosshair"
  }, [])

  const handleCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (e.key === "Escape") {
        onSelectAgent(null)
        setFocusedAgentId(null)
      } else if (e.key === "m" || e.key === "M") {
        setShowMinimap(prev => !prev)
      } else if (e.key === "+" || e.key === "=") {
        setZoom(prev => Math.min(prev * 1.2, MAX_ZOOM))
      } else if (e.key === "-" || e.key === "_") {
        setZoom(prev => Math.max(prev / 1.2, MIN_ZOOM))
      } else if (e.key === "0") {
        fitViewToContainer()
      } else if (!focusedAgentId) {
        const panAmount = 40 / zoom
        if (e.key === "ArrowLeft") {
          setPanOffset(prev => ({ ...prev, x: prev.x + panAmount }))
        } else if (e.key === "ArrowRight") {
          setPanOffset(prev => ({ ...prev, x: prev.x - panAmount }))
        } else if (e.key === "ArrowUp") {
          setPanOffset(prev => ({ ...prev, y: prev.y + panAmount }))
        } else if (e.key === "ArrowDown") {
          setPanOffset(prev => ({ ...prev, y: prev.y - panAmount }))
        }
      }
    },
    [fitViewToContainer, onSelectAgent, focusedAgentId, zoom]
  )

  const getPointerPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): ScreenPoint | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === "mouse") return
      const point = getPointerPoint(e)
      if (!point) return

      e.currentTarget.setPointerCapture(e.pointerId)
      pointersRef.current.set(e.pointerId, point)
      touchStartRef.current = { ...point, moved: false }

      if (pointersRef.current.size === 2) {
        const [first, second] = Array.from(pointersRef.current.values())
        const mid = midpoint(first, second)
        pinchRef.current = {
          startDistance: Math.max(1, distance(first, second)),
          worldMidpoint: screenToWorld(mid.x, mid.y),
        }
      }
    },
    [getPointerPoint, screenToWorld],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === "mouse") return
      const point = getPointerPoint(e)
      if (!point || !pointersRef.current.has(e.pointerId)) return

      const previous = pointersRef.current.get(e.pointerId)
      pointersRef.current.set(e.pointerId, point)

      if (touchStartRef.current && distance(touchStartRef.current, point) > 8) {
        touchStartRef.current.moved = true
      }

      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()

      if (pointersRef.current.size >= 2) {
        e.preventDefault()
        suppressClickRef.current = true
        const [first, second] = Array.from(pointersRef.current.values())
        const mid = midpoint(first, second)

        if (!pinchRef.current) {
          pinchRef.current = {
            startDistance: Math.max(1, distance(first, second)),
            worldMidpoint: screenToWorld(mid.x, mid.y),
          }
        }

        const nextZoom = clamp(zoomRef.current * (distance(first, second) / pinchRef.current.startDistance), MIN_ZOOM, MAX_ZOOM)
        const nextPan = clampPan(
          {
            x: mid.x - pinchRef.current.worldMidpoint.x * nextZoom,
            y: mid.y - pinchRef.current.worldMidpoint.y * nextZoom,
          },
          nextZoom,
          rect.width,
          rect.height,
        )
        setZoom(nextZoom)
        setPanOffset(nextPan)
        return
      }

      if (previous) {
        e.preventDefault()
        suppressClickRef.current = true
        const dx = point.x - previous.x
        const dy = point.y - previous.y
        setPanOffset((current) => clampPan({ x: current.x + dx, y: current.y + dy }, zoomRef.current, rect.width, rect.height))
      }
    },
    [clampPan, getPointerPoint, screenToWorld],
  )

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === "mouse") return
      const point = getPointerPoint(e)
      pointersRef.current.delete(e.pointerId)

      if (pointersRef.current.size < 2) {
        pinchRef.current = null
      }

      if (point && touchStartRef.current && !touchStartRef.current.moved && !suppressClickRef.current) {
        const found = hitTestAgent(point.x, point.y)
        onSelectAgent(found?.id ?? null)
      }

      if (pointersRef.current.size === 0) {
        touchStartRef.current = null
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    },
    [getPointerPoint, hitTestAgent, onSelectAgent],
  )

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const world = screenToWorld(point.x, point.y)
      const nextZoom = clamp(zoomRef.current * (e.deltaY > 0 ? 0.92 : 1.08), MIN_ZOOM, MAX_ZOOM)
      const nextPan = clampPan(
        {
          x: point.x - world.x * nextZoom,
          y: point.y - world.y * nextZoom,
        },
        nextZoom,
        rect.width,
        rect.height,
      )
      setZoom(nextZoom)
      setPanOffset(nextPan)
    },
    [clampPan, screenToWorld],
  )

  const statusColors: Record<string, string> = {
    active: "#34d399", running: "#38bdf8", working: "#fbbf24", idle: "#94a3b8", error: "#f87171", offline: "#f87171", degraded: "#fb923c", stopped: "#64748b",
  }

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      {/* Full-viewport animated city GIF background */}
      <NextImage
        src="/bg-city.gif"
        alt=""
        aria-hidden="true"
        unoptimized
        fill
        sizes="100vw"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          zIndex: 0,
          pointerEvents: "none",
          imageRendering: "pixelated",
        }}
      />
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        aria-label={`Agentic City pixel city with ${agents.length} agents deployed. Tab to focus individual agents.`}
        onClick={handleClick}
        onKeyDown={handleCanvasKeyDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
        style={{
          cursor: "crosshair",
          display: "block",
          imageRendering: "pixelated",
          position: "relative",
          zIndex: 1,
          touchAction: "none",
        }}
      />
      <div role="status" aria-label="City map status" style={{ position: "absolute", top: 60, right: 14, zIndex: 3, display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 10, background: "rgba(2,6,23,0.9)", boxShadow: "0 8px 24px rgba(0,0,0,0.28)", backdropFilter: "blur(10px)", pointerEvents: "none" }}>
        <span style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 7, background: "rgba(34,211,238,0.12)", color: "#67e8f9", fontSize: 13 }}>✦</span>
        <span style={{ display: "grid", gap: 2 }}>
          <strong style={{ color: "#f8fafc", fontFamily: "monospace", fontSize: 10, letterSpacing: 1.1 }}>AGENTIC CITY</strong>
          <span style={{ color: "#94a3b8", fontFamily: "monospace", fontSize: 9 }}>{agents.length} robots · {agents.filter((agent) => agent.status === "working" || agent.status === "running").length} en actividad</span>
        </span>
      </div>
      <div role="group" aria-label="City map controls" style={{ position: "absolute", top: 112, right: 14, zIndex: 5, display: "flex", gap: 5, padding: 5, border: "1px solid rgba(148,163,184,0.22)", borderRadius: 10, background: "rgba(2,6,23,0.9)", backdropFilter: "blur(10px)" }}>
        {[
          { label: "Zoom out", icon: Minus, action: () => setZoom((value) => Math.max(value / 1.2, MIN_ZOOM)) },
          { label: "Zoom in", icon: Plus, action: () => setZoom((value) => Math.min(value * 1.2, MAX_ZOOM)) },
          { label: "Center map", icon: LocateFixed, action: fitViewToContainer },
          { label: showMinimap ? "Hide minimap" : "Show minimap", icon: MapIcon, action: () => setShowMinimap((value) => !value), active: showMinimap },
        ].map(({ label, icon: Icon, action, active }) => (
          <button key={label} type="button" aria-label={label} title={label} onClick={action} style={{ width: 34, height: 34, display: "grid", placeItems: "center", border: active ? "1px solid #22d3ee88" : "1px solid transparent", borderRadius: 7, background: active ? "rgba(8,47,73,0.8)" : "transparent", color: active ? "#67e8f9" : "#cbd5e1", cursor: "pointer" }}>
            <Icon size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
      <canvas
        ref={particleCanvasRef}
        aria-hidden="true"
        style={{
          display: "block",
          position: "absolute",
          top: 0,
          left: 0,
          zIndex: 2,
          pointerEvents: "none",
        }}
      />
      {mounted && (
      <div aria-label="Agents on city canvas" role="listbox">
        {agents.map((agent) => {
          const isSelected = agent.id === selectedAgentId
          const isFocused = agent.id === focusedAgentId

          return (
            <button
              key={agent.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              aria-label={`${agent.name}, ${agent.status}, ${agent.currentTask ?? "no active task"}`}
              onFocus={() => setFocusedAgentId(agent.id)}
              onBlur={() => setFocusedAgentId((current) => (current === agent.id ? null : current))}
              onClick={() => onSelectAgent(agent.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onSelectAgent(agent.id)
                }
              }}
              style={{
                position: "absolute",
                left: (agent.pixelX + 8) * zoom + panOffset.x - Math.max(22, 22 * zoom),
                top: (agent.pixelY + 10) * zoom + panOffset.y - Math.max(22, 22 * zoom),
                zIndex: 4,
                width: Math.max(44, 44 * zoom),
                height: Math.max(44, 44 * zoom),
                border: isFocused || isSelected ? `${Math.max(1, 2 * zoom)}px solid #fbbf24` : "1px solid transparent",
                borderRadius: "50%",
                background: colorBlindMode ? "rgba(15,23,42,0.55)" : "transparent",
                color: "#f8fafc",
                cursor: "pointer",
                fontFamily: "monospace",
                fontSize: 14 * zoom,
                lineHeight: `${28 * zoom}px`,
                padding: 0,
                outline: isFocused ? `${Math.max(1, 2 * zoom)}px solid #22d3ee` : "none",
                outlineOffset: 2 * zoom,
              }}
            >
              <span aria-hidden="true">{colorBlindMode ? statusSymbols[agent.status] ?? "•" : ""}</span>
            </button>
          )
        })}
      </div>
      )}
      {floatingOverlays.map((overlay) => {
        const elapsed = Date.now() - overlay.startedAt
        const progress = Math.min(1, elapsed / overlay.duration)
        const lift = Math.round(progress * 28)
        const fade = Math.max(0, 1 - progress)

        return (
          <div
            key={overlay.id}
            style={{
              position: "absolute",
              left: overlay.x * zoom + panOffset.x,
              top: (overlay.y - lift) * zoom + panOffset.y,
              transform: "translate(-50%, -100%)",
              zIndex: 9,
              pointerEvents: "none",
              color: overlay.color,
              opacity: fade,
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: 700,
              textShadow: "0 2px 8px rgba(0,0,0,0.7)",
              background: "rgba(3,7,18,0.35)",
              border: `1px solid ${overlay.color}33`,
              borderRadius: 6,
              padding: "2px 6px",
              whiteSpace: "nowrap",
            }}
          >
            {overlay.text}
          </div>
        )
      })}
      {/* Agent hover tooltip */}
      {hoveredAgent && tooltipPos && (
        <div
          style={{
            position: "absolute",
            left: tooltipPos.x,
            top: tooltipPos.y,
            zIndex: 10,
            background: "#111827",
            border: "1px solid #2a3a52",
            borderRadius: 6,
            padding: "6px 10px",
            pointerEvents: "none",
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusColors[hoveredAgent.status] ?? "#64748b" }} />
            <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: hoveredAgent.color }}>
              {hoveredAgent.name}
            </span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 9, color: "#64748b", lineHeight: 1.5 }}>
            <div>{hoveredAgent.status.toUpperCase()} · CPU {Math.round(hoveredAgent.cpu)}%</div>
            {hoveredAgent.status === "offline" && (
              <div style={{ color: "#f87171" }}>
                Offline for {Math.floor((hoveredAgent.offlineForSeconds ?? 0) / 60)}m
              </div>
            )}
            {hoveredAgent.lastHeartbeat && (
              <div>Last seen {new Date(hoveredAgent.lastHeartbeat).toLocaleTimeString()}</div>
            )}
            {hoveredAgent.currentTask && (
              <div style={{ color: "#94a3b8", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {hoveredAgent.currentTask}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
