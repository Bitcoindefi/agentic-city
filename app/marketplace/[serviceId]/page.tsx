import type React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ArrowLeft, Copy, Terminal } from 'lucide-react'
import { getDistrictName, getMarketplaceService, listMarketplaceServices } from '@/lib/marketplace/services'
import { STELLAR_ENABLED, formatAssetAmount } from '@/lib/config/chains'

interface ServiceDetailPageProps {
  params: Promise<{ serviceId: string }>
}

export function generateStaticParams() {
  return listMarketplaceServices().map((service) => ({ serviceId: service.id }))
}

export async function generateMetadata({ params }: ServiceDetailPageProps): Promise<Metadata> {
  const { serviceId } = await params
  const service = getMarketplaceService(serviceId)
  return {
    title: service ? `${service.name} | Agentic City Marketplace` : 'Service not found',
    description: service?.description,
  }
}

export default async function ServiceDetailPage({ params }: ServiceDetailPageProps) {
  const { serviceId } = await params
  const service = getMarketplaceService(serviceId)
  if (!service) notFound()

  const installSnippet = `npm install @open-stellar/sdk

# .env
OPEN_STELLAR_SERVICE_ID=${service.id}`
  const codeSnippet = `import { OpenStellar } from '@open-stellar/sdk'
const stellar = new OpenStellar({ serviceId: process.env.OPEN_STELLAR_SERVICE_ID! })
const result = await stellar.services.call({ input: ${JSON.stringify(service.exampleRequest)} })
console.log(result.data)`

  return (
    <main className="min-h-screen bg-[#030712] px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Link href="/marketplace" className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.22em] text-cyan-200 hover:text-cyan-100">
          <ArrowLeft className="h-4 w-4" /> Marketplace
        </Link>

        <section className="rounded-[32px] border border-cyan-400/20 bg-slate-950/90 p-6 md:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="flex gap-4">
              <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-3xl border border-slate-700 bg-slate-900">
                <Image src={service.providerAgent.sprite} alt={`${service.providerAgent.name} sprite`} width={60} height={60} unoptimized className="h-[60px] w-[60px] object-contain" />
              </div>
              <div>
                <div className="mb-2 flex flex-wrap gap-2">
                  <span className="rounded-full bg-cyan-400/10 px-2 py-1 text-xs text-cyan-100">{getDistrictName(service.district)}</span>
                  <span className={`rounded-full px-2 py-1 text-xs ${service.status === 'online' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>{service.status}</span>
                </div>
                <h1 className="font-mono text-3xl font-bold uppercase text-cyan-100 md:text-5xl">{service.name}</h1>
                <p className="mt-3 max-w-3xl text-slate-400">{service.description}</p>
                <p className="mt-2 text-sm text-slate-500">Provider agent: <span className="text-cyan-200">{service.providerAgent.name}</span></p>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-5 md:grid-cols-5">
          <Stat label="Price" value={formatAssetAmount(service.priceXlm, { digits: 2 })} />
          <Stat label="Calls" value={service.totalCalls.toLocaleString()} />
          <Stat label="Avg response" value={`${service.averageResponseMs}ms`} />
          <Stat label="Rating" value={service.rating.toFixed(1)} />
          <Stat label="Reputation" value={`${service.reputationScore}/1000`} />
        </div>

        <section className={`grid gap-5 ${STELLAR_ENABLED ? 'lg:grid-cols-2' : ''}`}>
          {/* The SDK snippet is Stellar-era, so it only shows when Stellar is enabled. */}
          {STELLAR_ENABLED && (
            <Panel title="One-click copy" icon={<Copy className="h-4 w-4" />}>
              <pre className="overflow-x-auto rounded-2xl bg-black/50 p-4 text-sm leading-6 text-slate-200"><code>{installSnippet}</code></pre>
              <pre className="mt-3 overflow-x-auto rounded-2xl bg-black/50 p-4 text-sm leading-6 text-slate-200"><code>{codeSnippet}</code></pre>
            </Panel>
          )}
          <Panel title="Full docs" icon={<Terminal className="h-4 w-4" />}>
            <ul className="space-y-3 text-sm leading-6 text-slate-300">
              {service.docs.map((doc) => <li key={doc} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-3">{doc}</li>)}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              {service.capabilityTags.map((tag) => <span key={tag} className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">{tag}</span>)}
            </div>
          </Panel>
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <Panel title="Example request / response">
            <div className="grid gap-3 md:grid-cols-2">
              <pre className="overflow-x-auto rounded-2xl bg-black/50 p-4 text-xs leading-5 text-slate-200"><code>{JSON.stringify(service.exampleRequest, null, 2)}</code></pre>
              <pre className="overflow-x-auto rounded-2xl bg-black/50 p-4 text-xs leading-5 text-slate-200"><code>{JSON.stringify(service.exampleResponse, null, 2)}</code></pre>
            </div>
          </Panel>
          <Panel title="Uptime graph">
            <div className="flex h-52 items-end gap-3 rounded-2xl border border-slate-800 bg-black/30 p-4">
              {service.uptime.map((point) => (
                <div key={point.label} className="flex flex-1 flex-col items-center gap-2">
                  <div className="w-full rounded-t-lg bg-cyan-300/80" style={{ height: `${Math.max(8, point.value - 90) * 10}%` }} />
                  <span className="font-mono text-[10px] text-slate-500">{point.label}</span>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <Panel title="Receipt history">
          <div className="overflow-hidden rounded-2xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-[10px] uppercase tracking-[0.24em] text-slate-500">
                <tr><th className="p-3">Receipt</th><th className="p-3">Agent</th><th className="p-3">Amount</th><th className="p-3">Latency</th><th className="p-3">Settled</th></tr>
              </thead>
              <tbody>
                {service.receiptHistory.map((receipt) => (
                  <tr key={receipt.id} className="border-t border-slate-800">
                    <td className="p-3 font-mono text-cyan-200">{receipt.id}</td>
                    <td className="p-3">{receipt.agent}</td>
                    <td className="p-3 font-mono">{formatAssetAmount(receipt.amountXlm, { digits: 2 })}</td>
                    <td className="p-3 font-mono">{receipt.latencyMs}ms</td>
                    <td className="p-3 text-slate-400">{new Date(receipt.settledAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4"><div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</div><div className="mt-2 font-mono text-xl text-cyan-100">{value}</div></div>
}

function Panel({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-3xl border border-slate-800 bg-slate-950/80 p-5"><h2 className="mb-4 flex items-center gap-2 font-mono text-sm uppercase tracking-[0.24em] text-cyan-200">{icon}{title}</h2>{children}</section>
}
