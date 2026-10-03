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
