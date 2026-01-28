"use client";

import { forceCenter, forceCollide, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { BubbleNode, RecentBoostBubblesResponse } from "@memebubbles/shared";
import { useEffect, useRef, useState } from "react";

type SimNode = BubbleNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  s: number;
  phase: "stable" | "entering" | "leaving";
  phaseStartAtMs: number;
  tx: number;
  ty: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const ENTER_ANIM_MS = 420;
const LEAVE_ANIM_MS = 380;

function easeOutBack(t: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInBack(t: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
}

function calcRadiusFromMarketCap(marketCap: number, minMarketCap: number, maxMarketCap: number, minR: number, maxR: number) {
  const v = Math.max(1, marketCap);
  const minV = Math.max(1, minMarketCap);
  const maxV = Math.max(minV + 1, maxMarketCap);

  const logV = Math.log10(v);
  const logMin = Math.log10(minV);
  const logMax = Math.log10(maxV);

  const t0 = logMax === logMin ? 0.5 : clamp((logV - logMin) / (logMax - logMin), 0, 1);

  const curve = 2.4;
  const t = Math.pow(t0, curve);

  return minR + (maxR - minR) * t;
}

function calcRadiusFallback(score: number, minR: number, maxR: number) {
  const v = Math.sqrt(Math.max(0, score));
  const t = clamp(v / 32, 0, 1);
  return minR + (maxR - minR) * t;
}

async function fetchRecentBoostBubbles(signal: AbortSignal): Promise<RecentBoostBubblesResponse> {
  const url = `/api/v1/bubbles/recent?limit=100`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`请求失败: ${res.status}`);
  }
  return (await res.json()) as RecentBoostBubblesResponse;
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

type Target = { tx: number; ty: number; noise: number };

function rand01(seed: number) {
  let x = seed >>> 0;
  x = (x * 1664525 + 1013904223) >>> 0;
  return x / 4294967296;
}

function generateTargets(count: number, width: number, height: number, margin: number): Target[] {
  const w = Math.max(1, width - margin * 2);
  const h = Math.max(1, height - margin * 2);

  const cols = Math.max(1, Math.ceil(Math.sqrt((count * w) / h)));
  const rows = Math.max(1, Math.ceil(count / cols));

  const stepX = w / cols;
  const stepY = h / rows;

  const out: Target[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (out.length >= count) return out;

      const seed = (((row + 1) * 73856093) ^ ((col + 1) * 19349663) ^ (width * 83492791) ^ (height * 2654435761)) >>> 0;
      const jx = (rand01(seed) - 0.5) * stepX * 0.7;
      const jy = (rand01(seed ^ 0x9e3779b9) - 0.5) * stepY * 0.7;
      const noise = rand01(seed ^ 0x85ebca6b);

      const offsetX = (row % 2) * (stepX * 0.5);
      const tx = margin + (col + 0.5) * stepX + offsetX + jx;
      const ty = margin + (row + 0.5) * stepY + jy;

      out.push({
        tx: clamp(tx, margin, width - margin),
        ty: clamp(ty, margin, height - margin),
        noise
      });
    }
  }

  return out;
}

function buildTargetMap(nodes: BubbleNode[], width: number, height: number, margin: number) {
  const targets = generateTargets(nodes.length, width, height, margin);

  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.max(width, height);

  const sortedTargets = targets
    .map((t) => {
      const d2 = (t.tx - cx) * (t.tx - cx) + (t.ty - cy) * (t.ty - cy);
      const jitter = (t.noise - 0.5) * (scale * scale) * 0.02;
      return { ...t, key: d2 + jitter };
    })
    .sort((a, b) => a.key - b.key);

  const sortedNodes = [...nodes].sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score));

  const map = new Map<string, { tx: number; ty: number }>();
  for (let i = 0; i < sortedNodes.length; i++) {
    const n = sortedNodes[i];
    const t = sortedTargets[i];
    if (n && t) {
      map.set(n.id, { tx: t.tx, ty: t.ty });
    }
  }

  return map;
}

function formatMarketCap(n: number) {
  const abs = Math.abs(n);

  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    const digits = Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0;
    return `${v.toFixed(digits)}M`;
  }

  if (abs >= 1_000) {
    const v = n / 1_000;
    const digits = Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0;
    return `${v.toFixed(digits)}K`;
  }

  return `${Math.round(n)}`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "…";
  let s = text;

  while (s.length > 1 && ctx.measureText(s + ellipsis).width > maxWidth) {
    s = s.slice(0, -1);
  }

  return s.length <= 1 ? ellipsis : s + ellipsis;
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

  const [rawNodes, setRawNodes] = useState<BubbleNode[]>([]);
  const [stale, setStale] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const viewRef = useRef<{ scale: number; cx: number; cy: number; width: number; height: number }>({
    scale: 1,
    cx: 0,
    cy: 0,
    width: 0,
    height: 0
  });
  const hoveredIdRef = useRef<string | null>(null);
  const [hovered, setHovered] = useState<SimNode | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function runOnce() {
      try {
        const data = await fetchRecentBoostBubbles(controller.signal);
        setRawNodes(data.data);
        setStale(data.stale);
      } catch (e) {
        return;
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
    for (const n of rawNodes) {
      if (!n.iconUrl) continue;
      if (cache.has(n.iconUrl)) continue;

      const img = new Image();
      img.decoding = "async";
      img.src = n.iconUrl;
      cache.set(n.iconUrl, img);
    }

    const baseMinR = 18;
    const baseMaxR = 70;

    const mcValues = rawNodes.map((n) => n.marketCap).filter((v): v is number => typeof v === "number" && v > 0);
    const hasMarketCap = mcValues.length >= Math.ceil(rawNodes.length * 0.6);
    const minMarketCap = mcValues.length ? Math.min(...mcValues) : 0;
    const maxMarketCap = mcValues.length ? Math.max(...mcValues) : 0;

    const baseRadii = rawNodes.map((n) => {
      return hasMarketCap
        ? calcRadiusFromMarketCap(n.marketCap ?? minMarketCap, minMarketCap, maxMarketCap, baseMinR, baseMaxR)
        : calcRadiusFallback(n.score, baseMinR, baseMaxR);
    });

    const sumArea = baseRadii.reduce((acc, r) => acc + Math.PI * r * r, 0);
    const canvasArea = width * height;

    const targetCoverage = 0.28;
    const scale = sumArea > 0 ? Math.sqrt((canvasArea * targetCoverage) / sumArea) : 1;
    const radiusScale = clamp(scale, 0.85, 1.9);

    const maxR = baseMaxR * radiusScale;
    const margin = maxR + 24;

    const targetMap = buildTargetMap(rawNodes, width, height, margin);

    const nowMs = performance.now();
    const enableLifecycle = true;

    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const incomingIds = new Set(rawNodes.map((n) => n.id));

    const next: SimNode[] = [];

    for (let idx = 0; idx < rawNodes.length; idx++) {
      const n = rawNodes[idx]!;
      const existing = prev.get(n.id);

      const r = baseRadii[idx]! * radiusScale;

      const target = targetMap.get(n.id);
      const tx = target?.tx ?? width / 2;
      const ty = target?.ty ?? height / 2;

      if (existing) {
        existing.rank = n.rank;
        existing.chainId = n.chainId;
        existing.tokenAddress = n.tokenAddress;
        existing.label = n.label;
        existing.symbol = n.symbol;
        existing.name = n.name;
        existing.marketCap = n.marketCap;
        existing.pairAddress = n.pairAddress;
        existing.score = n.score;
        existing.url = n.url;
        existing.description = n.description;
        existing.headerImageUrl = n.headerImageUrl;
        existing.iconUrl = n.iconUrl;
        existing.links = n.links;
        existing.r = r;
        existing.tx = tx;
        existing.ty = ty;

        if (existing.phaseStartAtMs === undefined || existing.s === undefined || existing.phase === undefined) {
          existing.phase = "stable";
          existing.s = 1;
          existing.phaseStartAtMs = nowMs;
        }

        if (!enableLifecycle) {
          existing.phase = "stable";
          existing.s = 1;
          existing.phaseStartAtMs = nowMs;
        } else if (existing.phase === "leaving") {
          existing.phase = "entering";
          existing.s = Math.min(existing.s, 0.2);
          existing.phaseStartAtMs = nowMs;
        }

        next.push(existing);
        continue;
      }

      const marginPx = 24;
      const x0 = marginPx + Math.random() * Math.max(1, width - marginPx * 2);
      const y0 = marginPx + Math.random() * Math.max(1, height - marginPx * 2);

      next.push({
        ...n,
        x: x0,
        y: y0,
        vx: 0,
        vy: 0,
        r,
        s: enableLifecycle ? 0.001 : 1,
        phase: enableLifecycle ? "entering" : "stable",
        phaseStartAtMs: nowMs,
        tx,
        ty
      });
    }

    if (enableLifecycle) {
      for (const old of nodesRef.current) {
        if (incomingIds.has(old.id)) continue;
        if (old.phase !== "leaving") {
          old.phase = "leaving";
          old.s = 1;
          old.phaseStartAtMs = nowMs;
        }
        next.push(old);
      }
    }

    nodesRef.current = next;

    const sim = simRef.current ?? forceSimulation<SimNode>();
    simRef.current = sim;

    sim.nodes(next);

    sim.velocityDecay(0.18);

    const wiggleForce = (() => {
      let simNodes: SimNode[] = [];

      const f = (alpha: number) => {
        const t = Date.now() / 1000;
        for (const n of simNodes) {
          const seed = hashToInt(n.id);
          const phase = (seed % 10_000) / 10_000;
          const a = (t * 0.7 + phase) * Math.PI * 2;
          const amp = (0.035 + (seed % 1000) / 1000 * 0.02) * alpha;
          n.vx += Math.cos(a) * amp;
          n.vy += Math.sin(a) * amp;
        }
      };

      f.initialize = (nodes: SimNode[]) => {
        simNodes = nodes;
      };

      return f;
    })();

    sim
      .force("charge", forceManyBody().strength(-18))
      .force("x", forceX<SimNode>((d) => d.tx).strength(0.16))
      .force("y", forceY<SimNode>((d) => d.ty).strength(0.16))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => {
            const physicalScale = d.phase === "leaving" ? d.s : 1;
            return d.r * clamp(physicalScale, 0, 1) + 2;
          })
          .iterations(2)
      )
      .force("center", forceCenter(width / 2, height / 2).strength(0.02))
      .force("wiggle", wiggleForce)
      .alphaTarget(0.02)
      .alpha(0.9)
      .restart();

    let rafId = 0;
    function draw() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const nowMs = performance.now();

      const nodesBefore = nodesRef.current;
      const toRemove = new Set<string>();

      for (const n of nodesBefore) {
        if (n.phase === "entering") {
          const p = clamp((nowMs - n.phaseStartAtMs) / ENTER_ANIM_MS, 0, 1);
          n.s = clamp(easeOutBack(p), 0, 1.15);
          if (p >= 1) {
            n.phase = "stable";
            n.s = 1;
          }
          continue;
        }

        if (n.phase === "leaving") {
          const p = clamp((nowMs - n.phaseStartAtMs) / LEAVE_ANIM_MS, 0, 1);
          n.s = clamp(1 - easeInBack(p), 0, 1);
          if (p >= 1 || n.s <= 0.01) {
            toRemove.add(n.id);
          }
        } else {
          n.s = 1;
        }
      }

      if (toRemove.size > 0) {
        nodesRef.current = nodesBefore.filter((n) => !toRemove.has(n.id));
        const sim0 = simRef.current;
        if (sim0) {
          sim0.nodes(nodesRef.current);
          sim0.alpha(0.5).restart();
        }

        if (hoveredIdRef.current && toRemove.has(hoveredIdRef.current)) {
          hoveredIdRef.current = null;
          setHovered(null);
        }
      }

      const nodes = nodesRef.current;

      ctx.clearRect(0, 0, width, height);

      const bg = ctx.createRadialGradient(width * 0.5, height * 0.35, 0, width * 0.5, height * 0.35, Math.max(width, height));
      bg.addColorStop(0, "rgba(40, 40, 40, 1)");
      bg.addColorStop(1, "rgba(12, 12, 12, 1)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (const n of nodes) {
        const drawR = n.r * clamp(n.s, 0, 1.15);
        minX = Math.min(minX, n.x - drawR);
        minY = Math.min(minY, n.y - drawR);
        maxX = Math.max(maxX, n.x + drawR);
        maxY = Math.max(maxY, n.y + drawR);
      }

      const contentW = Math.max(1, maxX - minX);
      const contentH = Math.max(1, maxY - minY);
      const pad = 24;
      const fitScale = Math.min(width / (contentW + pad * 2), height / (contentH + pad * 2));
      const viewScale = clamp(fitScale, 1, 1.65);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      viewRef.current = { scale: viewScale, cx, cy, width, height };

      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.scale(viewScale, viewScale);
      ctx.translate(-cx, -cy);

      const hoveredId = hoveredIdRef.current;

      for (const n of nodes) {
        const isHover = hoveredId === n.id;
        const base = pickColor(n.chainId, n.tokenAddress, stale);
        const drawR = n.r * clamp(n.s, 0, 1.15);
        const drawAlpha = clamp(n.s, 0, 1);

        const light = rgba({ r: 255, g: 255, b: 255, a: stale ? 0.18 : 0.28 });
        const mid = rgba(base);
        const dark = rgba(scaleRgb(base, 0.35));

        const grad = ctx.createRadialGradient(n.x - drawR * 0.25, n.y - drawR * 0.25, drawR * 0.2, n.x, n.y, drawR);
        grad.addColorStop(0, light);
        grad.addColorStop(0.45, mid);
        grad.addColorStop(1, dark);

        ctx.save();
        ctx.globalAlpha = drawAlpha;
        ctx.beginPath();
        ctx.arc(n.x, n.y, drawR, 0, Math.PI * 2);

        ctx.shadowBlur = isHover ? drawR * 0.85 : drawR * 0.6;
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

        const iconCenterY = n.y - drawR * 0.32;
        const iconRadius = drawR * 0.34;

        if (img && img.complete && img.naturalWidth > 0) {
          const sizePx = iconRadius * 2;
          ctx.save();
          ctx.beginPath();
          ctx.arc(n.x, iconCenterY, iconRadius, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, n.x - sizePx / 2, iconCenterY - sizePx / 2, sizePx, sizePx);
          ctx.restore();
        }

        const displayName = n.name || n.symbol || n.label;
        const nameTextRaw = displayName.length > 14 && n.symbol ? n.symbol : displayName;
        const nameFontSize = Math.round(Math.max(12, Math.min(20, drawR / 3)));
        const nameTextY = n.y + drawR * 0.05;

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        ctx.font = `700 ${nameFontSize}px Verdana, Arial, sans-serif`;
        const nameText = fitText(ctx, nameTextRaw, drawR * 1.55);

        ctx.lineWidth = Math.max(2, Math.round(drawR / 18));
        ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
        ctx.strokeText(nameText, n.x, nameTextY);

        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.fillText(nameText, n.x, nameTextY);

        const mc = typeof n.marketCap === "number" ? n.marketCap : 0;
        const mcText = mc > 0 ? `$${formatMarketCap(mc)}` : "—";
        const mcFontSize = Math.round(Math.max(10, Math.min(16, drawR / 4)));
        const mcY = n.y + drawR * 0.35;

        ctx.font = `600 ${mcFontSize}px Verdana, Arial, sans-serif`;
        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        ctx.fillText(mcText, n.x, mcY);

        ctx.restore();
      }

      ctx.restore();
      rafId = window.requestAnimationFrame(draw);
    }

    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [rawNodes, stale, size.height, size.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      const view = viewRef.current;
      const scale = view.scale || 1;
      const cx = view.cx;
      const cy = view.cy;
      const w = view.width || rect.width;
      const h = view.height || rect.height;

      const sx = (x - w / 2) / scale + cx;
      const sy = (y - h / 2) / scale + cy;

      const nodes = nodesRef.current;
      let best: SimNode | null = null;

      for (const n of nodes) {
        const dx = sx - n.x;
        const dy = sy - n.y;
        const rr = n.r * clamp(n.s ?? 1, 0, 1.15);
        if (dx * dx + dy * dy <= rr * rr) {
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
    <div
      ref={containerRef}
      className="bubble-chart relative h-full w-full overflow-hidden rounded-xl border border-[color:var(--color-panel-border)] bg-[color:var(--color-panel)]"
    >
      <canvas ref={canvasRef} className="absolute left-0 top-0" />

      {hovered ? (
        <div className="pointer-events-none absolute left-3 top-3 w-[340px] rounded-xl border border-[color:var(--color-panel-border)] bg-black/60 p-3 text-sm text-white shadow-lg backdrop-blur">
          <div className="flex items-center justify-between">
            <div className="font-semibold">{hovered.symbol ?? hovered.label}</div>
            <div className="text-xs text-[color:var(--color-muted)]">{hovered.chainId}</div>
          </div>
          <div className="mt-1 break-all text-xs text-[color:var(--color-muted)]">{hovered.name ?? hovered.tokenAddress}</div>
          <div className="mt-1 break-all text-[11px] text-[color:var(--color-muted)]">{hovered.tokenAddress}</div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <div className="text-[color:var(--color-muted)]">市值</div>
            <div className="font-semibold">{typeof hovered.marketCap === "number" ? `$${formatMarketCap(hovered.marketCap)}` : "--"}</div>
          </div>
          {hovered.description ? <div className="mt-2 line-clamp-3 text-xs text-[color:var(--color-muted)]">{hovered.description}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
