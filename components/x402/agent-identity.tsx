"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { UiWalletAccount } from "@wallet-standard/react"
import { useSignAndSendTransaction } from "@solana/react"
import { getBase58Decoder } from "@solana/kit"
import { BadgeCheck, ExternalLink, Fingerprint, ReceiptText } from "lucide-react"
import { reviewTransactionProblem, type TreasuryKeys } from "@/lib/solana/client-guards"
import { friendlyProviderError } from "@/lib/ai/friendly-error"
import { pollUntil } from "@/lib/poll-until"

type Identity = { asset: string; registered: boolean; explorerUrl: string; reputation: { averageScore: number; totalFeedbacks: number } | null }

export function AgentIdentityRow({ agent, refreshKey, onTreasury }: { agent: { id: string; name: string; role: string; model: string }; refreshKey: number; onTreasury?: (treasury: TreasuryKeys) => void }) {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "registering" | "unavailable">("loading")
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const identityRef = useRef<Identity | null>(null)
  const onTreasuryRef = useRef(onTreasury)
  useEffect(() => { onTreasuryRef.current = onTreasury }, [onTreasury])

  /** One read of the agent's 8004 identity. Null when it could not be read. */
  const fetchIdentity = useCallback(async (): Promise<{ identity: Identity } | { error: string } | null> => {
    try {
      const response = await fetch(`/api/8004/agents/${encodeURIComponent(agent.id)}`, { cache: "no-store" })
      const data = await response.json() as Identity & { ok?: boolean; error?: string; treasury?: TreasuryKeys }
      if (data.treasury) onTreasuryRef.current?.(data.treasury)
      if (!response.ok || !data.ok) return { error: data.error ?? "" }
      return { identity: data }
    } catch {
      return null
    }
  }, [agent.id])

  const showIdentity = useCallback((next: Identity) => {
    identityRef.current = next
    setIdentity(next)
  }, [])

  const load = useCallback(async () => {
    setState("loading")
    const result = await fetchIdentity()
    if (result && "identity" in result) {
      showIdentity(result.identity)
      setState("ready")
      return
    }
    setState("unavailable")
    if (result) setError(friendlyProviderError(result.error))
  }, [fetchIdentity, showIdentity])

  useEffect(() => { void load() }, [load])

  // After a review, the 8004 indexer takes some seconds (about 30) to count it: keep asking every
  // 5 seconds for up to a minute until the review count goes up, instead of reading once too early.
  useEffect(() => {
    if (refreshKey === 0) return
    let cancelled = false
    const before = identityRef.current?.reputation?.totalFeedbacks ?? 0
    setRefreshing(true)
    void pollUntil(async () => {
      const result = await fetchIdentity()
      if (!result || !("identity" in result) || cancelled) return null
      showIdentity(result.identity)
      return (result.identity.reputation?.totalFeedbacks ?? 0) > before ? result.identity : null
    }, { intervalMs: 5_000, timeoutMs: 60_000, isCancelled: () => cancelled }).finally(() => {
      if (!cancelled) setRefreshing(false)
    })
    return () => { cancelled = true }
  }, [refreshKey, fetchIdentity, showIdentity])

  const register = async () => {
    setState("registering")
    setError("")
    try {
      const response = await fetch(`/api/8004/agents/${encodeURIComponent(agent.id)}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agent.name, role: agent.role, model: agent.model }),
      })
      const data = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo registrar.")
      await load()
    } catch (registerError) {
      setError(registerError instanceof Error ? friendlyProviderError(registerError.message) : "No se pudo registrar.")
      setState("ready")
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-[#050a12] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[11px] text-slate-300"><Fingerprint className="h-3.5 w-3.5 text-cyan-200" /> Identidad 8004</p>
        {state === "loading" ? <span className="text-[11px] text-slate-500">Consultando…</span>
          : state === "unavailable" ? <span className="text-[11px] text-slate-500">No disponible</span>
          : identity?.registered ? <a href={identity.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-emerald-200 underline"><BadgeCheck className="h-3.5 w-3.5" /> Registrada <ExternalLink className="h-3 w-3" /></a>
          : <button type="button" onClick={() => void register()} disabled={state === "registering"} className="rounded-lg border border-cyan-300/30 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-cyan-100 disabled:opacity-50">{state === "registering" ? "Registrando…" : "Registrar"}</button>}
      </div>
      {identity?.registered ? <p className="mt-1 font-mono text-[11px] text-slate-500">{identity.reputation && identity.reputation.totalFeedbacks > 0 ? `Reputación ${Math.round(identity.reputation.averageScore)}/100 · ${identity.reputation.totalFeedbacks} reseña${identity.reputation.totalFeedbacks === 1 ? "" : "s"}` : "Sin reseñas todavía"}</p> : null}
      <a href={`/explorer?agent=${encodeURIComponent(agent.id)}`} className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-cyan-200/80 underline">Ver sus recibos en cadena <ReceiptText className="h-3 w-3" /></a>
      {refreshing ? <p role="status" className="mt-1 font-mono text-[11px] text-cyan-200/80">Actualizando reputación…</p> : null}
      {error ? <p role="alert" className="mt-1 text-[11px] text-rose-200">{error}</p> : null}
    </div>
  )
}

export function ReviewAfterPayment({ account, agentId, paymentSignature, feePayer, onReviewed }: { account: UiWalletAccount; agentId: string; paymentSignature: string; feePayer: string | null; onReviewed: () => void }) {
  const signAndSend = useSignAndSendTransaction(account, "solana:devnet")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState("")

  const review = async (score: number) => {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(`/api/8004/agents/${encodeURIComponent(agentId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score, paymentSignature, payer: account.address }),
      })
      const data = await response.json() as { ok?: boolean; error?: string; transaction?: string }
      if (!response.ok || !data.ok || !data.transaction) throw new Error(data.error || "No se pudo preparar la reseña.")
      const bytes = Uint8Array.from(atob(data.transaction), (char) => char.charCodeAt(0))
      // Only sign what we expect: an 8004 review (plus compute budget) paid by the treasury.
      const problem = reviewTransactionProblem(bytes, feePayer)
      if (problem) throw new Error(`La transacción de reseña no es la esperada (${problem}). No la firmes.`)
      const { signature } = await signAndSend({ transaction: bytes })
      const sent = getBase58Decoder().decode(signature)
      setDone(sent)
      onReviewed()
      // Tell the server it was sent, so the public receipts explorer lists it once confirmed.
      // Best-effort: the review is already on-chain either way.
      void fetch(`/api/8004/agents/${encodeURIComponent(agentId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewSignature: sent }),
        keepalive: true,
      }).catch(() => undefined)
    } catch (reviewError) {
      setError(reviewError instanceof Error ? friendlyProviderError(reviewError.message) : "No se pudo enviar la reseña.")
    } finally {
      setBusy(false)
    }
  }

  if (done) return <a href={`https://explorer.solana.com/tx/${done}?cluster=devnet`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-[11px] text-cyan-200 underline">Reseña registrada en 8004 <ExternalLink className="h-3 w-3" /></a>

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-400">¿Cómo lo hizo? Tu reseña queda en su reputación 8004, con este pago como prueba.</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void review(100)} className="min-h-11 rounded-lg border border-emerald-300/30 px-3 text-[11px] uppercase tracking-wider text-emerald-100 disabled:opacity-50">Bien</button>
        <button type="button" disabled={busy} onClick={() => void review(50)} className="min-h-11 rounded-lg border border-slate-600 px-3 text-[11px] uppercase tracking-wider text-slate-200 disabled:opacity-50">Regular</button>
        <button type="button" disabled={busy} onClick={() => void review(10)} className="min-h-11 rounded-lg border border-rose-300/30 px-3 text-[11px] uppercase tracking-wider text-rose-100 disabled:opacity-50">Mal</button>
      </div>
      {error ? <p role="alert" className="text-[11px] text-rose-200">{error}</p> : null}
    </div>
  )
}
