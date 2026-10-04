import { describe, expect, it } from "vitest"
import { LABEL_GAP, LABEL_MAX_STEPS, resolveLabelOffsets, type LabelBox } from "./label-layout"

const box = (id: string, x: number, y: number, width = 60, height = 13): LabelBox => ({ id, x, y, width, height })
const STEP = 13 + LABEL_GAP

function overlapping(a: LabelBox, b: LabelBox): boolean {
  return Math.abs(a.x - b.x) * 2 < a.width + b.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe("resolveLabelOffsets", () => {
  it("leaves separated labels alone", () => {
    const offsets = resolveLabelOffsets([box("a", 0, 0), box("b", 200, 0), box("c", 0, 100)])
    expect([...offsets.values()]).toEqual([0, 0, 0])
  })

  it("pushes the later of two overlapping labels down by full height plus gap", () => {
    const offsets = resolveLabelOffsets([box("b", 20, 4), box("a", 0, 0)])
    expect(offsets.get("a")).toBe(0)
    expect(offsets.get("b")).toBe(STEP)
  })

  it("keeps the gap between labels that would only touch", () => {
    // 13px tall labels 14px apart leave 1px, less than the gap: pushed.
    const offsets = resolveLabelOffsets([box("a", 0, 0), box("b", 0, 14)])
    expect(offsets.get("b")).toBe(STEP)
  })

  it("stacks a cluster without any remaining overlap", () => {
    const labels = [box("a", 0, 0), box("b", 10, 2), box("c", 5, 3), box("d", 30, 1)]
    const offsets = resolveLabelOffsets(labels)
    const placed = labels.map((l) => ({ ...l, y: l.y + (offsets.get(l.id) ?? 0) }))
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlapping(placed[i], placed[j])).toBe(false)
      }
    }
  })

  it("alternates down then up on the same spot", () => {
    const offsets = resolveLabelOffsets([box("a", 0, 0), box("b", 0, 0), box("c", 0, 0)])
    expect([offsets.get("a"), offsets.get("b"), offsets.get("c")]).toEqual([0, STEP, -STEP])
  })

  it("orders ties by id so results are stable", () => {
    const first = resolveLabelOffsets([box("y", 0, 0), box("x", 0, 0)])
    const second = resolveLabelOffsets([box("x", 0, 0), box("y", 0, 0)])
    expect(first.get("x")).toBe(0)
    expect(first.get("y")).toBe(STEP)
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort())
  })

  it("only treats horizontally overlapping labels as collisions", () => {
    const offsets = resolveLabelOffsets([box("a", 0, 0, 20), box("b", 30, 0, 20)])
    expect(offsets.get("b")).toBe(0)
  })

  it("moves labels off robot sprite boxes", () => {
    const sprite = box("robot", 0, 0, 30, 20)
    const offsets = resolveLabelOffsets([box("a", 0, 10)], [sprite])
    expect(offsets.get("a")).toBe(STEP)
  })

  it("only nudges one step to clear a sprite", () => {
    // Sprite covers the natural slot and the one below: the label goes one step up.
    const below = box("robot", 0, 12, 30, 30)
    expect(resolveLabelOffsets([box("a", 0, 10)], [below]).get("a")).toBe(-STEP)
    // Covering the up slot as well: no further chase, the label stays put.
    const tall = box("robot", 0, -10, 30, 50)
    expect(resolveLabelOffsets([box("a", 0, 10)], [tall]).get("a")).toBe(0)
  })

  it("prefers a label-free slot over keeping a sprite clear when both cannot hold", () => {
    // A tall sprite covers every slot in reach; the label still avoids label "a".
    const tower = box("tower", 0, -200, 40, 400)
    const offsets = resolveLabelOffsets([box("a", 0, 0), box("b", 0, 0)], [tower])
    expect(offsets.get("a")).toBe(0)
    expect(offsets.get("b")).toBe(STEP)
  })

  it("falls back to no offset when every slot is taken", () => {
    const slots = 1 + 2 * LABEL_MAX_STEPS
    const pile = Array.from({ length: slots + 1 }, (_, i) => box(`l${String(i).padStart(2, "0")}`, 0, 0))
    const offsets = resolveLabelOffsets(pile)
    expect(new Set(pile.slice(0, slots).map((l) => offsets.get(l.id))).size).toBe(slots)
    expect(offsets.get(pile[slots].id)).toBe(0)
  })
})
