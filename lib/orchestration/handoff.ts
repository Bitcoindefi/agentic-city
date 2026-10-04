import { tool, type Tool } from "ai"
import { z } from "zod"
import type { KvStore } from "@/lib/security/kv-store"
import { microToUsdc, releaseDaily, reserveDaily, type OrchestratorCaps } from "@/lib/orchestration/budget"
import type { ApprovalPayload, ApprovalReason, ApprovalSigner } from "@/lib/orchestration/approval"
import { shortSignature, type ChatStreamEvent } from "@/lib/orchestration/events"
import type { HireAgent, HopReceipt, HopResult } from "@/lib/orchestration/wallet"
import { recordReceipt } from "@/lib/receipts/log"

// One agent hiring another, paid from the browser's own agents' wallet.
//
// Adapted from CopilotKit/openbot (MIT), server/src/agents/handoff.ts and handoff-tool.ts:
//  - the tool takes typed fields (agent, task, constraints, expecting), not a paragraph, so the
//    hired agent does not have to guess the intent or the shape of the answer;
//  - a depth cap stops A -> B -> A loops and a per-run cap bounds fan-out; at the cap the tool is
//    withheld, so the model is not shown a tool whose every call would be refused;
//  - every refusal comes back as a sentence the agent can say, never as an exception, because the
//    asking agent is mid-run with a person waiting.
// Added here: each hop is a real x402 payment on Solana devnet, checked against spending caps,
// and a hop over the caps waits for the person's approval instead of paying.

export const HANDOFF_TOOL = "message_agent"

export type HandoffCaps = { maxDepth: number; maxPerRun: number }
export const DEFAULT_HANDOFF_CAPS: HandoffCaps = { maxDepth: 2, maxPerRun: 4 }

export type RosterAgent = HireAgent

export type HandoffEnvelope = { task: string; constraints?: string; expecting?: string }

export type RunState = {
  runId: string
  hops: number
  spentMicro: number
  asked: Set<string>
  receipts: HopReceipt[]
  /** Set when a hire is waiting on the person: the turn ends instead of taking another step. */
  approvalPending: boolean
  /** Set when the agents' wallet could not pay a hire: later hires in this run are refused at once. */
  walletEmpty: boolean
}

export type Hirer = { id: string; name: string; depth: number; turnId: string }

export type HandoffDeps = {
  roster: RosterAgent[]
  caps: HandoffCaps
  budget: OrchestratorCaps
  priceMicro: number
  store: KvStore
  /** The browser id: the daily ledger and approvals are per browser. */
  owner: string
  /** The browser's agents' wallet. Null when this server cannot keep one (no sealing secret). */
  wallet: { address: string } | null
  /** Pays (from the agents' wallet) and runs the hired agent. Null when hiring is unavailable. */
  hire: ((agent: RosterAgent, task: string) => Promise<HopResult>) | null
  approvals: ApprovalSigner | null
  emit: (event: ChatStreamEvent) => void
  newTurnId: (agentId: string) => string
  now?: () => Date
}

export type HandoffOutcome =
  | { ok: true; toName: string; answer: string; receipt: HopReceipt; text: string }
  | { ok: false; refusal: string; approval?: ApprovalPayload; paid?: { toName: string; receipt: HopReceipt } }

export function createRunState(runId: string): RunState {
  return { runId, hops: 0, spentMicro: 0, asked: new Set(), receipts: [], approvalPending: false, walletEmpty: false }
}

/** The message the hired agent receives: the task, then what bounds it and what to hand back. */
export function composeTask(envelope: HandoffEnvelope): string {
  const parts = [envelope.task.trim()]
  if (envelope.constraints?.trim()) parts.push(`Constraints: ${envelope.constraints.trim()}`)
  if (envelope.expecting?.trim()) parts.push(`What to return: ${envelope.expecting.trim()}`)
  return parts.join("\n\n")
}

export function resolveTarget(roster: RosterAgent[], wanted: string, fromId: string): { ok: true; agent: RosterAgent } | { ok: false; refusal: string } {
  const name = wanted.trim()
  const lowered = name.toLowerCase()
  // An id is exact and a name is not, so an id wins outright.
  const byId = roster.find((agent) => agent.id.toLowerCase() === lowered)
  const byName = roster.filter((agent) => agent.name.toLowerCase() === lowered)
  if (!byId && byName.length > 1) {
    return { ok: false, refusal: `More than one agent is called "${name.slice(0, 60)}": ${byName.map((agent) => agent.id).join(", ")}. Ask again using the id you mean.` }
  }
  const found = byId ?? byName[0]
  if (!found) return { ok: false, refusal: `There is no agent called "${name.slice(0, 60)}" on this team.` }
  if (found.id === fromId) return { ok: false, refusal: "An agent cannot hire itself. Do the work, or ask the person." }
  return { ok: true, agent: found }
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

function unfundedRefusal(agentName: string, balance: string | null, price: string): string {
  const holds = balance === null ? "does not hold enough" : `holds ${balance} USDC`
  return `Hiring ${agentName} costs ${price} USDC, but the person's agents' wallet ${holds}, so nothing was charged. ` +
    "Tell the person their agents' wallet needs funds and that the Fund button is right here in the chat (one wallet signature, devnet USDC). " +
    `Then answer with what you can do yourself; do not answer on ${agentName}'s behalf.`
}

const HIRING_OFF = "Hiring is switched off on this server (agents' wallets need BETTER_AUTH_SECRET to be set). Do the work yourself, or tell the person."

/**
 * Pays and runs one hire whose budget is already reserved; emits the receipt and the answer.
 * `rollback` undoes the reservation and the counters when no money moved.
 */
async function payAndRun(deps: HandoffDeps, run: RunState, from: Hirer, agent: RosterAgent, envelope: HandoffEnvelope, rollback: () => Promise<void>): Promise<HandoffOutcome> {
  const hire = deps.hire as NonNullable<HandoffDeps["hire"]>
  const amount = microToUsdc(deps.priceMicro)
  let result: HopResult
  try {
    result = await hire(agent, composeTask(envelope))
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : "unexpected error" }
  }

  if (!result.ok && result.code === "unfunded") {
    await rollback()
    run.walletEmpty = true
    const balance = microToUsdc(result.balanceMicro ?? 0)
    if (deps.wallet) deps.emit({ type: "wallet", status: "unfunded", address: deps.wallet.address, balanceUsdc: balance, neededUsdc: amount })
    return { ok: false, refusal: unfundedRefusal(agent.name, balance, amount) }
  }

  if (!result.receipt) {
    await rollback()
    const reason = result.ok ? "no payment receipt came back" : result.error.replace(/\.+$/, "")
    return { ok: false, refusal: `Hiring ${agent.name} did not go through: ${reason}. Nothing was charged. Answer with what you have, or ask the person.` }
  }

  // run.spentMicro already holds this hire: it was reserved before the first await.
  run.receipts.push(result.receipt)
  deps.emit({ type: "handoff", turnId: from.turnId, fromName: from.name, toName: agent.name, task: envelope.task.slice(0, 300), amount, receipt: result.receipt })
  // Public receipts log (best-effort, never throws): who hired whom and the payment, never the task.
  await recordReceipt({
    type: "hire",
    tx: result.receipt.transaction,
    amount: result.receipt.amount || String(deps.priceMicro),
    asset: result.receipt.asset,
    agentId: agent.id,
    agentName: agent.name,
    counterpartId: from.id,
    counterpartName: from.name,
    payer: result.receipt.payer ?? deps.wallet?.address ?? null,
  })

  if (!result.ok) {
    return {
      ok: false,
      paid: { toName: agent.name, receipt: result.receipt },
      refusal: `Hired ${agent.name}, paid ${amount} USDC (tx ${shortSignature(result.receipt.transaction)}) but it could not finish: ${result.error.replace(/\.+$/, "")}. Tell the person, and answer with what you have.`,
    }
  }

  const turnId = deps.newTurnId(agent.id)
  deps.emit({ type: "agent-start", turnId, agentId: agent.id, name: agent.name, model: agent.connection.model, depth: from.depth + 1, hiredBy: from.name })
  deps.emit({ type: "text", turnId, delta: result.answer })
  deps.emit({ type: "agent-end", turnId })

  return {
    ok: true,
    toName: agent.name,
    answer: result.answer,
    receipt: result.receipt,
    text: `${agent.name} answered (paid ${amount} USDC on Solana devnet, tx ${result.receipt.transaction}). The person can already read its answer, so do not repeat it; build on it:\n\n${result.answer.slice(0, 4000)}`,
  }
}

function requestApproval(deps: HandoffDeps, run: RunState, from: Hirer, agent: RosterAgent, envelope: HandoffEnvelope, reason: ApprovalReason): HandoffOutcome {
  const amount = microToUsdc(deps.priceMicro)
  const cap = reason === "run" ? deps.budget.perRunMicro : deps.budget.perDayMicro
  const capWords = reason === "run" ? "per-conversation" : "daily"
  if (!deps.approvals) {
    return { ok: false, refusal: `Hiring ${agent.name} would go over the agents' wallet ${capWords} spending cap of ${microToUsdc(cap)} USDC, and approvals are not available here. Answer with what you have.` }
  }
  const { token, payload } = deps.approvals.issue({
    runId: run.runId,
    owner: deps.owner,
    fromId: from.id,
    fromName: from.name,
    toId: agent.id,
    toName: agent.name,
    task: composeTask(envelope),
    amountMicro: deps.priceMicro,
    reason,
  }, deps.now?.().getTime())
  run.approvalPending = true
  deps.emit({ type: "approval", token, runId: run.runId, fromName: from.name, toName: agent.name, task: envelope.task.slice(0, 300), amount, reason, capUsdc: microToUsdc(cap), expiresAt: payload.exp })
  return {
    ok: false,
    approval: payload,
    refusal: `Hiring ${agent.name} costs ${amount} USDC and would go over the agents' wallet ${capWords} spending cap of ${microToUsdc(cap)} USDC, so it is waiting for the person's approval in the chat. Stop here: do not answer on ${agent.name}'s behalf.`,
  }
}

/**
 * Decides one hop and, when allowed, pays for it. The checks run in a fixed order and the
 * counters are taken before the first await, so several hires emitted in one step cannot all slip
 * under the per-run cap.
 */
export async function sendHandoff(deps: HandoffDeps, run: RunState, from: Hirer, target: string, envelope: HandoffEnvelope): Promise<HandoffOutcome> {
  const task = envelope.task?.trim() ?? ""
  if (!task) return { ok: false, refusal: "Nothing was sent: a hire has to say what the other agent is being asked to do." }

  // The depth cap first, because it is the one that stops a loop.
  if (from.depth >= deps.caps.maxDepth) {
    return { ok: false, refusal: deps.caps.maxDepth === 0
      ? "This team does not let one agent hire another."
      : `This is already ${plural(from.depth, "hire")} deep, which is as far as this team allows. Answer with what you have, or ask the person.` }
  }

  const resolved = resolveTarget(deps.roster, target ?? "", from.id)
  if (!resolved.ok) return resolved
  const agent = resolved.agent

  if (!deps.hire) return { ok: false, refusal: HIRING_OFF }
  if (run.walletEmpty) return { ok: false, refusal: unfundedRefusal(agent.name, null, microToUsdc(deps.priceMicro)) }

  const key = `${agent.id}\u0000${task}`
  if (run.asked.has(key)) return { ok: false, refusal: `You have already asked ${agent.name} exactly this in this conversation. Use that answer rather than paying again.` }
  if (run.hops >= deps.caps.maxPerRun) {
    return { ok: false, refusal: `This conversation has already hired ${plural(deps.caps.maxPerRun, "agent")}, which is as many as this team allows. Answer with what you have, or ask the person.` }
  }
  run.asked.add(key)
  run.hops += 1

  const normalized: HandoffEnvelope = { ...envelope, task }
  if (run.spentMicro + deps.priceMicro > deps.budget.perRunMicro) {
    run.hops -= 1
    return requestApproval(deps, run, from, agent, normalized, "run")
  }
  // Hold this hire's price against the per-run cap before the first await, like the hop count:
  // hires the model asks for in parallel each see the ones already in flight.
  run.spentMicro += deps.priceMicro

  let reservation: Awaited<ReturnType<typeof reserveDaily>>
  try {
    reservation = await reserveDaily(deps.store, deps.owner, deps.priceMicro, deps.budget.perDayMicro, deps.now?.())
  } catch {
    run.hops -= 1
    run.spentMicro -= deps.priceMicro
    run.asked.delete(key)
    return { ok: false, refusal: "The spending ledger could not be checked just now, so nothing was paid. Answer with what you have." }
  }
  if (!reservation.ok) {
    run.hops -= 1
    run.spentMicro -= deps.priceMicro
    return requestApproval(deps, run, from, agent, normalized, "day")
  }
  const held = reservation
  return payAndRun(deps, run, from, agent, normalized, async () => {
    run.hops -= 1
    run.spentMicro -= deps.priceMicro
    run.asked.delete(key)
    await releaseDaily(deps.store, held).catch(() => undefined)
  })
}

/**
 * Runs a hire the person approved. The token was verified and consumed by the caller; the per-run
 * and daily caps are lifted for this one hire, the hard daily ceiling is not.
 */
export async function executeApprovedHandoff(deps: HandoffDeps, run: RunState, payload: ApprovalPayload, hirerDepth = 0): Promise<HandoffOutcome> {
  const from: Hirer = { id: payload.fromId, name: payload.fromName, depth: hirerDepth, turnId: deps.newTurnId(payload.fromId) }
  const agent = deps.roster.find((item) => item.id === payload.toId)
  if (!agent || agent.id === payload.fromId) return { ok: false, refusal: `${payload.toName} is no longer on this team, so nothing was paid.` }
  if (!deps.hire) return { ok: false, refusal: HIRING_OFF }

  let reservation: Awaited<ReturnType<typeof reserveDaily>>
  try {
    reservation = await reserveDaily(deps.store, deps.owner, payload.amountMicro, deps.budget.hardDayMicro, deps.now?.())
  } catch {
    return { ok: false, refusal: "The spending ledger could not be checked just now, so nothing was paid." }
  }
  if (!reservation.ok) {
    return { ok: false, refusal: `The agents' wallet reached its hard daily limit of ${microToUsdc(deps.budget.hardDayMicro)} USDC, so even approved hires wait until tomorrow.` }
  }
  const held = reservation
  run.hops += 1
  run.spentMicro += payload.amountMicro
  return payAndRun({ ...deps, priceMicro: payload.amountMicro }, run, from, agent, { task: payload.task }, async () => {
    run.hops -= 1
    run.spentMicro -= payload.amountMicro
    await releaseDaily(deps.store, held).catch(() => undefined)
  })
}

const handoffInput = z.object({
  agent: z.string().describe("The id or name of the teammate to hire, as it appears in the roster"),
  task: z.string().describe("What you are asking that teammate to do, in a sentence or two"),
  constraints: z.string().optional().describe("Anything that bounds the work: scope, sources, a rule it must not break"),
  expecting: z.string().optional().describe("What a good answer looks like: a list, a number, a recommendation with reasons"),
})

export type HandoffInput = z.infer<typeof handoffInput>

/**
 * The tool, for a turn that may have it. Null at the depth cap, with fan-out switched off, or
 * with nobody else to hire: a tool the model can never use only invites a failed attempt.
 */
export function handoffTool(
  deps: HandoffDeps,
  run: RunState,
  from: Hirer,
  onOutcome?: (toolCallId: string, outcome: HandoffOutcome) => void,
): Tool<HandoffInput, string> | null {
  if (deps.caps.maxDepth <= 0 || deps.caps.maxPerRun <= 0) return null
  if (from.depth >= deps.caps.maxDepth) return null
  if (!deps.roster.some((agent) => agent.id !== from.id)) return null

  return tool({
    description:
      "Hire a teammate for a piece of work that needs their role, and get their answer back. " +
      `Each hire is a real payment of ${microToUsdc(deps.priceMicro)} USDC on Solana devnet from the person's agents' wallet, ` +
      "so hire only when their role is needed, ask each teammate once, and do the work yourself when it is yours. " +
      "If it needs the person's judgement rather than a teammate's, ask the person instead.",
    inputSchema: handoffInput,
    execute: async (input, options) => {
      let outcome: HandoffOutcome
      try {
        outcome = await sendHandoff(deps, run, from, input.agent, { task: input.task, constraints: input.constraints, expecting: input.expecting })
      } catch {
        // A refusal is an answer, not an error: the asking agent still has someone to talk to.
        outcome = { ok: false, refusal: "That hire did not go through because of an internal error. Answer with what you have." }
      }
      onOutcome?.(options.toolCallId, outcome)
      return outcome.ok ? outcome.text : outcome.refusal
    },
  })
}
