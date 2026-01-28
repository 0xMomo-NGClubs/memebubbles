import { BubbleMap } from "@/components/BubbleMap";

export default function Home() {
  return (
    <div className="h-dvh w-dvw">
      <div className="flex h-full w-full p-[var(--window-gap)]">
        <main className="min-h-0 flex-1">
          <BubbleMap />
        </main>
      </div>
    </div>
  );
}
