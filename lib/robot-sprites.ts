import type { DistrictId } from "@/lib/types"

/**
 * District robot set (art generated with Higgsfield, GPT Image 2.5).
 *
 * Each robot ships as:
 * - `sheet`: a transparent horizontal strip of `frames` equal-width cells with a
 *   common baseline, sliced by the canvas renderer.
 * - `animated`: an animated WebP of the same loop for DOM `<img>` usage.
 * - `still`: a single transparent PNG frame (OG cards, avatars, satori).
 *
 * The art already carries the district color, so the renderer must not tint it.
 */
export interface RobotSpriteSet {
  id: "nexus" | "bolt" | "pulse" | "flux" | "halo"
  district: DistrictId
  sheet: string
  animated: string
  still: string
  frames: number
  frameWidth: number
  frameHeight: number
  frameMs: number
}

export const ROBOT_FRAME_MS = 120
export const ROBOT_FRAMES = 6

/** Uniform scale applied to every robot so their designed proportions stay relative. */
export const ROBOT_MAP_SCALE = 0.38

function robot(
  id: RobotSpriteSet["id"],
  district: DistrictId,
  frameWidth: number,
  frameHeight: number,
): RobotSpriteSet {
  return {
    id,
    district,
    sheet: `/sprites/robot-${id}-sheet.png`,
    animated: `/sprites/robot-${id}.webp`,
    still: `/sprites/robot-${id}-still.png`,
    frames: ROBOT_FRAMES,
    frameWidth,
    frameHeight,
    frameMs: ROBOT_FRAME_MS,
  }
}

export const DISTRICT_ROBOTS: Record<DistrictId, RobotSpriteSet> = {
  "data-center": robot("nexus", "data-center", 86, 156),
  "comm-hub": robot("bolt", "comm-hub", 76, 132),
  processing: robot("pulse", "processing", 81, 119),
  defense: robot("flux", "defense", 93, 126),
  research: robot("halo", "research", 87, 124),
}

export const DEFAULT_ROBOT_DISTRICT: DistrictId = "data-center"

export function getDistrictRobot(district: string | null | undefined): RobotSpriteSet {
  if (district && Object.prototype.hasOwnProperty.call(DISTRICT_ROBOTS, district)) {
    return DISTRICT_ROBOTS[district as DistrictId]
  }
  return DISTRICT_ROBOTS[DEFAULT_ROBOT_DISTRICT]
}

export function getRobotStillPath(district: string | null | undefined): string {
  return getDistrictRobot(district).still
}

/** Every robot set, in district order, for preloading. */
export const ROBOT_SPRITE_SETS: RobotSpriteSet[] = Object.values(DISTRICT_ROBOTS)

/**
 * Picks the walk-cycle cell to draw. Agents that are animating loop through the
 * strip; static ones hold the first frame. `phase` desynchronises neighbours so a
 * district does not march in lockstep.
 */
export function getRobotFrameIndex(
  timeMs: number,
  frames: number,
  frameMs: number,
  animate: boolean,
  phase = 0,
): number {
  if (!animate || frames <= 1 || frameMs <= 0 || !Number.isFinite(timeMs)) return 0
  const step = Math.floor(timeMs / frameMs) + Math.trunc(phase)
  return ((step % frames) + frames) % frames
}

/** Stable small integer derived from an agent id, used as animation phase. */
export function robotPhaseFor(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % ROBOT_FRAMES
}

/** Map draw size for one cell, rounded to whole pixels. */
export function getRobotDrawSize(
  set: Pick<RobotSpriteSet, "frameWidth" | "frameHeight">,
  scale = ROBOT_MAP_SCALE,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(set.frameWidth * scale)),
    height: Math.max(1, Math.round(set.frameHeight * scale)),
  }
}

/** Whether a robot should play its walk loop for the given agent state. */
export function shouldAnimateRobot(status: string, isMoving: boolean, reduceMotion = false): boolean {
  if (reduceMotion) return false
  if (isMoving) return true
  return status === "working" || status === "running" || status === "active"
}
