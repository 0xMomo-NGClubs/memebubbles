import { BubbleMap } from "@/components/BubbleMap";

export default function Home() {
  return (
    <div className="h-dvh w-dvw">
      <div className="flex h-full w-full flex-col gap-3 p-[var(--window-gap)]">
        <header className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Meme Bubbles</h1>
            <p className="text-sm text-[color:var(--color-muted)]">热度泡泡图（Top 30 / 30s 刷新）</p>
          </div>
          <div className="text-sm text-[color:var(--color-muted)]">数据：Dexscreener → Fastify 封装</div>
        </header>

        <main className="min-h-0 flex-1">
          <BubbleMap />
        </main>
      </div>
    </div>
  );
}
