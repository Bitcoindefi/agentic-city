import { describe, expect, it } from "vitest"
import {
  CITY_BACKGROUND,
  DISTRICT_BACKGROUNDS,
  DISTRICT_TINT_ALPHA,
  DISTRICT_TINT_ALPHA_COLOR_BLIND,
  getCoverCrop,
} from "./district-backgrounds"
import { DISTRICTS } from "./data"

describe("district backgrounds", () => {
  it("has WebP + JPG art for every district", () => {
    for (const d of DISTRICTS) {
      const bg = DISTRICT_BACKGROUNDS[d.id]
      expect(bg.webp).toBe(`/bg-${d.id}.webp`)
      expect(bg.jpg).toBe(`/bg-${d.id}.jpg`)
      expect(bg.focusX).toBeGreaterThanOrEqual(0)
      expect(bg.focusX).toBeLessThanOrEqual(1)
    }
    expect(CITY_BACKGROUND).toBe("/bg-city.webp")
  })

  it("tints lighter than before but keeps color-blind mode strong", () => {
    expect(parseInt(DISTRICT_TINT_ALPHA, 16)).toBeLessThan(0xcc)
    expect(parseInt(DISTRICT_TINT_ALPHA_COLOR_BLIND, 16)).toBeGreaterThan(parseInt(DISTRICT_TINT_ALPHA, 16))
  })
})

describe("getCoverCrop", () => {
  it("crops the sides of a wide image into a narrower panel, centered", () => {
    // 1344x752 into 260x200: full height, width 752 * 1.3 = 977.6 -> 978.
    expect(getCoverCrop(1344, 752, 260, 200)).toEqual({ sx: 183, sy: 0, sw: 978, sh: 752 })
  })

  it("moves the window with the focus point", () => {
    expect(getCoverCrop(1344, 752, 260, 200, 0).sx).toBe(0)
    expect(getCoverCrop(1344, 752, 260, 200, 1).sx).toBe(1344 - 978)
    expect(getCoverCrop(1344, 752, 260, 200, 5).sx).toBe(1344 - 978)
    expect(getCoverCrop(1344, 752, 260, 200, -1).sx).toBe(0)
  })

  it("crops top and bottom of a tall image into a wide panel", () => {
    expect(getCoverCrop(1000, 1000, 300, 150, 0.5, 0.25)).toEqual({ sx: 0, sy: 125, sw: 1000, sh: 500 })
  })

  it("returns the whole image for matching aspect ratios", () => {
    expect(getCoverCrop(1600, 900, 320, 180)).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 900 })
  })

  it("guards empty sizes", () => {
    expect(getCoverCrop(0, 0, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 })
    expect(getCoverCrop(800, 600, 0, 100)).toEqual({ sx: 0, sy: 0, sw: 800, sh: 600 })
  })
})
