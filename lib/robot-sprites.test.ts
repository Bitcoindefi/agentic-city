import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROBOT_DISTRICT,
  DISTRICT_ROBOTS,
  ROBOT_FRAME_MS,
  ROBOT_FRAMES,
  ROBOT_MAP_SCALE,
  ROBOT_SPRITE_SETS,
  getDistrictRobot,
  getRobotDrawSize,
  getRobotFrameIndex,
  getRobotStillPath,
  robotPhaseFor,
  shouldAnimateRobot,
  colorHue,
  hueRotation,
  getRobotColorFilter,
  getRobotSkinFilter,
  getRobotHeadAnchor,
  ROBOT_SHIFT_SATURATE,
} from "./robot-sprites"
import { DISTRICTS } from "./data"

describe("robot sprite sets", () => {
  it("assigns one robot per district with matching district ids", () => {
    for (const district of DISTRICTS) {
      const set = DISTRICT_ROBOTS[district.id]
      expect(set.district).toBe(district.id)
      expect(set.frames).toBe(ROBOT_FRAMES)
      expect(set.frameMs).toBe(ROBOT_FRAME_MS)
      expect(set.sheet).toBe(`/sprites/robot-${set.id}-sheet.png`)
      expect(set.animated).toBe(`/sprites/robot-${set.id}.webp`)
      expect(set.still).toBe(`/sprites/robot-${set.id}-still.png`)
    }
    expect(new Set(ROBOT_SPRITE_SETS.map((s) => s.id)).size).toBe(DISTRICTS.length)
  })

  it("maps districts to the intended robots", () => {
    expect(getDistrictRobot("data-center").id).toBe("nexus")
    expect(getDistrictRobot("comm-hub").id).toBe("bolt")
    expect(getDistrictRobot("processing").id).toBe("pulse")
    expect(getDistrictRobot("defense").id).toBe("flux")
    expect(getDistrictRobot("research").id).toBe("halo")
  })

  it("falls back to the default district robot for unknown input", () => {
    const fallback = DISTRICT_ROBOTS[DEFAULT_ROBOT_DISTRICT]
    expect(getDistrictRobot(undefined)).toBe(fallback)
    expect(getDistrictRobot(null)).toBe(fallback)
    expect(getDistrictRobot("")).toBe(fallback)
    expect(getDistrictRobot("toString")).toBe(fallback)
    expect(getDistrictRobot("downtown")).toBe(fallback)
    expect(getRobotStillPath("defense")).toBe("/sprites/robot-flux-still.png")
    expect(getRobotStillPath("nope")).toBe(fallback.still)
  })
})

describe("getRobotFrameIndex", () => {
  it("holds the first frame when not animating", () => {
    expect(getRobotFrameIndex(5000, 6, 120, false)).toBe(0)
  })

  it("steps one frame per frameMs and loops", () => {
    expect(getRobotFrameIndex(0, 6, 120, true)).toBe(0)
    expect(getRobotFrameIndex(119, 6, 120, true)).toBe(0)
    expect(getRobotFrameIndex(120, 6, 120, true)).toBe(1)
    expect(getRobotFrameIndex(120 * 5, 6, 120, true)).toBe(5)
    expect(getRobotFrameIndex(120 * 6, 6, 120, true)).toBe(0)
  })

  it("applies a phase offset and stays within range", () => {
    expect(getRobotFrameIndex(0, 6, 120, true, 4)).toBe(4)
    expect(getRobotFrameIndex(240, 6, 120, true, 5)).toBe(1)
    expect(getRobotFrameIndex(0, 6, 120, true, -1)).toBe(5)
  })

  it("guards degenerate inputs", () => {
    expect(getRobotFrameIndex(500, 1, 120, true)).toBe(0)
    expect(getRobotFrameIndex(500, 6, 0, true)).toBe(0)
    expect(getRobotFrameIndex(Number.NaN, 6, 120, true)).toBe(0)
  })
})

describe("robotPhaseFor", () => {
  it("is stable and bounded", () => {
    expect(robotPhaseFor("bot-3")).toBe(robotPhaseFor("bot-3"))
    for (const id of ["", "bot-0", "bot-1", "cloud-agent-xyz", "a".repeat(200)]) {
      const phase = robotPhaseFor(id)
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(ROBOT_FRAMES)
    }
  })
})

describe("getRobotDrawSize", () => {
  it("scales cells uniformly and rounds to whole pixels", () => {
    const size = getRobotDrawSize(DISTRICT_ROBOTS["data-center"])
    expect(size).toEqual({
      width: Math.round(86 * ROBOT_MAP_SCALE),
      height: Math.round(156 * ROBOT_MAP_SCALE),
    })
    expect(getRobotDrawSize({ frameWidth: 100, frameHeight: 50 }, 0.5)).toEqual({ width: 50, height: 25 })
  })

  it("never returns a zero size", () => {
    expect(getRobotDrawSize({ frameWidth: 1, frameHeight: 1 }, 0.01)).toEqual({ width: 1, height: 1 })
  })
})

describe("shouldAnimateRobot", () => {
  it("animates moving or busy agents", () => {
    expect(shouldAnimateRobot("idle", true)).toBe(true)
    expect(shouldAnimateRobot("working", false)).toBe(true)
    expect(shouldAnimateRobot("running", false)).toBe(true)
    expect(shouldAnimateRobot("active", false)).toBe(true)
  })

  it("holds still for idle, offline, error and reduced motion", () => {
    expect(shouldAnimateRobot("idle", false)).toBe(false)
    expect(shouldAnimateRobot("offline", false)).toBe(false)
    expect(shouldAnimateRobot("error", false)).toBe(false)
    expect(shouldAnimateRobot("working", true, true)).toBe(false)
  })
})

describe("colorHue", () => {
  it("reads the hue of hex colors", () => {
    expect(colorHue("#22d3ee")).toBe(188)
    expect(colorHue("#f472b6")).toBe(329)
    expect(colorHue("#34d399")).toBe(158)
    expect(colorHue("#00ff00")).toBe(120)
    expect(colorHue("#ff0000")).toBe(0)
    expect(colorHue("#ABC")).toBe(210)
    expect(colorHue("  #0000ff ")).toBe(240)
  })

  it("returns null for grays, invalid and empty input", () => {
    expect(colorHue("#888888")).toBeNull()
    expect(colorHue("#fff")).toBeNull()
    expect(colorHue("red")).toBeNull()
    expect(colorHue("#12345")).toBeNull()
    expect(colorHue("")).toBeNull()
    expect(colorHue(null)).toBeNull()
    expect(colorHue(undefined)).toBeNull()
  })
})

describe("hueRotation", () => {
  it("takes the shortest signed path around the wheel", () => {
    expect(hueRotation(350, 10)).toBe(20)
    expect(hueRotation(10, 350)).toBe(-20)
    expect(hueRotation(162, 329)).toBe(167)
    expect(hueRotation(0, 180)).toBe(180)
    expect(hueRotation(40, 40)).toBe(0)
  })
})

describe("getRobotColorFilter", () => {
  it("keeps the native art when the agent color matches the robot accent", () => {
    expect(getRobotColorFilter(DISTRICT_ROBOTS["data-center"], "#22d3ee")).toBeNull()
    expect(getRobotColorFilter(DISTRICT_ROBOTS["comm-hub"], "#34d399")).toBeNull()
    for (const district of DISTRICTS) {
      expect(getRobotColorFilter(DISTRICT_ROBOTS[district.id], district.color)).toBeNull()
    }
  })

  it("hue-shifts toward a different agent color with a modest saturate", () => {
    expect(getRobotColorFilter(DISTRICT_ROBOTS["comm-hub"], "#f472b6")).toBe(
      `hue-rotate(167deg) saturate(${ROBOT_SHIFT_SATURATE})`,
    )
  })

  it("applies the tolerance edge exactly", () => {
    expect(getRobotColorFilter({ accentHue: 101 }, "#00ff00")).toBeNull()
    expect(getRobotColorFilter({ accentHue: 100 }, "#00ff00")).toBe(`hue-rotate(20deg) saturate(${ROBOT_SHIFT_SATURATE})`)
  })

  it("ignores gray or invalid colors", () => {
    expect(getRobotColorFilter({ accentHue: 100 }, "#777777")).toBeNull()
    expect(getRobotColorFilter({ accentHue: 100 }, "nope")).toBeNull()
    expect(getRobotColorFilter({ accentHue: 100 }, null)).toBeNull()
  })
})

describe("getRobotSkinFilter", () => {
  it("maps skins to sprite filters", () => {
    expect(getRobotSkinFilter("neon", "#34d399")).toContain("drop-shadow(0 0 2px #34d399)")
    expect(getRobotSkinFilter("chrome", "#000")).toContain("saturate(0.35)")
    expect(getRobotSkinFilter("gold", "#000")).toContain("sepia")
  })

  it("leaves default, hologram, legendary and unknown skins untouched", () => {
    for (const skin of ["default", "hologram", "legendary", "unknown", null, undefined]) {
      expect(getRobotSkinFilter(skin, "#000")).toBeNull()
    }
  })
})

describe("getRobotHeadAnchor", () => {
  const rect = { left: 10, top: 20, width: 40, height: 100 }

  it("scales the head fractions into the drawn rect", () => {
    expect(getRobotHeadAnchor({ head: { x: 0.5, y: 0.1 } }, rect)).toEqual({ x: 30, y: 30 })
  })

  it("mirrors the head x for left-facing robots", () => {
    expect(getRobotHeadAnchor({ head: { x: 0.25, y: 0 } }, rect, true)).toEqual({ x: 40, y: 20 })
  })

  it("puts every robot head in the top part of its cell", () => {
    for (const set of ROBOT_SPRITE_SETS) {
      expect(set.head.x).toBeGreaterThan(0.3)
      expect(set.head.x).toBeLessThan(0.7)
      expect(set.head.y).toBeGreaterThanOrEqual(0)
      expect(set.head.y).toBeLessThan(0.3)
      expect(set.accentHue).toBeGreaterThanOrEqual(0)
      expect(set.accentHue).toBeLessThan(360)
    }
  })
})
