import { describe, expect, it, vi } from "vitest"
import { createMemoryStore, type KvStore } from "@/lib/security/kv-store"
import { createApprovalSigner } from "@/lib/orchestration/approval"
import { spentToday } from "@/lib/orchestration/budget"
import type { ChatStreamEvent } from "@/lib/orchestration/events"
import {
  DEFAULT_HANDOFF_CAPS,
  composeTask,
  createRunState,
  executeApprovedHandoff,
  handoffTool,
  resolveTarget,
  sendHandoff,
  type HandoffDeps,
  type HandoffOutcome,
  type RosterAgent,
} from "@/lib/orchestration/handoff"
import type { HopResult } from "@/lib/orchestration/wallet"
import { createMemoryReceiptBackend, readReceiptLog, setReceiptBackendForTests } from "@/lib/receipts/log"

const connection = { provider: "openrouter" as const, model: "anthropic/claude", apiKey: "or-test-key-1234" }
const roster: RosterAgent[] = [
  { id: "research", name: "Investigador", role: "Relevar opciones", connection },
  { id: "critic", name: "Critico", role: "Buscar riesgos", connection: { ...connection, model: "x-ai/grok-4" } },
  { id: "writer", name: "Redactor", role: "Escribir", connection },
]
const day = new Date("2026-10-01T12:00:00Z")
const from = { id: "orchestrator", name: "Supervisor", depth: 0, turnId: "orchestrator-0" }
const key = Buffer.alloc(32, 3)
const OWNER = "c".repeat(32)
const WALLET = "AgentWa11et1111111111111111111111111111111"

function receipt(n: number) {
  return { transaction: `Sig${n}`, network: "solana:devnet", payer: "Orch", amount: "10000", asset: "USDC", explorerUrl: `https://explorer.solana.com/tx/Sig${n}?cluster=devnet` }
}

function setup(overrides: Partial<HandoffDeps> = {}) {
  const events: ChatStreamEvent[] = []
  const store = createMemoryStore()
  let paid = 0
  const hire = vi.fn(async (agent: RosterAgent): Promise<HopResult> => ({ ok: true, answer: `answer from ${agent.name}`, receipt: receipt(++paid) }))
  let turns = 0
  const deps: HandoffDeps = {
    roster,
    caps: DEFAULT_HANDOFF_CAPS,
    budget: { perRunMicro: 50_000, perDayMicro: 500_000, hardDayMicro: 2_000_000 },
    priceMicro: 10_000,
    store,
    owner: OWNER,
    wallet: { address: WALLET },
    hire,
    approvals: createApprovalSigner(key),
    emit: (event) => events.push(event),
    newTurnId: (id) => `${id}-${++turns}`,
    now: () => day,
    ...overrides,
  }
  return { deps, events, store, hire, run: createRunState("run-1") }
}

describe("composeTask and resolveTarget", () => {
  it("puts constraints and the expected answer after the task", () => {
    expect(composeTask({ task: " Find options ", constraints: " devnet only ", expecting: "a list" })).toBe("Find options\n\nConstraints: devnet only\n\nWhat to return: a list")
    expect(composeTask({ task: "Just this", constraints: " " })).toBe("Just this")
  })

  it("resolves by id first, then by name, and refuses ambiguity, strangers and itself", () => {
    expect(resolveTarget(roster, "CRITIC", "orchestrator")).toMatchObject({ ok: true, agent: { id: "critic" } })
    expect(resolveTarget(roster, "investigador", "orchestrator")).toMatchObject({ ok: true, agent: { id: "research" } })
    const twins = [...roster, { ...roster[0], id: "research-2" }]
    expect(resolveTarget(twins, "Investigador", "orchestrator")).toEqual({ ok: false, refusal: 'More than one agent is called "Investigador": research, research-2. Ask again using the id you mean.' })
    expect(resolveTarget(twins, "research-2", "orchestrator")).toMatchObject({ ok: true, agent: { id: "research-2" } })
    expect(resolveTarget(roster, "ghost", "orchestrator")).toEqual({ ok: false, refusal: 'There is no agent called "ghost" on this team.' })
    expect(resolveTarget(roster, "research", "research")).toEqual({ ok: false, refusal: "An agent cannot hire itself. Do the work, or ask the person." })
  })
})

describe("sendHandoff", () => {
  it("pays the hired agent, shows the receipt and its answer, and hands the answer back", async () => {
    const { deps, events, hire, run, store } = setup()
    const outcome = await sendHandoff(deps, run, from, "Investigador", { task: "Find options", expecting: "three bullets" })

    expect(outcome).toMatchObject({ ok: true, toName: "Investigador", answer: "answer from Investigador" })
    expect((outcome as Extract<HandoffOutcome, { ok: true }>).text).toContain("tx Sig1")
    expect(hire).toHaveBeenCalledWith(roster[0], "Find options\n\nWhat to return: three bullets")
    expect(events).toEqual([
      { type: "handoff", turnId: "orchestrator-0", fromName: "Supervisor", toName: "Investigador", task: "Find options", amount: "0.01", receipt: receipt(1) },
      { type: "agent-start", turnId: "research-1", agentId: "research", name: "Investigador", model: "anthropic/claude", depth: 1, hiredBy: "Supervisor" },
      { type: "text", turnId: "research-1", delta: "answer from Investigador" },
      { type: "agent-end", turnId: "research-1" },
    ])
    expect(run).toMatchObject({ hops: 1, spentMicro: 10_000, receipts: [receipt(1)] })
    expect(await spentToday(store, OWNER, day)).toBe(10_000)
  })

  it("adds the hire to the public receipts log: who hired whom, never the task", async () => {
    const backend = createMemoryReceiptBackend()
    setReceiptBackendForTests(backend)
    try {
      const tx = "5".repeat(88)
      const { deps, run } = setup({ hire: vi.fn(async (): Promise<HopResult> => ({ ok: true, answer: "ok", receipt: { ...receipt(1), transaction: tx, payer: null, amount: "" } })) })
      await sendHandoff(deps, run, from, "research", { task: "Find my secret plans" })
      const [record] = await readReceiptLog(backend)
      expect(record).toMatchObject({ type: "hire", tx, amount: "10000", asset: "USDC", agentId: "research", agentName: "Investigador", counterpartId: "orchestrator", counterpartName: "Supervisor", payer: "Agen…1111" })
      expect(JSON.stringify(record)).not.toContain("secret")
    } finally {
      setReceiptBackendForTests(null)
    }
  })

  it("refuses with a sentence, never an exception", async () => {
    const { deps, run, hire } = setup()
    expect(await sendHandoff(deps, run, from, "research", { task: "  " })).toEqual({ ok: false, refusal: "Nothing was sent: a hire has to say what the other agent is being asked to do." })
    expect(await sendHandoff(deps, run, from, "ghost", { task: "x" })).toMatchObject({ ok: false, refusal: expect.stringContaining("no agent called") })
    expect(await sendHandoff(deps, run, from, undefined as never, { task: "x" })).toMatchObject({ ok: false })
    expect(hire).not.toHaveBeenCalled()
  })

  it("stops at the depth cap", async () => {
    const { deps, run } = setup()
    expect(await sendHandoff(deps, run, { ...from, depth: 2 }, "research", { task: "x" })).toEqual({ ok: false, refusal: "This is already 2 hires deep, which is as far as this team allows. Answer with what you have, or ask the person." })
    expect(await sendHandoff(deps, run, { ...from, depth: 1 }, "research", { task: "x" })).toMatchObject({ ok: true })
    const off = setup({ caps: { maxDepth: 0, maxPerRun: 4 } })
    expect(await sendHandoff(off.deps, off.run, from, "research", { task: "x" })).toEqual({ ok: false, refusal: "This team does not let one agent hire another." })
  })

  it("says hiring is off when this server cannot keep agents' wallets", async () => {
    const { deps, run } = setup({ hire: null })
    expect(await sendHandoff(deps, run, from, "research", { task: "x" })).toMatchObject({ ok: false, refusal: expect.stringContaining("agents' wallets need BETTER_AUTH_SECRET") })
  })

  it("offers the Fund button instead of failing when the agents' wallet is empty", async () => {
    const hire = vi.fn(async (): Promise<HopResult> => ({ ok: false, code: "unfunded", balanceMicro: 4_000, error: "not enough" }))
    const { deps, run, events, store } = setup({ hire })
    const outcome = await sendHandoff(deps, run, from, "research", { task: "a" })
    expect(outcome).toMatchObject({ ok: false, refusal: expect.stringContaining("holds 0.004 USDC, so nothing was charged") })
    expect((outcome as { refusal: string }).refusal).toContain("Fund button")
    expect(events).toEqual([{ type: "wallet", status: "unfunded", address: WALLET, balanceUsdc: "0.004", neededUsdc: "0.01" }])
    expect(run).toMatchObject({ hops: 0, spentMicro: 0, walletEmpty: true })
    expect(await spentToday(store, OWNER, day)).toBe(0)

    // Later hires in the same run are refused at once, without another balance check.
    expect(await sendHandoff(deps, run, from, "critic", { task: "b" })).toMatchObject({ ok: false, refusal: expect.stringContaining("does not hold enough") })
    expect(hire).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
  })

  it("explains an empty wallet even when there is no address to show", async () => {
    const hire = vi.fn(async (): Promise<HopResult> => ({ ok: false, code: "unfunded", error: "not enough" }))
    const { deps, run, events } = setup({ hire, wallet: null })
    expect(await sendHandoff(deps, run, from, "research", { task: "a" })).toMatchObject({ ok: false, refusal: expect.stringContaining("holds 0 USDC") })
    expect(events).toEqual([])
  })

  it("does not pay twice for the same ask", async () => {
    const { deps, run, hire } = setup()
    await sendHandoff(deps, run, from, "research", { task: "Find options" })
    expect(await sendHandoff(deps, run, from, "Investigador", { task: "Find options " })).toMatchObject({ ok: false, refusal: expect.stringContaining("already asked Investigador") })
    expect(hire).toHaveBeenCalledTimes(1)
  })

  it("caps the hires per run, even when they are requested at the same time", async () => {
    const { deps, run, hire } = setup({ budget: { perRunMicro: 1_000_000, perDayMicro: 1_000_000, hardDayMicro: 1_000_000 } })
    const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => sendHandoff(deps, run, from, roster[i % 3].id, { task: `task ${i}` })))
    expect(outcomes.filter((item) => item.ok)).toHaveLength(4)
    expect(outcomes.filter((item) => !item.ok).map((item) => (item as { refusal: string }).refusal)).toEqual([
      "This conversation has already hired 4 agents, which is as many as this team allows. Answer with what you have, or ask the person.",
      "This conversation has already hired 4 agents, which is as many as this team allows. Answer with what you have, or ask the person.",
    ])
    expect(hire).toHaveBeenCalledTimes(4)
    const one = setup({ caps: { maxDepth: 2, maxPerRun: 1 } })
    await sendHandoff(one.deps, one.run, from, "research", { task: "a" })
    expect(await sendHandoff(one.deps, one.run, from, "critic", { task: "b" })).toMatchObject({ refusal: expect.stringContaining("hired 1 agent,") })
  })

  it("asks the person instead of paying past the per-run cap", async () => {
    const { deps, run, events, hire } = setup({ budget: { perRunMicro: 20_000, perDayMicro: 500_000, hardDayMicro: 2_000_000 } })
    await sendHandoff(deps, run, from, "research", { task: "a" })
    await sendHandoff(deps, run, from, "critic", { task: "b" })
    const outcome = await sendHandoff(deps, run, from, "writer", { task: "c" })

    expect(outcome).toMatchObject({ ok: false, approval: { runId: "run-1", toId: "writer", amountMicro: 10_000, reason: "run" } })
    expect((outcome as { refusal: string }).refusal).toContain("waiting for the person's approval")
    expect(hire).toHaveBeenCalledTimes(2)
    expect(run.approvalPending).toBe(true)
    expect(run.hops).toBe(2)
    const approval = events.find((event) => event.type === "approval")
    expect(approval).toMatchObject({ type: "approval", runId: "run-1", fromName: "Supervisor", toName: "Redactor", amount: "0.01", reason: "run", capUsdc: "0.02" })
    expect(deps.approvals?.verify((approval as { token: string }).token, "run-1", OWNER, day.getTime()).ok).toBe(true)
    expect(deps.approvals?.verify((approval as { token: string }).token, "run-1", "d".repeat(32), day.getTime()).ok).toBe(false)
  })

  it("holds the per-run cap when the model asks for several hires at the same time", async () => {
    // Seen in a real browser run: two parallel tool calls each saw 0 spent and both paid past a 0.01 cap.
    const { deps, run, events, hire } = setup({ budget: { perRunMicro: 10_000, perDayMicro: 500_000, hardDayMicro: 2_000_000 } })
    const outcomes = await Promise.all([
      sendHandoff(deps, run, from, "research", { task: "a" }),
      sendHandoff(deps, run, from, "critic", { task: "b" }),
    ])
    expect(outcomes[0]).toMatchObject({ ok: true })
    expect(outcomes[1]).toMatchObject({ ok: false, approval: { toId: "critic", reason: "run" } })
    expect(hire).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ hops: 1, spentMicro: 10_000 })
    expect(events.filter((event) => event.type === "approval")).toHaveLength(1)
  })

  it("frees the held amount when a parallel hire is not paid", async () => {
    let calls = 0
    const hire = vi.fn(async (agent: RosterAgent): Promise<HopResult> => (++calls === 1
      ? { ok: false, error: "the agent's endpoint did not accept the payment" }
      : { ok: true, answer: `answer from ${agent.name}`, receipt: receipt(calls) }))
    const { deps, run } = setup({ hire, budget: { perRunMicro: 10_000, perDayMicro: 500_000, hardDayMicro: 2_000_000 } })
    expect(await sendHandoff(deps, run, from, "research", { task: "a" })).toMatchObject({ ok: false, refusal: expect.stringContaining("did not go through") })
    expect(run.spentMicro).toBe(0)
    expect(await sendHandoff(deps, run, from, "critic", { task: "b" })).toMatchObject({ ok: true })
    expect(run.spentMicro).toBe(10_000)
  })

  it("asks the person when today's budget is spent", async () => {
    const { deps, run, events, store } = setup({ budget: { perRunMicro: 50_000, perDayMicro: 10_000, hardDayMicro: 2_000_000 } })
    await store.incr(`orchestrator:spend:${OWNER}:2026-10-01`, 60)
    const outcome = await sendHandoff(deps, run, from, "research", { task: "a" })
    expect(outcome).toMatchObject({ ok: false, approval: { reason: "day" } })
    expect((outcome as { refusal: string }).refusal).toContain("daily spending cap of 0.01 USDC")
    expect(events.at(-1)).toMatchObject({ type: "approval", reason: "day", capUsdc: "0.01" })
    expect(await spentToday(store, OWNER, day)).toBe(10_000)
  })

  it("refuses over the cap when approvals are unavailable", async () => {
    const { deps, run } = setup({ approvals: null, budget: { perRunMicro: 0, perDayMicro: 500_000, hardDayMicro: 2_000_000 } })
    expect(await sendHandoff(deps, run, from, "research", { task: "a" })).toEqual({ ok: false, refusal: "Hiring Investigador would go over the agents' wallet per-conversation spending cap of 0 USDC, and approvals are not available here. Answer with what you have." })
    expect(run.approvalPending).toBe(false)
  })

  it("fails closed when the ledger cannot be read", async () => {
    const broken: KvStore = { ...createMemoryStore(), incr: async () => { throw new Error("KV down") } }
    const { deps, run, hire } = setup({ store: broken })
    expect(await sendHandoff(deps, run, from, "research", { task: "a" })).toMatchObject({ ok: false, refusal: expect.stringContaining("ledger could not be checked") })
    expect(hire).not.toHaveBeenCalled()
    expect(run.hops).toBe(0)
  })

  it("gives the budget back when the payment did not go through", async () => {
    const hire = vi.fn(async (): Promise<HopResult> => ({ ok: false, error: "the agent's endpoint did not accept the payment" }))
    const { deps, run, store, events } = setup({ hire })
    const outcome = await sendHandoff(deps, run, from, "research", { task: "a" })
    expect(outcome).toEqual({ ok: false, refusal: "Hiring Investigador did not go through: the agent's endpoint did not accept the payment. Nothing was charged. Answer with what you have, or ask the person." })
    expect(await spentToday(store, OWNER, day)).toBe(0)
    expect(run).toMatchObject({ hops: 0, spentMicro: 0 })
    expect(events).toEqual([])
    // The same ask can be tried again, since nothing was paid.
    expect(await sendHandoff(deps, run, from, "research", { task: "a" })).toMatchObject({ ok: false, refusal: expect.stringContaining("did not go through") })
    expect(hire).toHaveBeenCalledTimes(2)
  })

  it("treats a success without a receipt as unpaid", async () => {
    const { deps, run } = setup({ hire: vi.fn(async () => ({ ok: true, answer: "x" }) as unknown as HopResult) })
    expect(await sendHandoff(deps, run, from, "research", { task: "a" })).toMatchObject({ ok: false, refusal: expect.stringContaining("no payment receipt came back") })
  })

  it("keeps the receipt when the agent was paid but could not finish", async () => {
    const hire = vi.fn(async (): Promise<HopResult> => ({ ok: false, error: "OpenRouter rejected the request (HTTP 401).", receipt: receipt(9) }))
    const { deps, run, events, store } = setup({ hire })
    const outcome = await sendHandoff(deps, run, from, "research", { task: "a" })
    expect(outcome).toEqual({
      ok: false,
      paid: { toName: "Investigador", receipt: receipt(9) },
      refusal: "Hired Investigador, paid 0.01 USDC (tx Sig9) but it could not finish: OpenRouter rejected the request (HTTP 401). Tell the person, and answer with what you have.",
    })
    expect(events).toEqual([expect.objectContaining({ type: "handoff", receipt: receipt(9) })])
    expect(run.spentMicro).toBe(10_000)
    expect(await spentToday(store, OWNER, day)).toBe(10_000)
  })
})

describe("executeApprovedHandoff", () => {
  const signer = createApprovalSigner(key)
  const payload = signer.issue({ runId: "run-1", owner: OWNER, fromId: "orchestrator", fromName: "Supervisor", toId: "writer", toName: "Redactor", task: "Write it", amountMicro: 10_000, reason: "run" }).payload

  it("pays past the per-run and daily caps once the person approved", async () => {
    const { deps, run, hire, events } = setup({ budget: { perRunMicro: 0, perDayMicro: 0, hardDayMicro: 2_000_000 } })
    const outcome = await executeApprovedHandoff(deps, run, payload)
    expect(outcome).toMatchObject({ ok: true, toName: "Redactor" })
    expect(hire).toHaveBeenCalledWith(roster[2], "Write it")
    expect(events[0]).toMatchObject({ type: "handoff", fromName: "Supervisor", toName: "Redactor" })
    expect(run.spentMicro).toBe(10_000)
  })

  it("still stops at the hard daily ceiling", async () => {
    const { deps, run, hire } = setup({ budget: { perRunMicro: 0, perDayMicro: 0, hardDayMicro: 0 } })
    expect(await executeApprovedHandoff(deps, run, payload)).toMatchObject({ ok: false, refusal: expect.stringContaining("hard daily limit of 0 USDC") })
    expect(hire).not.toHaveBeenCalled()
  })

  it("refuses when the agent left, hiring is off, or the ledger is down", async () => {
    const gone = setup({ roster: roster.slice(0, 2) })
    expect(await executeApprovedHandoff(gone.deps, gone.run, payload)).toEqual({ ok: false, refusal: "Redactor is no longer on this team, so nothing was paid." })
    const off = setup({ hire: null })
    expect(await executeApprovedHandoff(off.deps, off.run, payload)).toMatchObject({ ok: false, refusal: expect.stringContaining("switched off") })
    const down = setup({ store: { ...createMemoryStore(), incr: async () => { throw new Error("down") } } })
    expect(await executeApprovedHandoff(down.deps, down.run, payload)).toMatchObject({ ok: false, refusal: expect.stringContaining("ledger") })
  })

  it("gives the reservation back when the approved payment fails", async () => {
    const { deps, run, store } = setup({ hire: vi.fn(async (): Promise<HopResult> => ({ ok: false, error: "facilitator down" })) })
    expect(await executeApprovedHandoff(deps, run, payload)).toMatchObject({ ok: false, refusal: expect.stringContaining("Nothing was charged") })
    expect(await spentToday(store, OWNER, day)).toBe(0)
    expect(run).toMatchObject({ hops: 0, spentMicro: 0 })
  })
})

describe("handoffTool", () => {
  const callOptions = (id: string) => ({ toolCallId: id, messages: [] }) as never

  it("is withheld at the depth cap, with fan-out off, or with nobody to hire", () => {
    const { deps, run } = setup()
    expect(handoffTool(deps, run, from)).not.toBeNull()
    expect(handoffTool(deps, run, { ...from, depth: 2 })).toBeNull()
    expect(handoffTool({ ...deps, caps: { maxDepth: 2, maxPerRun: 0 } }, run, from)).toBeNull()
    expect(handoffTool({ ...deps, caps: { maxDepth: 0, maxPerRun: 4 } }, run, from)).toBeNull()
    expect(handoffTool({ ...deps, roster: [roster[0]] }, run, { ...from, id: "research" })).toBeNull()
  })

  it("returns the answer or the refusal as text and reports the outcome", async () => {
    const { deps, run } = setup()
    const seen: Array<[string, HandoffOutcome]> = []
    const hireTool = handoffTool(deps, run, from, (id, outcome) => seen.push([id, outcome]))!
    const answer = await hireTool.execute!({ agent: "research", task: "Find options", constraints: "devnet" }, callOptions("c1"))
    const refusal = await hireTool.execute!({ agent: "ghost", task: "x" }, callOptions("c2"))

    expect(answer).toContain("Investigador answered")
    expect(refusal).toBe('There is no agent called "ghost" on this team.')
    expect(seen.map(([id, outcome]) => [id, outcome.ok])).toEqual([["c1", true], ["c2", false]])
  })

  it("turns an unexpected error into a sentence", async () => {
    const throwing = setup({ hire: vi.fn(async () => { throw new Error("bug") }) })
    expect(await handoffTool(throwing.deps, throwing.run, from)!.execute!({ agent: "research", task: "x" }, callOptions("c1")))
      .toBe("Hiring Investigador did not go through: bug. Nothing was charged. Answer with what you have, or ask the person.")
    const odd = setup({ hire: vi.fn(async () => { throw "odd" }) })
    expect(await handoffTool(odd.deps, odd.run, from)!.execute!({ agent: "research", task: "x" }, callOptions("c1"))).toContain("unexpected error")

    const { deps, run } = setup({ emit: () => { throw new Error("stream closed") } })
    expect(await handoffTool(deps, run, from)!.execute!({ agent: "research", task: "x" }, callOptions("c1"))).toBe("That hire did not go through because of an internal error. Answer with what you have.")
  })
})
