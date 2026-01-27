"use client";

import { forceCenter, forceCollide, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { BubbleNode, TopBoostBubblesResponse } from "@memebubbles/shared";
import { useEffect, useMemo, useRef, useState } from "react";

type SimNode = BubbleNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function calcRadius(score: number, minR: number, maxR: number) {
  const v = Math.sqrt(Math.max(0, score));
  const t = clamp(v / 32, 0, 1);
  return minR + (maxR - minR) * t;
}

function getApiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
}

async function fetchTopBoostBubbles(signal: AbortSignal): Promise<TopBoostBubblesResponse> {
  const url = `${getApiBaseUrl()}/api/v1/bubbles/top-boosts?limit=30`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`请求失败: ${res.status}`);
  }
  return (await res.json()) as TopBoostBubblesResponse;
}

type Rgba = { r: number; g: number; b: number; a: number };

function rgba(c: Rgba) {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

function scaleRgb(c: Rgba, factor: number): Rgba {
  return {
    r: Math.round(c.r * factor),
    g: Math.round(c.g * factor),
    b: Math.round(c.b * factor),
    a: c.a
  };
}

function pickColor(chainId: string, stale: boolean): Rgba {
  const base = chainId.toLowerCase();
  const a = stale ? 0.5 : 0.92;

  if (base === "solana") return { r: 153, g: 69, b: 255, a };
  if (base === "ethereum") return { r: 98, g: 126, b: 234, a };
  if (base === "base") return { r: 0, g: 82, b: 255, a };
  if (base === "bsc") return { r: 243, g: 186, b: 47, a };

  return { r: 63, g: 63, b: 70, a };
}

export function BubbleMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [query, setQuery] = useState("");
  const [rawNodes, setRawNodes] = useState<BubbleNode[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rawNodes;
    return rawNodes.filter((n) => {
      return n.tokenAddress.toLowerCase().includes(q) || n.label.toLowerCase().includes(q);
    });
  }, [query, rawNodes]);

  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const hoveredIdRef = useRef<string | null>(null);
  const [hovered, setHovered] = useState<SimNode | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function runOnce() {
      try {
        setError(null);
        const data = await fetchTopBoostBubbles(controller.signal);
        setRawNodes(data.data);
        setUpdatedAt(data.updatedAt);
        setStale(data.stale);
      } catch (e) {
        setError(e instanceof Error ? e.message : "未知错误");
      }
    }

    void runOnce();
    const intervalId = window.setInterval(() => {
      void runOnce();
    }, 30_000);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const containerEl = containerRef.current;
    const canvasEl = canvasRef.current;

    if (containerEl === null || canvasEl === null) return;

    const ctx = canvasEl.getContext("2d");
    if (ctx === null) return;

    const applySize = () => {
      const rect = containerEl.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));

      const dpr = window.devicePixelRatio || 1;
      canvasEl.width = Math.max(1, Math.floor(width * dpr));
      canvasEl.height = Math.max(1, Math.floor(height * dpr));
      canvasEl.style.width = `${width}px`;
      canvasEl.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      setSize({ width, height });

      const sim = simRef.current;
      if (sim) {
        sim.force("center", forceCenter(width / 2, height / 2));
        sim.alpha(0.6).restart();
      }
    };

    applySize();

    const resizeObserver = new ResizeObserver(() => {
      applySize();
    });

    resizeObserver.observe(containerEl);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const width = size.width;
    const height = size.height;

    if (width < 10 || height < 10) return;

    const minR = 18;
    const maxR = 70;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: SimNode[] = filteredNodes.map((n) => {
      const existing = prev.get(n.id);
      const r = calcRadius(n.score, minR, maxR);
      if (existing) {
        existing.rank = n.rank;
        existing.chainId = n.chainId;
        existing.tokenAddress = n.tokenAddress;
        existing.label = n.label;
        existing.score = n.score;
        existing.url = n.url;
        existing.description = n.description;
        existing.headerImageUrl = n.headerImageUrl;
        existing.iconUrl = n.iconUrl;
        existing.links = n.links;
        existing.r = r;
        return existing;
      }

      return {
        ...n,
        x: width / 2 + (Math.random() - 0.5) * 30,
        y: height / 2 + (Math.random() - 0.5) * 30,
        vx: 0,
        vy: 0,
        r
      };
    });

    nodesRef.current = next;

    const sim = simRef.current ?? forceSimulation<SimNode>();
    simRef.current = sim;

    sim.nodes(next);
    sim
      .force("charge", forceManyBody().strength(-12))
      .force("x", forceX(width / 2).strength(0.05))
      .force("y", forceY(height / 2).strength(0.05))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r + 2).iterations(2))
      .force("center", forceCenter(width / 2, height / 2))
      .alpha(0.8)
      .restart();

    let rafId = 0;
    function draw() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, width, height);

      const bg = ctx.createRadialGradient(width * 0.5, height * 0.35, 0, width * 0.5, height * 0.35, Math.max(width, height));
      bg.addColorStop(0, "rgba(40, 40, 40, 1)");
      bg.addColorStop(1, "rgba(12, 12, 12, 1)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      const hoveredId = hoveredIdRef.current;

      for (const n of next) {
        const isHover = hoveredId === n.id;
        const base = pickColor(n.chainId, stale);

        const light = rgba({ r: 255, g: 255, b: 255, a: stale ? 0.18 : 0.28 });
        const mid = rgba(base);
        const dark = rgba(scaleRgb(base, 0.35));

        const grad = ctx.createRadialGradient(n.x - n.r * 0.25, n.y - n.r * 0.25, n.r * 0.2, n.x, n.y, n.r);
        grad.addColorStop(0, light);
        grad.addColorStop(0.45, mid);
        grad.addColorStop(1, dark);

        ctx.save();
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);

        ctx.shadowBlur = isHover ? n.r * 0.85 : n.r * 0.6;
        ctx.shadowColor = rgba({ ...base, a: stale ? 0.35 : 0.55 });

        ctx.fillStyle = grad;
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.lineWidth = isHover ? 2 : 1;
        ctx.strokeStyle = isHover ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.18)";
        ctx.stroke();

        if (n.r >= 22) {
          const text = n.label;
          const fontSize = Math.round(Math.max(12, Math.min(18, n.r / 3)));

          ctx.font = `700 ${fontSize}px Verdana, Arial, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          ctx.lineWidth = Math.max(2, Math.round(n.r / 18));
          ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
          ctx.strokeText(text, n.x, n.y);

          ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
          ctx.fillText(text, n.x, n.y);
        }

        ctx.restore();
      }

      rafId = window.requestAnimationFrame(draw);
    }

    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [filteredNodes, stale, size.height, size.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      const nodes = nodesRef.current;
      let best: SimNode | null = null;

      for (const n of nodes) {
        const dx = x - n.x;
        const dy = y - n.y;
        if (dx * dx + dy * dy <= n.r * n.r) {
          best = n;
          break;
        }
      }

      const nextId = best?.id ?? null;
      hoveredIdRef.current = nextId;
      setHovered(best);
      canvas.style.cursor = best ? "pointer" : "default";
    };

    const onLeave = () => {
      hoveredIdRef.current = null;
      setHovered(null);
      canvas.style.cursor = "default";
    };

    const onClick = () => {
      const id = hoveredIdRef.current;
      if (!id) return;
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      window.open(n.url, "_blank", "noopener,noreferrer");
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);

    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm text-[color:var(--color-muted)]">
            Dexscreener boosts
            {updatedAt ? ` · 更新时间：${new Date(updatedAt).toLocaleString()}` : null}
            {stale ? " · 缓存兜底" : null}
            {` · 当前数量：${filteredNodes.length}`}
          </div>
          {error ? <div className="text-sm text-red-400">请求失败：{error}</div> : null}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索地址"
            className="h-10 w-full rounded-md border border-[color:var(--color-panel-border)] bg-[color:var(--color-panel)] px-3 text-sm text-white outline-none placeholder:text-[color:var(--color-muted)] focus:border-white/30 md:w-80"
          />
        </div>
      </div>

      <div
        ref={containerRef}
        className="bubble-chart relative min-h-[520px] flex-1 overflow-hidden rounded-xl border border-[color:var(--color-panel-border)] bg-[color:var(--color-panel)]"
      >
        <canvas ref={canvasRef} className="absolute left-0 top-0" />

        {hovered ? (
          <div className="pointer-events-none absolute left-3 top-3 w-[340px] rounded-xl border border-[color:var(--color-panel-border)] bg-black/60 p-3 text-sm text-white shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <div className="font-semibold">{hovered.label}</div>
              <div className="text-xs text-[color:var(--color-muted)]">{hovered.chainId}</div>
            </div>
            <div className="mt-1 break-all text-xs text-[color:var(--color-muted)]">{hovered.tokenAddress}</div>
            <div className="mt-2 flex items-center justify-between text-xs">
              <div className="text-[color:var(--color-muted)]">Boost 总量</div>
              <div className="font-semibold">{hovered.score}</div>
            </div>
            {hovered.description ? (
              <div className="mt-2 line-clamp-3 text-xs text-[color:var(--color-muted)]">{hovered.description}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
