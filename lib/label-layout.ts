/** A name label box before collision resolution. `x` is the box center. */
export interface LabelBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

const GAP = 1
const MAX_STEPS = 6

function overlaps(a: LabelBox, ay: number, b: LabelBox, by: number): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width &&
    ay < by + b.height + GAP &&
    by < ay + a.height + GAP
  )
}

/**
 * Greedy collision pass for agent name labels. Labels are placed in order of
 * their natural top (then id for stability); a label that overlaps an already
 * placed one is pushed down one label height at a time, then up, until it fits
 * or the step budget runs out. Returns the vertical offset per label id; labels
 * that never collide get 0.
 */
export function resolveLabelOffsets(labels: LabelBox[]): Map<string, number> {
  const ordered = [...labels].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))
  const placed: Array<{ box: LabelBox; y: number }> = []
  const offsets = new Map<string, number>()

  for (const box of ordered) {
    const step = box.height + GAP
    const candidates = [0]
    for (let i = 1; i <= MAX_STEPS; i++) candidates.push(i * step, -i * step)
    const fits = (dy: number) => placed.every((p) => !overlaps(box, box.y + dy, p.box, p.y))
    const dy = candidates.find(fits) ?? 0
    placed.push({ box, y: box.y + dy })
    offsets.set(box.id, dy)
  }

  return offsets
}
