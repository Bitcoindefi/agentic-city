"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft, ExternalLink, Fingerprint, Handshake, Radio, ReceiptText, Star, X } from "lucide-react"
import type { ReceiptRecord, ReceiptType } from "@/lib/receipts/log"
import type { AgentOption, ReceiptTotals } from "@/lib/receipts/query"

// Public receipts explorer: every x402 payment, agent-to-agent hire and 8004 registration or
// review on Solana devnet, each with its transaction. Polls /api/receipts every 10 seconds.

const POLL_MS = 10_000
const PAGE_SIZE = 25

type Payload = {
  ok: boolean
  receipts: ReceiptRecord[]
  page: number
  totalPages: number
  total: number
  totals: ReceiptTotals
  agents: AgentOption[]
  sources: { app: number; onchain: number; onchainPending: number; onchainError: boolean; logError: boolean }
  updatedAt: string
}

type TypeFilter = ReceiptType | "all"

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "payment", label: "Pagos" },
  { value: "hire", label: "Contrataciones" },
  { value: "registration", label: "Registros 8004" },
  { value: "review", label: "Reseñas" },
]

const BADGES: Record<ReceiptType, { label: string; className: string; Icon: typeof ReceiptText }> = {
  payment: { label: "Pago x402", className: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200", Icon: ReceiptText },
  hire: { label: "Contratación", className: "border-violet-300/30 bg-violet-300/10 text-violet-200", Icon: Handshake },
  registration: { label: "Registro 8004", className: "border-cyan-300/30 bg-cyan-300/10 text-cyan-200", Icon: Fingerprint },
  review: { label: "Reseña 8004", className: "border-amber-300/30 bg-amber-300/10 text-amber-200", Icon: Star },
}

function isTypeFilter(value: string): value is TypeFilter {
  return TYPE_FILTERS.some((item) => item.value === value)
}

function txUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`
}

function addressUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`
}

function shortTx(signature: string): string {
  return signature.length <= 14 ? signature : `${signature.slice(0, 6)}…${signature.slice(-6)}`
}

function usdc(amount: string | null): string | null {
  if (!amount) return null
  const value = Number(amount) / 1_000_000
  return `${value.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`
}

function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return "recién"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  return `hace ${days} d`
}

export function ReceiptsExplorer({ initialAgent = "", initialType = "" }: { initialAgent?: string; initialType?: string }) {
  const [type, setType] = useState<TypeFilter>(isTypeFilter(initialType) ? initialType : "all")
  const [agent, setAgent] = useState(initialAgent)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now())
  const request = useRef(0)

  const load = useCallback(async () => {
    const id = ++request.current
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (type !== "all") params.set("type", type)
    if (agent) params.set("agent", agent)
    try {
      const response = await fetch(`/api/receipts?${params}`, { cache: "no-store" })
      const next = await response.json() as Payload
      if (id !== request.current) return
      if (!response.ok || !next.ok) throw new Error(`HTTP ${response.status}`)
      setData(next)
      setError("")
    } catch {
      if (id === request.current) setError("No pudimos actualizar los recibos. Reintentamos en unos segundos.")
    } finally {
      if (id === request.current) setNow(Date.now())
    }
  }, [agent, page, type])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // Keep the filters in the address, so a filtered view can be shared.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (agent) url.searchParams.set("agent", agent)
    else url.searchParams.delete("agent")
    if (type !== "all") url.searchParams.set("type", type)
    else url.searchParams.delete("type")
    window.history.replaceState(null, "", `${url.pathname}${url.search}`)
  }, [agent, type])

  const chooseType = (value: TypeFilter) => {
    setType(value)
    setPage(1)
  }
  const chooseAgent = (value: string) => {
    setAgent(value)
    setPage(1)
  }

  const totals = data?.totals
  const agentLabel = agent ? data?.agents.find((item) => item.id.toLowerCase() === agent.toLowerCase())?.name ?? agent : ""
  const agentInList = !agent || Boolean(data?.agents.some((item) => item.id.toLowerCase() === agent.toLowerCase()))

  return (
    <div className="min-w-0 space-y-5">
      <header className="space-y-3">
        <Link href="/" className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-400 hover:text-cyan-200">
          <ArrowLeft className="h-3.5 w-3.5" /> Volver a la ciudad
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-emerald-200">
            <Radio className="h-3 w-3 animate-pulse" /> En vivo
          </span>
          <span className="rounded-full border border-slate-700 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">Solana devnet</span>
        </div>
        <h1 className="font-mono text-2xl font-bold uppercase text-cyan-100 sm:text-3xl">Recibos en cadena</h1>
        <p className="max-w-3xl text-sm leading-6 text-slate-400">
          Cada pago x402 a un agente, cada contratación entre agentes y cada registro o reseña en el registro 8004 queda en Solana devnet.
          Acá los ves todos, con el enlace a su transacción para que lo verifiques vos.
        </p>
      </header>

      <section aria-label="Totales" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Pagos x402" value={totals ? totals.payments.toLocaleString("es-AR") : "-"} />
        <Stat label="Volumen" value={totals ? `${totals.volumeUsdc.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC` : "-"} />
        <Stat label="Contrataciones" value={totals ? totals.hires.toLocaleString("es-AR") : "-"} />
        <Stat label="Reseñas" value={totals ? totals.reviews.toLocaleString("es-AR") : "-"} />
        <Stat label="Agentes registrados" value={totals ? totals.registrations.toLocaleString("es-AR") : "-"} />
        <Stat label="Pagadores únicos" value={totals ? totals.uniquePayers.toLocaleString("es-AR") : "-"} />
      </section>

      <section aria-label="Filtros" className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/80 p-3 sm:p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de recibo">
          {TYPE_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={type === item.value}
              onClick={() => chooseType(item.value)}
              className={`min-h-9 rounded-full border px-3 font-mono text-[11px] uppercase tracking-wider transition ${type === item.value ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100" : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Agente</span>
            <select
              value={agentInList ? agent : ""}
              onChange={(event) => chooseAgent(event.target.value)}
              className="min-h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 font-mono text-sm text-slate-100 outline-none focus:border-cyan-400"
            >
              <option value="">Todos los agentes</option>
              {!agentInList ? <option value="">{agent}</option> : null}
              {data?.agents.map((item) => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} (${item.id})`}</option>)}
            </select>
          </label>
          {agent ? (
            <button type="button" onClick={() => chooseAgent("")} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 font-mono text-[11px] uppercase tracking-wider text-slate-300 hover:border-slate-500">
              <X className="h-3.5 w-3.5" /> Quitar filtro
            </button>
          ) : null}
        </div>
        {agent ? <p className="font-mono text-[11px] text-slate-400">Mostrando lo de <span className="text-cyan-200">{agentLabel}</span>. Los totales de arriba son de este agente.</p> : null}
      </section>

      {error ? <p role="alert" className="rounded-lg border border-rose-300/20 bg-rose-300/5 px-3 py-2 text-xs text-rose-200">{error}</p> : null}

      <section aria-label="Recibos" aria-live="polite" className="rounded-2xl border border-slate-800 bg-slate-950/80">
        {!data ? (
          <p className="px-4 py-10 text-center font-mono text-sm text-slate-500">Leyendo recibos de Solana devnet…</p>
        ) : data.receipts.length === 0 ? (
          <p className="px-4 py-10 text-center font-mono text-sm text-slate-500">Todavía no hay recibos con estos filtros.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {data.receipts.map((record) => <ReceiptRow key={record.id} record={record} now={now} onAgent={chooseAgent} />)}
          </ul>
        )}
      </section>

      {data && data.totalPages > 1 ? (
        <nav aria-label="Páginas" className="flex items-center justify-between gap-2 font-mono text-[11px] text-slate-400">
          <button type="button" disabled={data.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="min-h-10 rounded-lg border border-slate-700 px-3 uppercase tracking-wider disabled:opacity-40">Anterior</button>
          <span>Página {data.page} de {data.totalPages}</span>
          <button type="button" disabled={data.page >= data.totalPages} onClick={() => setPage((value) => value + 1)} className="min-h-10 rounded-lg border border-slate-700 px-3 uppercase tracking-wider disabled:opacity-40">Siguiente</button>
        </nav>
      ) : null}

      {data ? (
        <footer className="space-y-1 font-mono text-[11px] leading-5 text-slate-500">
          <p>
            {data.total.toLocaleString("es-AR")} recibo{data.total === 1 ? "" : "s"} · {data.sources.app} del registro de la app · {data.sources.onchain} leído{data.sources.onchain === 1 ? "" : "s"} de la cadena
            {data.sources.onchainPending > 0 ? ` · ${data.sources.onchainPending} transacciones por leer` : ""}
            {" · "}actualizado {timeAgo(Date.parse(data.updatedAt), now)}
          </p>
          <p>Los mismos datos, en JSON: <a href="/api/receipts" className="text-cyan-300 underline">/api/receipts</a> (filtros <code>type</code>, <code>agent</code>, <code>page</code>).</p>
        </footer>
      ) : null}
    </div>
  )
}

function AgentButton({ id, name, onAgent }: { id: string | null; name: string | null; onAgent: (agent: string) => void }) {
  const label = name ?? id
  if (!label) return <span className="text-slate-400">un agente</span>
  return (
    <button type="button" onClick={() => onAgent(id ?? label)} className="max-w-full truncate align-bottom font-semibold text-cyan-100 underline decoration-cyan-300/30 underline-offset-2 hover:decoration-cyan-200" title={`Ver los recibos de ${label}`}>
      {label}
    </button>
  )
}

function ReceiptRow({ record, now, onAgent }: { record: ReceiptRecord; now: number; onAgent: (agent: string) => void }) {
  const badge = BADGES[record.type]
  const amount = usdc(record.amount)
  const agent = <AgentButton id={record.agentId} name={record.agentName} onAgent={onAgent} />

  let summary: ReactNode
  if (record.type === "hire") {
    summary = <><AgentButton id={record.counterpartId} name={record.counterpartName} onAgent={onAgent} /> contrató a {agent}</>
  } else if (record.type === "registration") {
    summary = record.agentId || record.agentName ? <>Identidad de {agent} en el registro 8004</> : <>Nueva identidad de agente en el registro 8004</>
  } else if (record.type === "review") {
    summary = record.agentId || record.agentName ? <>Reseña para {agent}</> : <>Reseña de un trabajo pagado con x402</>
  } else {
    summary = record.agentId || record.agentName ? <>Pago por una tarea de {agent}</> : <>Pago por una tarea de un agente</>
  }

  const details: string[] = []
  if (amount) details.push(amount)
  if (record.type === "review" && record.score !== null) details.push(`${record.score}/100`)
  if (record.payer) details.push(record.type === "hire" ? `billetera ${record.payer}` : record.type === "review" ? `de ${record.payer}` : `pagó ${record.payer}`)
  if (record.type === "registration") details.push("pagó la tesorería")

  return (
    <li className="flex min-w-0 flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
      <span className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${badge.className}`}>
        <badge.Icon className="h-3 w-3" /> {badge.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-sm text-slate-200">{summary}</p>
        <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-slate-400">
          {details.map((item) => <span key={item}>{item}</span>)}
          <span title={new Date(record.timestamp).toLocaleString("es-AR")}>{timeAgo(record.timestamp, now)}</span>
          {record.source === "on-chain" ? <span className="text-slate-500">leído de la cadena</span> : null}
          {record.identity ? <a href={addressUrl(record.identity)} target="_blank" rel="noreferrer" className="text-cyan-300/80 underline">identidad {shortTx(record.identity)}</a> : null}
        </p>
      </div>
      <a href={txUrl(record.tx)} target="_blank" rel="noreferrer" className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-lg border border-cyan-700/60 px-2.5 py-1.5 font-mono text-[11px] text-cyan-200 transition hover:border-cyan-400 hover:text-cyan-100" aria-label={`Ver la transacción ${record.tx} en Solana Explorer`}>
        tx {shortTx(record.tx)} <ExternalLink className="h-3 w-3" />
      </a>
    </li>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-800 bg-slate-950/80 p-3 sm:p-4">
      <div className="truncate text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</div>
      <div className="mt-1.5 truncate font-mono text-lg text-cyan-200 sm:text-xl">{value}</div>
    </div>
  )
}
