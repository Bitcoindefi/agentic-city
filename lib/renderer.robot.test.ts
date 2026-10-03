import { describe, expect, it } from "vitest"
import { drawBot, type RobotFrame } from "@/lib/renderer"
import { DISTRICT_ROBOTS, getRobotDrawSize } from "@/lib/robot-sprites"
import type { MoltbotAgent } from "@/lib/types"

type Call = { name: string; args: unknown[] }

/** Minimal recording stand-in for CanvasRenderingContext2D. */
function makeCtx() {
  const calls: Call[] = []
  const sets: Array<{ prop: string; value: unknown }> = []
  const target: Record<string, unknown> = {}
  const ctx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop]
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
        return { width: 10, addColorStop() {} }
      }
    },
    set(obj, prop: string, value) {
      sets.push({ prop, value })
      obj[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, sets }
}

const baseAgent: MoltbotAgent = {
  id: "bot-robot",
  name: "Robot",
  model: "test",
  status: "idle",
  district: "data-center",
  cpu: 0,
  memory: 0,
  tasksCompleted: 0,
  currentTask: null,
  taskProgress: 0,
  color: "#22d3ee",
  pixelX: 100,
  pixelY: 100,
  targetX: 100,
  targetY: 100,
  frame: 0,
  direction: "right",
  spriteId: 0,
  skills: [],
  appearance: { skin: "default", accessories: [], customColor: null },
}

const set = DISTRICT_ROBOTS["data-center"]

function robotFrame(frame: number, naturalWidth = set.frameWidth * set.frames, naturalHeight = set.frameHeight): RobotFrame {
  const image = { naturalWidth, naturalHeight, width: naturalWidth, height: naturalHeight } as unknown as HTMLImageElement
  return { image, set, frame }
}

function drawImageCalls(calls: Call[]) {
  return calls.filter((c) => c.name === "drawImage")
}

describe("drawBot with a district robot frame", () => {
  it("slices the requested cell and draws it untinted at the robot size", () => {
    const { ctx, calls } = makeCtx()
    const robot = robotFrame(2)
    drawBot(ctx, baseAgent, 0, false, undefined, undefined, false, robot)

    const draws = drawImageCalls(calls)
    expect(draws).toHaveLength(1)
    const [img, sx, sy, sw, sh, dx, dy, dw, dh] = draws[0].args as [unknown, number, number, number, number, number, number, number, number]
    const { width, height } = getRobotDrawSize(set)
    expect(img).toBe(robot.image)
    expect([sx, sy, sw, sh]).toEqual([2 * set.frameWidth, 0, set.frameWidth, set.frameHeight])
    expect([dw, dh]).toEqual([width, height])
    // Feet land on the legacy 48px box bottom: y - 4 + 48.
    expect(dy + dh).toBe(baseAgent.pixelY - 4 + 48)
    expect(dx).toBe(Math.round(baseAgent.pixelX + 8 - width / 2))
    // No multiply tint pass happens for the robot set.
    expect(calls.some((c) => c.name === "getImageData")).toBe(false)
  })

  it("mirrors left-facing robots and wraps out-of-range frames", () => {
    const { ctx, calls } = makeCtx()
    drawBot(ctx, { ...baseAgent, direction: "left" }, 0, false, undefined, undefined, false, robotFrame(set.frames + 1))
    expect(calls.some((c) => c.name === "scale" && c.args[0] === -1 && c.args[1] === 1)).toBe(true)
    const [, sx, , , , dx] = drawImageCalls(calls)[0].args as number[]
    expect(sx).toBe(set.frameWidth)
    expect(dx).toBe(0)
  })

  it("falls back to the set geometry when the image has no intrinsic size", () => {
    const { ctx, calls } = makeCtx()
    drawBot(ctx, baseAgent, 0, false, undefined, undefined, false, robotFrame(1, 0, 0))
    const [, sx, , sw, sh] = drawImageCalls(calls)[0].args as number[]
    expect([sx, sw, sh]).toEqual([set.frameWidth, set.frameWidth, set.frameHeight])
  })

  it("dims offline robots and flashes errors through canvas filters", () => {
    const offline = makeCtx()
    drawBot(offline.ctx, { ...baseAgent, status: "offline" }, 0, false, undefined, undefined, false, robotFrame(0))
    expect(offline.sets.some((s) => s.prop === "filter" && String(s.value).includes("grayscale"))).toBe(true)

    const error = makeCtx()
    drawBot(error.ctx, { ...baseAgent, status: "error" }, 3, false, undefined, undefined, false, robotFrame(0))
    expect(error.sets.some((s) => s.prop === "filter" && String(s.value).includes("drop-shadow"))).toBe(true)
  })

  it("keeps hologram transparency and anchors overlays to the robot box", () => {
    const { ctx, calls, sets } = makeCtx()
    const agent: MoltbotAgent = {
      ...baseAgent,
      status: "working",
      taskProgress: 40,
      deployment: "cloud",
      appearance: { skin: "hologram", accessories: [], customColor: null },
    }
    drawBot(ctx, agent, 5, true, undefined, undefined, false, robotFrame(0))
    expect(sets.some((s) => s.prop === "globalAlpha" && typeof s.value === "number" && s.value < 1)).toBe(true)
    expect(calls.some((c) => c.name === "fillText" && c.args[0] === "CLOUD")).toBe(true)
  })

  it("keeps the legacy fallback when no robot frame is given", () => {
    const { ctx, calls } = makeCtx()
    drawBot(ctx, baseAgent, 0, false)
    expect(drawImageCalls(calls)).toHaveLength(0)
    expect(calls.some((c) => c.name === "fillRect")).toBe(true)
  })
})
