/** An axis-aligned box whose `x` is the horizontal center and `y` the top. */
export interface LabelBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/** Minimum clear space kept between a label and anything else, in px. */
export const LABEL_GAP = 2
/** How many label heights a label may travel each way before giving up. */
export const LABEL_MAX_STEPS = 4

function overlaps(a: LabelBox, ay: number, b: LabelBox, by: number): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width + LABEL_GAP &&
    ay < by + b.height + LABEL_GAP &&
    by < ay + a.height + LABEL_GAP
  )
}

/** How far (in label steps) a label may move just to clear a robot body. */
export const LABEL_SPRITE_STEPS = 1

/**
 * Greedy collision pass for agent name labels. Labels are placed in order of
 * their natural top (then id for stability). A label that overlaps an already
 * placed label, or a robot sprite box, is moved by its full height plus the gap,
 * trying down first and then up. Clearing sprites is only attempted within
 * LABEL_SPRITE_STEPS (labels are drawn in a final pass above the sprites, and
 * chasing every neighbour's body would send names far from their robot); past
 * that the first slot clear of other labels wins, up to LABEL_MAX_STEPS, and with
 * no such slot the label keeps 0.
 */
export function resolveLabelOffsets(labels: LabelBox[], obstacles: LabelBox[] = []): Map<string, number> {
  const ordered = [...labels].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))
  const placed: Array<{ box: LabelBox; y: number }> = []
  const offsets = new Map<string, number>()

  for (const box of ordered) {
    const step = box.height + LABEL_GAP
    const candidates = [0]
    for (let i = 1; i <= LABEL_MAX_STEPS; i++) candidates.push(i * step, -i * step)
    const clearOfLabels = (dy: number) => placed.every((p) => !overlaps(box, box.y + dy, p.box, p.y))
    const clearOfSprites = (dy: number) => obstacles.every((o) => !overlaps(box, box.y + dy, o, o.y))
    // Prefer a nearby slot clear of both; otherwise never let two labels overlap.
    const nearby = candidates.slice(0, 1 + 2 * LABEL_SPRITE_STEPS)
    const dy =
      nearby.find((c) => clearOfLabels(c) && clearOfSprites(c)) ??
      candidates.find(clearOfLabels) ??
      0
    placed.push({ box, y: box.y + dy })
    offsets.set(box.id, dy)
  }

  return offsets
}
