'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Copy, ExternalLink, Filter, Star, Zap } from 'lucide-react'
import { DISTRICTS } from '@/lib/data'
import { getDistrictName, type MarketplaceService, type ServiceCapability, type ServiceStatus } from '@/lib/marketplace/services'
import { STELLAR_ENABLED, formatAssetAmount } from '@/lib/config/chains'

const PRICE_CAPS = ['0.05', '0.10', '0.20', '0.25']

const CAPABILITIES: Array<ServiceCapability | 'all'> = ['all', 'data', 'comms', 'processing', 'defense', 'research']
const STATUSES: Array<ServiceStatus | 'all'> = ['all', 'online', 'offline']

const snippet = (serviceId: string) => `npm install @open-stellar/sdk

# .env
OPEN_STELLAR_SERVICE_ID=${serviceId}

import { OpenStellar } from '@open-stellar/sdk'
const stellar = new OpenStellar({ serviceId: process.env.OPEN_STELLAR_SERVICE_ID! })
const result = await stellar.services.call({ input: { query: 'hello' } })
console.log(result.data)`

export function MarketplaceCatalog({ services }: { services: MarketplaceService[] }) {
  const [district, setDistrict] = useState('all')
  const [capability, setCapability] = useState<ServiceCapability | 'all'>('all')
  const [status, setStatus] = useState<ServiceStatus | 'all'>('all')
  const [maxPrice, setMaxPrice] = useState('all')

  const filtered = useMemo(() => {
    return services.filter((service) => {
      if (district !== 'all' && service.district !== district) return false
      if (capability !== 'all' && !service.capabilityTags.includes(capability)) return false
      if (status !== 'all' && service.status !== status) return false
      if (maxPrice !== 'all' && service.priceXlm > Number(maxPrice)) return false
      return true
    })
  }, [capability, district, maxPrice, services, status])

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-4 shadow-2xl shadow-cyan-950/20">
        <div className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.28em] text-cyan-200">
          <Filter className="h-4 w-4" /> Filters
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <FilterSelect label="District" value={district} onChange={setDistrict} options={[{ value: 'all', label: 'All districts' }, ...DISTRICTS.map((item) => ({ value: item.id, label: item.name }))]} />
          <FilterSelect label="Max price" value={maxPrice} onChange={setMaxPrice} options={[{ value: 'all', label: 'Any price' }, ...PRICE_CAPS.map((cap) => ({ value: cap, label: `≤ ${formatAssetAmount(cap)}` }))]} />
          <FilterSelect label="Capability" value={capability} onChange={(value) => setCapability(value as ServiceCapability | 'all')} options={CAPABILITIES.map((item) => ({ value: item, label: item === 'all' ? 'All capabilities' : item }))} />
          <FilterSelect label="Status" value={status} onChange={(value) => setStatus(value as ServiceStatus | 'all')} options={STATUSES.map((item) => ({ value: item, label: item === 'all' ? 'All statuses' : item }))} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {filtered.map((service) => <ServiceCard key={service.id} service={service} />)}
      </div>

      {filtered.length === 0 && (
        <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/60 p-10 text-center font-mono text-sm text-slate-400">
          No services match the current marketplace filters.
        </div>
      )}
    </section>
  )
}

export function ServiceCard({ service }: { service: MarketplaceService }) {
  const [copied, setCopied] = useState(false)
  const copySnippet = async () => {
    await navigator.clipboard.writeText(snippet(service.id))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <article className="group rounded-3xl border border-slate-800 bg-slate-950/90 p-5 transition hover:-translate-y-1 hover:border-cyan-400/50 hover:shadow-2xl hover:shadow-cyan-950/30">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative grid h-14 w-14 place-items-center overflow-hidden rounded-2xl border border-slate-700 bg-slate-900">
            <Image src={service.providerAgent.sprite} alt={`${service.providerAgent.name} sprite`} width={44} height={44} unoptimized className="h-11 w-11 object-contain" />
          </div>
          <div>
            <h2 className="font-mono text-lg font-bold uppercase text-slate-100">{service.name}</h2>
            <p className="text-xs text-slate-400">by <span className="text-cyan-200">{service.providerAgent.name}</span></p>
          </div>
        </div>
        <span className={`rounded-full px-2 py-1 font-mono text-[10px] uppercase ${service.status === 'online' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-700/60 text-slate-300'}`}>{service.status}</span>
      </div>

      <p className="mt-4 min-h-12 text-sm leading-6 text-slate-300">{service.description}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-xs text-cyan-100">{getDistrictName(service.district)}</span>
        {service.capabilityTags.map((tag) => <span key={tag} className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">{tag}</span>)}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <Metric label="Price" value={formatAssetAmount(service.priceXlm, { digits: 2 })} />
        <Metric label="Calls" value={service.totalCalls.toLocaleString()} />
        <Metric label="Avg response" value={`${service.averageResponseMs}ms`} />
        <Metric label="Reputation" value={`${service.reputationScore}/1000`} />
      </div>

      <div className="mt-4 flex items-center gap-2 text-amber-300">
        <Star className="h-4 w-4 fill-current" />
        <span className="font-mono text-sm">{service.rating.toFixed(1)} rating</span>
      </div>

      <div className={`mt-5 grid gap-2 ${STELLAR_ENABLED ? 'sm:grid-cols-2' : ''}`}>
        {/* The integration snippet uses the Stellar-era SDK, so it only shows when Stellar is enabled. */}
        {STELLAR_ENABLED && (
          <button type="button" onClick={copySnippet} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-300 px-3 py-2 font-mono text-xs font-bold uppercase text-slate-950 transition hover:bg-cyan-200">
            <Copy className="h-4 w-4" /> {copied ? 'Copied' : 'Quick integrate'}
          </button>
        )}
        <Link href={`/marketplace/${service.id}`} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-3 py-2 font-mono text-xs font-bold uppercase text-slate-200 transition hover:border-cyan-400/60 hover:text-cyan-100">
          Details <ExternalLink className="h-4 w-4" />
        </Link>
      </div>

      {STELLAR_ENABLED && (
        <pre className="mt-4 overflow-x-auto rounded-2xl border border-slate-800 bg-black/40 p-3 text-[11px] leading-5 text-slate-300"><code>{`OPEN_STELLAR_SERVICE_ID=${service.id}
await stellar.services.call({ input })`}</code></pre>
      )}
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-3"><div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</div><div className="mt-1 flex items-center gap-1 font-mono text-cyan-100"><Zap className="h-3 w-3 text-cyan-300" />{value}</div></div>
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="space-y-2 text-xs text-slate-400">
      <span className="font-mono uppercase tracking-[0.2em]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}
