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
  tx: number;
  ty: number;
  fx?: number | null;
  fy?: number | null;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function calcRadius(score: number, minR: number, maxR: number) {
  const v = Math.sqrt(Math.max(0, score));
  const t = clamp(v / 32, 0, 1);
  return minR + (maxR - minR) * t;
}

async function fetchTopBoostBubbles(signal: AbortSignal): Promise<TopBoostBubblesResponse> {
  const url = `/api/v1/bubbles/top-boosts?limit=30`;
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

function hashToInt(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function chainShortName(chainId: string) {
  const c = chainId.toLowerCase();
  if (c === "solana") return "SOL";
  if (c === "bsc") return "BSC";
  if (c === "ethereum") return "ETH";
  if (c === "base") return "BASE";
  return chainId.toUpperCase();
}

function chainBadgeColor(chainId: string) {
  const c = chainId.toLowerCase();
  if (c === "solana") return "rgba(153, 69, 255, 0.9)";
  if (c === "bsc") return "rgba(243, 186, 47, 0.95)";
  return "rgba(255, 255, 255, 0.18)";
}

function pickTarget(tokenAddress: string, width: number, height: number, margin: number) {
  const h1 = hashToInt(tokenAddress);
  const h2 = hashToInt(`y:${tokenAddress}`);

  const w = Math.max(1, width - margin * 2);
  const h = Math.max(1, height - margin * 2);

  const tx = margin + (h1 % 10_000) / 10_000 * w;
  const ty = margin + (h2 % 10_000) / 10_000 * h;

  return { tx, ty };
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hslToRgb(h: number, s: number, l: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp >= 1 && hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp >= 2 && hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp >= 3 && hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp >= 4 && hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

function pickColor(chainId: string, tokenAddress: string, stale: boolean): Rgba {
  const a = stale ? 0.5 : 0.92;
  const base = chainId.toLowerCase();

  const baseHue = base === "solana" ? 270 : base === "ethereum" ? 220 : base === "base" ? 210 : base === "bsc" ? 48 : 0;
  const jitter = (hashToInt(tokenAddress) % 50) - 25;
  const hue = (baseHue + jitter + 360) % 360;

  const rgb = hslToRgb(hue, 0.78, 0.55);
  return { ...rgb, a };
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
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const hoveredIdRef = useRef<string | null>(null);
  const [hovered, setHovered] = useState<SimNode | null>(null);
  const dragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const dragMovedRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number; t: number } | null>(null);

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

    const cache = imageCacheRef.current;
    for (const n of filteredNodes) {
      if (!n.iconUrl) continue;
      if (cache.has(n.iconUrl)) continue;

      const img = new Image();
      img.decoding = "async";
      img.src = n.iconUrl;
      cache.set(n.iconUrl, img);
    }

    const minR = 18;
    const maxR = 70;

    const margin = maxR + 24;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: SimNode[] = filteredNodes.map((n) => {
      const existing = prev.get(n.id);
      const r = calcRadius(n.score, minR, maxR);
      const { tx, ty } = pickTarget(n.tokenAddress, width, height, margin);

      if (existing) {
        existing.rank = n.rank;
        existing.chainId = n.chainId;
        existing.tokenAddress = n.tokenAddress;
        existing.label = n.label;
        existing.symbol = n.symbol;
        existing.name = n.name;
        existing.score = n.score;
        existing.url = n.url;
        existing.description = n.description;
        existing.headerImageUrl = n.headerImageUrl;
        existing.iconUrl = n.iconUrl;
        existing.links = n.links;
        existing.r = r;
        existing.tx = tx;
        existing.ty = ty;
        return existing;
      }

      return {
        ...n,
        x: tx + (Math.random() - 0.5) * 20,
        y: ty + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        r,
        tx,
        ty
      };
    });

    nodesRef.current = next;

    const sim = simRef.current ?? forceSimulation<SimNode>();
    simRef.current = sim;

    sim.nodes(next);

    sim.velocityDecay(0.22);

    sim
      .force("charge", forceManyBody().strength(-18))
      .force("x", forceX<SimNode>((d) => d.tx).strength(0.16))
      .force("y", forceY<SimNode>((d) => d.ty).strength(0.16))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r + 2).iterations(2))
      .force("center", forceCenter(width / 2, height / 2).strength(0.02))
      .alpha(0.9)
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
        const base = pickColor(n.chainId, n.tokenAddress, stale);

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

        const cache = imageCacheRef.current;
        const iconUrl = n.iconUrl;
        const img = iconUrl ? cache.get(iconUrl) : undefined;

        if (img && img.complete && img.naturalWidth > 0 && n.r >= 26) {
          const sizePx = n.r * 1.05;
          ctx.save();
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * 0.55, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, n.x - sizePx / 2, n.y - sizePx / 2, sizePx, sizePx);
          ctx.restore();
        }

        if (n.r >= 22) {
          const text = n.symbol || n.label;
          const fontSize = Math.round(Math.max(12, Math.min(18, n.r / 3)));

          ctx.font = `700 ${fontSize}px Verdana, Arial, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          ctx.lineWidth = Math.max(2, Math.round(n.r / 18));
          ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
          ctx.strokeText(text, n.x, n.y);

          ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
          ctx.fillText(text, n.x, n.y);

          if (n.name && n.r >= 34) {
            const subSize = Math.max(10, Math.round(fontSize * 0.72));
            ctx.font = `400 ${subSize}px Verdana, Arial, sans-serif`;
            ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
            ctx.fillText(n.name, n.x, n.y + fontSize * 0.9);

            const badgeText = chainShortName(n.chainId);
            const padX = 8;
            const padY = 4;
            const badgeH = subSize + padY * 2;
            const badgeW = ctx.measureText(badgeText).width + padX * 2;
            const bx = n.x - badgeW / 2;
            const by = n.y + fontSize * 0.9 + badgeH * 0.55;

            ctx.save();
            roundedRectPath(ctx, bx, by, badgeW, badgeH, badgeH / 2);
            ctx.fillStyle = chainBadgeColor(n.chainId);
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
            ctx.stroke();
            ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
            ctx.font = `700 ${Math.max(10, Math.round(subSize * 0.9))}px Verdana, Arial, sans-serif`;
            ctx.fillText(badgeText, n.x, by + badgeH / 2);
            ctx.restore();
          }
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

    const sim = simRef.current;

    const findNodeAt = (x: number, y: number) => {
      for (const n of nodesRef.current) {
        const dx = x - n.x;
        const dy = y - n.y;
        if (dx * dx + dy * dy <= n.r * n.r) {
          return n;
        }
      }
      return null;
    };

    const updateHover = (x: number, y: number) => {
      const best = findNodeAt(x, y);
      hoveredIdRef.current = best?.id ?? null;
      setHovered(best);
      canvas.style.cursor = best ? "pointer" : "default";
      return best;
    };

    const applyPush = (x: number, y: number) => {
      const nodes = nodesRef.current;
      for (const n of nodes) {
        const dx = n.x - x;
        const dy = n.y - y;
        const dist2 = dx * dx + dy * dy;
        const radius = Math.max(60, n.r * 2);
        if (dist2 === 0 || dist2 > radius * radius) continue;

        const dist = Math.sqrt(dist2);
        const k = (radius - dist) / radius;
        const fx = (dx / dist) * k * 1.6;
        const fy = (dy / dist) * k * 1.6;
        n.vx += fx;
        n.vy += fy;
      }

      if (sim) {
        sim.alphaTarget(0.06);
      }
    };

    const toLocal = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    const onPointerMove = (ev: PointerEvent) => {
      const { x, y } = toLocal(ev);

      const drag = dragRef.current;
      if (drag) {
        const node = nodesRef.current.find((n) => n.id === drag.id);
        if (node) {
          node.fx = x;
          node.fy = y;
        }

        const last = lastPointerRef.current;
        if (last) {
          const dx = x - last.x;
          const dy = y - last.y;
          if (dx * dx + dy * dy > 4) {
            dragMovedRef.current = true;
          }
        }

        lastPointerRef.current = { x, y, t: Date.now() };
        if (sim) {
          sim.alphaTarget(0.18).restart();
        }

        updateHover(x, y);
        return;
      }

      updateHover(x, y);
      applyPush(x, y);
    };

    const onPointerDown = (ev: PointerEvent) => {
      const { x, y } = toLocal(ev);
      const node = findNodeAt(x, y);
      if (!node) return;

      dragRef.current = { id: node.id, pointerId: ev.pointerId };
      dragMovedRef.current = false;
      lastPointerRef.current = { x, y, t: Date.now() };

      node.fx = x;
      node.fy = y;

      canvas.setPointerCapture(ev.pointerId);
      if (sim) {
        sim.alphaTarget(0.22).restart();
      }

      updateHover(x, y);
    };

    const stopDrag = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;

      const { x, y } = toLocal(ev);
      const node = nodesRef.current.find((n) => n.id === drag.id);

      if (node) {
        node.fx = null;
        node.fy = null;

        const last = lastPointerRef.current;
        if (last) {
          const dx = x - last.x;
          const dy = y - last.y;
          node.vx += dx * 0.15;
          node.vy += dy * 0.15;
        }
      }

      dragRef.current = null;
      lastPointerRef.current = null;

      if (sim) {
        sim.alphaTarget(0.02);
      }

      updateHover(x, y);
    };

    const onClick = () => {
      if (dragMovedRef.current) return;
      const id = hoveredIdRef.current;
      if (!id) return;
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      window.open(n.url, "_blank", "noopener,noreferrer");
    };

    const onLeave = () => {
      if (sim) {
        sim.alphaTarget(0);
      }
      hoveredIdRef.current = null;
      setHovered(null);
      canvas.style.cursor = "default";
    };

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);

    return () => {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", stopDrag);
      canvas.removeEventListener("pointercancel", stopDrag);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm text-[color:var(--color-muted)]">
            Dexscreener → Fastify 封装
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
              <div className="font-semibold">{hovered.symbol ?? hovered.label}</div>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className="inline-flex items-center rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[11px] font-semibold"
                style={{ color: "white", backgroundColor: chainBadgeColor(hovered.chainId) }}
              >
                {chainShortName(hovered.chainId)}
              </span>
            </div>
            <div className="mt-1 break-all text-xs text-[color:var(--color-muted)]">{hovered.name ?? hovered.tokenAddress}</div>
            <div className="mt-1 break-all text-[11px] text-[color:var(--color-muted)]">{hovered.tokenAddress}</div>
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
