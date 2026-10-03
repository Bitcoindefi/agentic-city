import { describe, expect, it } from "vitest"
import { resolveLabelOffsets, type LabelBox } from "./label-layout"

const box = (id: string, x: number, y: number, width = 60, height = 13): LabelBox => ({ id, x, y, width, height })

describe("resolveLabelOffsets", () => {
  it("leaves separated labels alone", () => {
    const offsets = resolveLabelOffsets([box("a", 0, 0), box("b", 200, 0), box("c", 0, 100)])
    expect([...offsets.values()]).toEqual([0, 0, 0])
  })

  it("pushes the later of two overlapping labels down by one label height", () => {
    const offsets = resolveLabelOffsets([box("b", 20, 4), box("a", 0, 0)])
    expect(offsets.get("a")).toBe(0)
    expect(offsets.get("b")).toBe(14)
  })

  it("stacks a cluster of three without any remaining overlap", () => {
    const labels = [box("a", 0, 0), box("b", 10, 2), box("c", 5, 3)]
    const offsets = resolveLabelOffsets(labels)
    const placed = labels.map((l) => ({ ...l, y: l.y + (offsets.get(l.id) ?? 0) }))
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        const horizontal = Math.abs(a.x - b.x) * 2 < a.width + b.width
        const vertical = a.y < b.y + b.height && b.y < a.y + a.height
        expect(horizontal && vertical).toBe(false)
      }
    }
  })

  it("only treats horizontally overlapping labels as collisions", () => {
    // Same row, edges just touching: no push.
    const offsets = resolveLabelOffsets([box("a", 0, 0, 20), box("b", 20, 0, 20)])
    expect(offsets.get("b")).toBe(0)
  })

  it("moves up when the slots below are already taken", () => {
    // Three labels on the same spot: first stays, second goes down, third goes up.
    const offsets = resolveLabelOffsets([box("a", 0, 0), box("b", 0, 0), box("c", 0, 0)])
    expect([offsets.get("a"), offsets.get("b"), offsets.get("c")]).toEqual([0, 14, -14])
  })

  it("orders ties by id so results are stable", () => {
    const first = resolveLabelOffsets([box("y", 0, 0), box("x", 0, 0)])
    const second = resolveLabelOffsets([box("x", 0, 0), box("y", 0, 0)])
    expect(first.get("x")).toBe(0)
    expect(first.get("y")).toBe(14)
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort())
  })

  it("falls back to no offset when every slot is taken", () => {
    // 13 slots exist (0 and +-1..6 steps); the 14th label has nowhere to go.
    const pile = Array.from({ length: 14 }, (_, i) => box(`l${String(i).padStart(2, "0")}`, 0, 0))
    const offsets = resolveLabelOffsets(pile)
    expect(new Set(pile.slice(0, 13).map((l) => offsets.get(l.id))).size).toBe(13)
    expect(offsets.get("l13")).toBe(0)
  })
})
