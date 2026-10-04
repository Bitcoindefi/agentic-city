import type { Metadata } from "next"
import { ReceiptsExplorer } from "@/components/explorer/receipts-explorer"

export const metadata: Metadata = {
  title: "Recibos en cadena | Agentic City",
  description: "Cada pago x402, contratación entre agentes y registro o reseña 8004 de Agentic City en Solana devnet, con su transacción.",
}

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> }

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 80) ?? ""
}

export default async function ExplorerPage({ searchParams }: PageProps) {
  const params = await searchParams
  return (
    <main className="min-h-screen overflow-x-hidden bg-[#030712] px-4 py-6 text-slate-100 sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <ReceiptsExplorer initialAgent={first(params.agent)} initialType={first(params.type)} />
      </div>
    </main>
  )
}
