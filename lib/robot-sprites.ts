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
 * The art already carries the district color, so the renderer never multiplies a
 * tint over it. Agents with their own color get a hue-rotate filter instead (see
 * getRobotColorFilter), which recolors the accents and keeps grays intact.
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
  /** Dominant accent hue of the art in degrees, measured from the sheet. */
  accentHue: number
  /**
   * Head anchor as fractions of a cell, for a right-facing robot: `x` is the head
   * center, `y` the top of the head (antenna tips excluded). Measured from cell 0.
   */
  head: { x: number; y: number }
}

export const ROBOT_FRAME_MS = 120
export const ROBOT_FRAMES = 6

/** Uniform scale applied to every robot so their designed proportions stay relative. */
export const ROBOT_MAP_SCALE = 0.38

function robot(
  id: RobotSpriteSet["id"],
  district: DistrictId,
  frame: { width: number; height: number },
  accentHue: number,
  head: { x: number; y: number },
): RobotSpriteSet {
  return {
    id,
    district,
    sheet: `/sprites/robot-${id}-sheet.png`,
    animated: `/sprites/robot-${id}.webp`,
    still: `/sprites/robot-${id}-still.png`,
    frames: ROBOT_FRAMES,
    frameWidth: frame.width,
    frameHeight: frame.height,
    frameMs: ROBOT_FRAME_MS,
    accentHue,
    head,
  }
}

export const DISTRICT_ROBOTS: Record<DistrictId, RobotSpriteSet> = {
  "data-center": robot("nexus", "data-center", { width: 86, height: 156 }, 188, { x: 0.527, y: 0.141 }),
  "comm-hub": robot("bolt", "comm-hub", { width: 76, height: 132 }, 162, { x: 0.531, y: 0.129 }),
  processing: robot("pulse", "processing", { width: 81, height: 120 }, 41, { x: 0.536, y: 0.025 }),
  defense: robot("flux", "defense", { width: 93, height: 126 }, 342, { x: 0.571, y: 0.175 }),
  research: robot("halo", "research", { width: 87, height: 124 }, 246, { x: 0.588, y: 0.024 }),
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

/** Hues closer than this to the robot accent keep the native art untouched. */
export const ROBOT_HUE_TOLERANCE = 20
/** Colors below this HSL saturation (grays, white) do not recolor the robot. */
export const ROBOT_MIN_COLOR_SATURATION = 0.2
/** Modest saturation boost so shifted accents read as clearly as native ones. */
export const ROBOT_SHIFT_SATURATE = 1.15

/**
 * Hue (0-359) of a `#rgb` / `#rrggbb` color, or null when the input is not a hex
 * color or is too desaturated to carry a hue.
 */
export function colorHue(hex: string | null | undefined): number | null {
  if (!hex) return null
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const raw = match[1].length === 3 ? match[1].replace(/./g, (ch) => ch + ch) : match[1]
  const r = parseInt(raw.slice(0, 2), 16) / 255
  const g = parseInt(raw.slice(2, 4), 16) / 255
  const b = parseInt(raw.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  if (saturation < ROBOT_MIN_COLOR_SATURATION) return null
  let hue: number
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  return Math.round((hue * 60 + 360) % 360)
}

/** Signed shortest rotation (-180, 180] that takes hue `from` to hue `to`. */
export function hueRotation(from: number, to: number): number {
  const diff = (((to - from) % 360) + 540) % 360 - 180
  return diff === -180 ? 180 : diff
}

/**
 * Canvas filter that shifts a district robot toward an agent color, or null when
 * the robot should keep its native palette (color matches the accent, is gray or
 * is not a valid hex color).
 */
export function getRobotColorFilter(
  set: Pick<RobotSpriteSet, "accentHue">,
  color: string | null | undefined,
): string | null {
  const target = colorHue(color)
  if (target === null) return null
  const rotation = hueRotation(set.accentHue, target)
  if (Math.abs(rotation) < ROBOT_HUE_TOLERANCE) return null
  return `hue-rotate(${rotation}deg) saturate(${ROBOT_SHIFT_SATURATE})`
}

/**
 * Skin look for district robots, as a canvas filter applied to the sprite itself
 * (the legacy rect overlays would paint a box around the transparent art).
 * Hologram transparency and scanlines are handled by the renderer.
 */
export function getRobotSkinFilter(skin: string | null | undefined, outlineColor: string): string | null {
  switch (skin) {
    case "neon":
      return `drop-shadow(0 0 2px ${outlineColor}) drop-shadow(0 0 4px ${outlineColor})`
    case "chrome":
      return "saturate(0.35) brightness(1.15) contrast(1.15)"
    case "gold":
      return "sepia(0.6) saturate(1.8) brightness(1.05)"
    default:
      return null
  }
}

/** On-screen rectangle a robot cell was drawn into. */
export interface RobotRect {
  left: number
  top: number
  width: number
  height: number
}

/** Head anchor in canvas space, mirrored for left-facing robots. */
export function getRobotHeadAnchor(
  set: Pick<RobotSpriteSet, "head">,
  rect: RobotRect,
  facingLeft = false,
): { x: number; y: number } {
  const fx = facingLeft ? 1 - set.head.x : set.head.x
  return {
    x: Math.round(rect.left + fx * rect.width),
    y: Math.round(rect.top + set.head.y * rect.height),
  }
}
