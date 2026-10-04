import type { DistrictId } from "@/lib/types"

/**
 * District interior art (Higgsfield, GPT Image 2.5), 1344x752 isometric rooms.
 * The canvas uses the WebP; OG cards (satori, no WebP support) use the JPG.
 * `focusX` / `focusY` pick which part of the 16:9 art stays visible when it is
 * cover-cropped into a district panel, so the open floor sits where robots walk.
 */
export interface DistrictBackground {
  webp: string
  jpg: string
  focusX: number
  focusY: number
}

function bg(id: DistrictId, focusX = 0.5, focusY = 0.5): DistrictBackground {
  return { webp: `/bg-${id}.webp`, jpg: `/bg-${id}.jpg`, focusX, focusY }
}

export const DISTRICT_BACKGROUNDS: Record<DistrictId, DistrictBackground> = {
  "data-center": bg("data-center", 0.62),
  "comm-hub": bg("comm-hub"),
  processing: bg("processing", 0.45),
  defense: bg("defense"),
  research: bg("research"),
}

/** Night skyline behind the whole map (static; the page adds a slow drift). */
export const CITY_BACKGROUND = "/bg-city.webp"

/**
 * Tint laid over the art, as a hex alpha suffix for the district bgColor. Lighter
 * than the old 0xcc so the interiors read; color-blind mode keeps a strong wash so
 * its hatch patterns stay legible.
 */
export const DISTRICT_TINT_ALPHA = "70"
export const DISTRICT_TINT_ALPHA_COLOR_BLIND = "dd"

/**
 * Source rectangle that covers a `dstW` x `dstH` panel with a `srcW` x `srcH`
 * image without distortion (like CSS object-fit: cover), positioned by focus
 * fractions (0 = left/top edge, 1 = right/bottom edge).
 */
export function getCoverCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  focusX = 0.5,
  focusY = 0.5,
): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { sx: 0, sy: 0, sw: Math.max(0, srcW), sh: Math.max(0, srcH) }
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const scale = Math.max(dstW / srcW, dstH / srcH)
  const sw = Math.min(srcW, Math.round(dstW / scale))
  const sh = Math.min(srcH, Math.round(dstH / scale))
  return {
    sx: Math.round((srcW - sw) * clamp(focusX)),
    sy: Math.round((srcH - sh) * clamp(focusY)),
    sw,
    sh,
  }
}
