"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { AgentsRegistry } from "@/components/agents-registry"
import type { AgentCapabilityManifest, CapabilityCount } from "@/lib/agent-registry"

export default function RegistryPage() {
  const [agents, setAgents] = useState<AgentCapabilityManifest[]>([])
  const [capabilities, setCapabilities] = useState<CapabilityCount[]>([])
  const [filter, setFilter] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch("/api/registry").then((r) => r.json()),
      fetch("/api/registry/capabilities").then((r) => r.json()),
    ]).then(([agentData, capData]) => {
      setAgents(agentData.agents ?? [])
      setCapabilities(capData.capabilities ?? [])
      setLoading(false)
    })
  }, [])

  const selectCapability = useCallback((cap: string) => {
    setFilter((prev) => (prev.toLowerCase() === cap.toLowerCase() ? "" : cap))
  }, [])

  const filtered = filter.trim()
    ? agents.filter((a) =>
        a.capabilities.some((c) => c.toLowerCase().includes(filter.trim().toLowerCase()))
      )
    : agents

  const topCapabilities = capabilities.slice(0, 12)

  return (
    <main className="min-h-screen bg-[#030712] px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <Link
          href="/"
          className="w-fit rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 transition hover:border-cyan-300/60"
        >
          Back to city
        </Link>

        <header className="rounded-2xl border border-slate-800 bg-slate-950/80 p-5">
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-cyan-300">Discovery</p>
          <h1 className="mt-3 font-pixel text-3xl uppercase text-slate-100">Agent Registry</h1>
          <p className="mt-3 max-w-3xl font-mono text-sm leading-7 text-slate-400">
            Browse all registered agents and filter by capability tag.
          </p>
        </header>

        {/* Search bar */}
        <div className="relative">
          <Input
            type="search"
            placeholder="Filter by capability (e.g. payment, analytics)…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-slate-950/80 border-slate-700 font-mono text-sm text-slate-200 placeholder:text-slate-500 focus-visible:border-cyan-500"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400 hover:text-slate-200"
              aria-label="Clear filter"
            >
              ✕
            </button>
          )}
        </div>

        {/* Tag cloud */}
        {topCapabilities.length > 0 && (
          <section aria-label="Popular capabilities">
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-slate-400">
              Popular capabilities
            </p>
            <div className="flex flex-wrap gap-2">
              {topCapabilities.map(({ capability, count }) => {
                const active = filter.toLowerCase() === capability.toLowerCase()
                return (
                  <button
                    key={capability}
                    onClick={() => selectCapability(capability)}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs transition ${
                      active
                        ? "border-cyan-400 bg-cyan-400/20 text-cyan-200"
                        : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                    }`}
                  >
                    {capability}
                    <span className={`rounded-full px-1 text-[10px] ${active ? "bg-cyan-500/30 text-cyan-300" : "bg-slate-800 text-slate-500"}`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {/* Agent list */}
        {loading ? (
          <div className="py-16 text-center font-mono text-sm text-slate-500">Loading registry…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 py-16 text-center">
            <p className="font-mono text-sm text-slate-500">No agents match this capability.</p>
            {filter && (
              <button
                onClick={() => setFilter("")}
                className="mt-4 font-mono text-xs text-cyan-400 hover:underline"
              >
                Clear filter
              </button>
            )}
          </div>
        ) : (
          <section>
            <p className="mb-3 font-mono text-xs text-slate-500">
              {filtered.length} agent{filtered.length !== 1 ? "s" : ""}
              {filter ? ` matching "${filter}"` : ""}
            </p>
            <AgentsRegistry agents={filtered} filter={filter} />
          </section>
        )}
      </div>
    </main>
  )
}
