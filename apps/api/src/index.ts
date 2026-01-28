import https from "node:https";
import dotenv from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type {
   BubbleNode,
   DexscreenerTopBoost,
   RecentBoostBubblesResponse,
   TopBoostBubblesResponse,
} from "@memebubbles/shared";

if (process.env.NODE_ENV !== "production") {
   dotenv.config();
}

const DEXSCREENER_TOP_BOOSTS_URL =
   "https://api.dexscreener.com/token-boosts/top/v1" as const;
const DEXSCREENER_LATEST_BOOSTS_URL =
   "https://api.dexscreener.com/token-boosts/latest/v1" as const;
const DEXSCREENER_LATEST_ADS_URL =
   "https://api.dexscreener.com/ads/latest/v1" as const;
const DEXSCREENER_LATEST_TOKEN_PROFILES_URL =
   "https://api.dexscreener.com/token-profiles/latest/v1" as const;
const DEXSCREENER_LATEST_TOKENS_BASE_URL =
   "https://api.dexscreener.com/latest/dex/tokens" as const;
const DEXSCREENER_LATEST_PAIRS_BASE_URL =
   "https://api.dexscreener.com/latest/dex/pairs" as const;

const envSchema = z.object({
   PORT: z.coerce.number().int().positive().optional(),
   HOST: z.string().optional(),
   FRONTEND_ORIGIN: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

function shortAddress(address: string) {
   if (address.length <= 12) return address;
   return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

type TokenMeta = {
   name?: string;
   symbol?: string;
   imageUrl?: string;
   headerImageUrl?: string;
   marketCap?: number;
   pairAddress?: string;
};

const boostLinkSchema = z.object({
   url: z.string().url(),
   type: z.string().optional(),
   label: z.string().optional(),
});

const boostBaseSchema = z.object({
   url: z.string().url(),
   chainId: z.string(),
   tokenAddress: z.string(),
   description: z.string().optional(),
   icon: z.string().optional(),
   header: z.string().optional(),
   openGraph: z.string().optional(),
   links: z.array(boostLinkSchema).optional(),
   totalAmount: z.number().optional(),
   amount: z.number().optional(),
});

function mapBoostToBubbleNode(
   boost: DexscreenerTopBoost,
   rank: number,
   meta: TokenMeta | undefined,
): BubbleNode {
   const id = `${boost.chainId}:${boost.tokenAddress}`;

   const links = (boost.links ?? []).map((l) => {
      const type = l.type;
      const label =
         l.label ??
         (type === "twitter"
            ? "X"
            : type === "telegram"
              ? "Telegram"
              : undefined);
      return { url: l.url, type, label };
   });

   const symbol = meta?.symbol;
   const name = meta?.name;
   const boostIconUrl = boost.icon?.startsWith("http") ? boost.icon : undefined;

   return {
      id,
      rank,
      chainId: boost.chainId,
      tokenAddress: boost.tokenAddress,
      label: name || symbol || shortAddress(boost.tokenAddress),
      symbol,
      name,
      marketCap: meta?.marketCap,
      pairAddress: meta?.pairAddress,
      score: boost.totalAmount,
      url: boost.url,
      description: boost.description,
      headerImageUrl: meta?.headerImageUrl ?? boost.header,
      iconUrl: meta?.imageUrl ?? boostIconUrl,
      links,
   };
}

type CacheState = {
   updatedAtMs: number;
   data: BubbleNode[];
};

type RecentEntry = {
   key: string;
   boost: DexscreenerTopBoost;
   lastSeenAtMs: number;
   meta?: TokenMeta;
};

type RecentCacheState = {
   updatedAtMs: number;
   data: BubbleNode[];
};

type Cache = {
   latest: CacheState | null;
   inFlight: Promise<CacheState> | null;
   lastError: unknown;
   lastAttemptedAtMs: number | null;
};

const cache: Cache = {
   latest: null,
   inFlight: null,
   lastError: null,
   lastAttemptedAtMs: null,
};

const RECENT_CAPACITY = 100;
const RECENT_TTL_MS = 6 * 60 * 60 * 1000;

const recentCache: {
   latest: RecentCacheState | null;
   inFlight: Promise<RecentCacheState> | null;
   lastError: unknown;
   lastAttemptedAtMs: number | null;
   entries: Map<string, RecentEntry>;
} = {
   latest: null,
   inFlight: null,
   lastError: null,
   lastAttemptedAtMs: null,
   entries: new Map(),
};

const querySchema = z.object({
   limit: z.coerce.number().int().min(1).max(100).default(30),
});

const recentQuerySchema = z.object({
   limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(RECENT_CAPACITY)
      .default(RECENT_CAPACITY),
});

function sleep(ms: number) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(err: unknown) {
   if (typeof err !== "object" || err === null) return undefined;

   if ("code" in err) {
      const code = (err as { code?: unknown }).code;
      return typeof code === "string" ? code : undefined;
   }

   if ("cause" in err) {
      const cause = (err as { cause?: unknown }).cause;
      if (typeof cause === "object" && cause !== null && "code" in cause) {
         const code = (cause as { code?: unknown }).code;
         return typeof code === "string" ? code : undefined;
      }
   }

   return undefined;
}

function isRetryableNetworkError(err: unknown) {
   if (err instanceof DexscreenerTimeoutError) return true;

   const code = getErrorCode(err);
   return (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN"
   );
}

class DexscreenerTimeoutError extends Error {
   public code = "ETIMEDOUT" as const;

   constructor() {
      super("Dexscreener 请求超时");
      this.name = "DexscreenerTimeoutError";
   }
}

type HttpsAgentWithTimeout = https.Agent & { timeout?: number };

const httpsAgent: HttpsAgentWithTimeout = new https.Agent({
   keepAlive: true,
   maxSockets: 16,
});

async function httpsGetJson(url: string, timeoutMs: number): Promise<unknown> {
   return await new Promise((resolve, reject) => {
      const req = https.request(
         url,
         {
            method: "GET",
            headers: {
               accept: "application/json",
               "user-agent": "memebubbles/0.0.0",
            },
            agent: httpsAgent,
         },
         (res) => {
            const statusCode = res.statusCode ?? 0;

            res.setEncoding("utf8");

            let body = "";
            res.on("data", (chunk) => {
               body += chunk;
            });

            res.on("end", () => {
               clearTimeout(hardTimeoutId);

               if (statusCode < 200 || statusCode >= 300) {
                  reject(new Error(`Dexscreener 响应异常: ${statusCode}`));
                  return;
               }

               try {
                  resolve(JSON.parse(body) as unknown);
               } catch (err) {
                  reject(
                     err instanceof Error
                        ? new Error("Dexscreener 返回 JSON 解析失败", {
                             cause: err,
                          })
                        : new Error("Dexscreener 返回 JSON 解析失败"),
                  );
               }
            });
         },
      );

      const hardTimeoutId = setTimeout(() => {
         req.destroy(new DexscreenerTimeoutError());
      }, timeoutMs);

      req.on("error", (err) => {
         clearTimeout(hardTimeoutId);
         reject(err);
      });

      req.end();
   });
}

async function fetchDexscreenerList<T>(opts: {
   url: string;
   schema: z.ZodType<T>;
   label: string;
   maxAttempts?: number;
}): Promise<T> {
   const maxAttempts = opts.maxAttempts ?? 3;

   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
         const timeoutMs = Number(process.env.DEXSCREENER_TIMEOUT_MS ?? 8000);
         const json = await httpsGetJson(opts.url, timeoutMs);
         return opts.schema.parse(json);
      } catch (err) {
         if (attempt >= maxAttempts || !isRetryableNetworkError(err)) {
            const prefix = `${opts.label} 请求失败（第 ${attempt}/${maxAttempts} 次）`;
            throw err instanceof Error
               ? new Error(prefix, { cause: err })
               : new Error(prefix);
         }

         const delayMs = 200 * Math.pow(2, attempt - 1);
         await sleep(delayMs);
      }
   }

   throw new Error(`${opts.label} 请求失败：未知原因`);
}

async function fetchTopBoostsFromDexscreener(): Promise<DexscreenerTopBoost[]> {
   const arrSchema = z.array(
      boostBaseSchema.extend({ totalAmount: z.number() }),
   );
   return await fetchDexscreenerList({
      url: DEXSCREENER_TOP_BOOSTS_URL,
      schema: arrSchema,
      label: "Dexscreener top boosts",
   });
}

function normalizeBoost(
   base: z.infer<typeof boostBaseSchema>,
): DexscreenerTopBoost {
   return {
      ...base,
      totalAmount: typeof base.totalAmount === "number" ? base.totalAmount : 0,
   };
}

async function fetchLatestBoostsFromDexscreener(): Promise<
   DexscreenerTopBoost[]
> {
   const arrSchema = z.array(boostBaseSchema);
   const parsed = await fetchDexscreenerList({
      url: DEXSCREENER_LATEST_BOOSTS_URL,
      schema: arrSchema,
      label: "Dexscreener latest boosts",
   });
   return parsed.map((b) => normalizeBoost(b));
}

async function fetchLatestAdsFromDexscreener(): Promise<DexscreenerTopBoost[]> {
   const arrSchema = z.array(
      z.object({
         url: z.string().url(),
         chainId: z.string(),
         tokenAddress: z.string(),
         date: z.string().optional(),
         type: z.string().optional(),
         impressions: z.number().optional(),
         durationHours: z.number().optional(),
      }),
   );
   const parsed = await fetchDexscreenerList({
      url: DEXSCREENER_LATEST_ADS_URL,
      schema: arrSchema,
      label: "Dexscreener latest ads",
   });
   return parsed.map((ad) => ({
      url: ad.url,
      chainId: ad.chainId,
      tokenAddress: ad.tokenAddress,
      totalAmount: 0,
   }));
}

async function fetchLatestTokenProfilesFromDexscreener(): Promise<
   DexscreenerTopBoost[]
> {
   const arrSchema = z.array(boostBaseSchema);
   const parsed = await fetchDexscreenerList({
      url: DEXSCREENER_LATEST_TOKEN_PROFILES_URL,
      schema: arrSchema,
      label: "Dexscreener latest token profiles",
   });
   return parsed.map((p) => normalizeBoost(p));
}

async function fetchTokenMetaMap(
   tokenAddresses: string[],
): Promise<Map<string, TokenMeta>> {
   if (tokenAddresses.length === 0) return new Map();

   const schema = z.object({
      pairs: z.array(
         z.object({
            chainId: z.string(),
            pairAddress: z.string(),
            baseToken: z.object({
               address: z.string(),
               name: z.string().optional(),
               symbol: z.string().optional(),
            }),
            info: z
               .object({
                  imageUrl: z.string().url().optional(),
                  header: z.string().url().optional(),
               })
               .optional(),
            marketCap: z.number().optional(),
            fdv: z.number().optional(),
            liquidity: z
               .object({
                  usd: z.number().optional(),
               })
               .optional(),
         }),
      ),
   });

   const uniq = new Map<string, string>();
   for (const addr of tokenAddresses) {
      const key = addr.toLowerCase();
      if (!uniq.has(key)) {
         uniq.set(key, addr);
      }
   }

   const uniqAddresses = Array.from(uniq.values());
   if (uniqAddresses.length === 0) return new Map();

   const rawBatchSize = Number(process.env.DEXSCREENER_TOKENS_BATCH_SIZE ?? 30);
   const batchSize =
      Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : 30;

   const batches: string[][] = [];
   for (let i = 0; i < uniqAddresses.length; i += batchSize) {
      batches.push(uniqAddresses.slice(i, i + batchSize));
   }

   const timeoutMs = Number(process.env.DEXSCREENER_TIMEOUT_MS ?? 8000);

   const fetchBatch = async (batch: string[]) => {
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
         try {
            const url = `${DEXSCREENER_LATEST_TOKENS_BASE_URL}/${batch.join(",")}`;
            const json = await httpsGetJson(url, timeoutMs);
            const parsed = schema.parse(json);

            const bestByAddr = new Map<
               string,
               { usd: number; meta: TokenMeta }
            >();

            for (const p of parsed.pairs) {
               const addr = p.baseToken.address.toLowerCase();
               const usd = p.liquidity?.usd ?? 0;

               const meta: TokenMeta = {
                  name: p.baseToken.name,
                  symbol: p.baseToken.symbol,
                  imageUrl: p.info?.imageUrl,
                  headerImageUrl: p.info?.header,
                  marketCap: p.marketCap ?? p.fdv,
                  pairAddress: p.pairAddress,
               };

               const existing = bestByAddr.get(addr);
               if (!existing || usd > existing.usd) {
                  bestByAddr.set(addr, { usd, meta });
               }
            }

            const out = new Map<string, TokenMeta>();
            for (const [addr, v] of bestByAddr) {
               out.set(addr, v.meta);
            }
            return out;
         } catch (err) {
            if (attempt >= maxAttempts || !isRetryableNetworkError(err)) {
               throw err;
            }
            const delayMs = 200 * Math.pow(2, attempt - 1);
            await sleep(delayMs);
         }
      }

      return new Map<string, TokenMeta>();
   };

   const batchResults = await mapLimit(batches, 3, async (batch) => {
      try {
         return await fetchBatch(batch);
      } catch {
         return new Map<string, TokenMeta>();
      }
   }).catch(() => []);

   const out = new Map<string, TokenMeta>();
   for (const batchMap of batchResults) {
      for (const [addr, meta] of batchMap) {
         out.set(addr, meta);
      }
   }

   return out;
}

function parsePairAddressFromUrl(url: string, chainId: string) {
   try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return undefined;
      const [chain, pairAddress] = parts;
      if (!chain || !pairAddress) return undefined;
      if (chain.toLowerCase() !== chainId.toLowerCase()) return undefined;
      return pairAddress;
   } catch {
      return undefined;
   }
}

type TokenKey =
   | {
        kind: "pair";
        chainId: string;
        pairAddress: string;
     }
   | {
        kind: "token";
        chainId: string;
        tokenAddress: string;
     };

function tokenKeyToString(k: TokenKey) {
   if (k.kind === "pair") {
      return `${k.chainId.toLowerCase()}:${k.pairAddress.toLowerCase()}`;
   }

   return `${k.chainId.toLowerCase()}:token:${k.tokenAddress.toLowerCase()}`;
}

function boostToTokenKey(boost: DexscreenerTopBoost) {
   const pairAddress = parsePairAddressFromUrl(boost.url, boost.chainId);
   if (pairAddress) {
      return {
         kind: "pair" as const,
         chainId: boost.chainId,
         pairAddress,
      };
   }

   return {
      kind: "token" as const,
      chainId: boost.chainId,
      tokenAddress: boost.tokenAddress,
   };
}

type PairKey = { chainId: string; pairAddress: string };

function pairKeyToString(p: PairKey) {
   return `${p.chainId.toLowerCase()}:${p.pairAddress.toLowerCase()}`;
}

async function mapLimit<T, R>(
   items: T[],
   limit: number,
   fn: (item: T) => Promise<R>,
) {
   const results: R[] = new Array(items.length);
   let nextIndex = 0;

   const workers = new Array(Math.min(limit, items.length))
      .fill(0)
      .map(async () => {
         for (;;) {
            const i = nextIndex;
            nextIndex++;
            const item = items[i];
            if (item === undefined) return;
            results[i] = await fn(item);
         }
      });

   await Promise.all(workers);
   return results;
}

async function fetchPairsMetaMap(
   pairs: PairKey[],
): Promise<Map<string, TokenMeta>> {
   const schema = z.object({
      pairs: z.array(
         z.object({
            chainId: z.string(),
            pairAddress: z.string(),
            baseToken: z.object({
               address: z.string(),
               name: z.string().optional(),
               symbol: z.string().optional(),
            }),
            info: z
               .object({
                  imageUrl: z.string().url().optional(),
                  header: z.string().url().optional(),
               })
               .optional(),
            marketCap: z.number().optional(),
            fdv: z.number().optional(),
         }),
      ),
   });

   const timeoutMs = Number(process.env.DEXSCREENER_TIMEOUT_MS ?? 8000);

   const uniq = new Map<string, PairKey>();
   for (const p of pairs) {
      uniq.set(pairKeyToString(p), p);
   }

   const uniqPairs = Array.from(uniq.values());

   const metas = await mapLimit(uniqPairs, 6, async (p) => {
      try {
         const url = `${DEXSCREENER_LATEST_PAIRS_BASE_URL}/${p.chainId}/${p.pairAddress}`;
         const json = await httpsGetJson(url, timeoutMs);
         const parsed = schema.parse(json);
         const first = parsed.pairs[0];
         if (!first) return null;

         const addr = first.baseToken.address.toLowerCase();
         const meta: TokenMeta = {
            name: first.baseToken.name,
            symbol: first.baseToken.symbol,
            imageUrl: first.info?.imageUrl,
            headerImageUrl: first.info?.header,
            marketCap: first.marketCap ?? first.fdv,
            pairAddress: first.pairAddress,
         };

         return { addr, meta };
      } catch {
         return null;
      }
   }).catch(() => []);

   const out = new Map<string, TokenMeta>();
   for (const m of metas) {
      if (!m) continue;
      out.set(m.addr, m.meta);
   }

   return out;
}

async function fetchPairsMetaByPairKey(
   pairs: PairKey[],
): Promise<Map<string, TokenMeta>> {
   const schema = z.object({
      pairs: z.array(
         z.object({
            chainId: z.string(),
            pairAddress: z.string(),
            baseToken: z.object({
               address: z.string(),
               name: z.string().optional(),
               symbol: z.string().optional(),
            }),
            info: z
               .object({
                  imageUrl: z.string().url().optional(),
                  header: z.string().url().optional(),
               })
               .optional(),
            marketCap: z.number().optional(),
            fdv: z.number().optional(),
         }),
      ),
   });

   const timeoutMs = Number(process.env.DEXSCREENER_TIMEOUT_MS ?? 8000);

   const uniq = new Map<string, PairKey>();
   for (const p of pairs) {
      uniq.set(pairKeyToString(p), p);
   }

   const uniqPairs = Array.from(uniq.values());

   const metas = await mapLimit(uniqPairs, 6, async (p) => {
      try {
         const url = `${DEXSCREENER_LATEST_PAIRS_BASE_URL}/${p.chainId}/${p.pairAddress}`;
         const json = await httpsGetJson(url, timeoutMs);
         const parsed = schema.parse(json);
         const first = parsed.pairs[0];
         if (!first) return null;

         const meta: TokenMeta = {
            name: first.baseToken.name,
            symbol: first.baseToken.symbol,
            imageUrl: first.info?.imageUrl,
            headerImageUrl: first.info?.header,
            marketCap: first.marketCap ?? first.fdv,
            pairAddress: first.pairAddress,
         };

         return { key: pairKeyToString(p), meta };
      } catch {
         return null;
      }
   }).catch(() => []);

   const out = new Map<string, TokenMeta>();
   for (const m of metas) {
      if (!m) continue;
      out.set(m.key, m.meta);
   }

   return out;
}

function dedupeBoosts(
   boosts: DexscreenerTopBoost[],
   limit: number,
): DexscreenerTopBoost[] {
   const seen = new Set<string>();
   const out: DexscreenerTopBoost[] = [];

   for (const boost of boosts) {
      const key = `${boost.chainId.toLowerCase()}:${boost.tokenAddress.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(boost);
      if (out.length >= limit) break;
   }

   return out;
}

async function fetchCombinedBoosts(
   limit: number,
): Promise<DexscreenerTopBoost[]> {
   const [top, latestBoosts, ads, profiles] = await Promise.all([
      fetchTopBoostsFromDexscreener(),
      fetchLatestBoostsFromDexscreener().catch(() => []),
      fetchLatestAdsFromDexscreener().catch(() => []),
      fetchLatestTokenProfilesFromDexscreener().catch(() => []),
   ]);

   return dedupeBoosts([...top, ...latestBoosts, ...ads, ...profiles], limit);
}

async function refreshTopBoostBubbles(limit: number): Promise<CacheState> {
   cache.lastAttemptedAtMs = Date.now();

   const boosts = await fetchCombinedBoosts(limit);

   const top = boosts.slice(0, limit);

   const addrs = top.map((b) => b.tokenAddress);
   const tokenMetaMap = await fetchTokenMetaMap(addrs).catch(() => new Map());

   const pairsToFetch: PairKey[] = [];

   for (const b of top) {
      const addr = b.tokenAddress.toLowerCase();

      const parsedPair = parsePairAddressFromUrl(b.url, b.chainId);
      if (parsedPair) {
         const existing = tokenMetaMap.get(addr);
         tokenMetaMap.set(addr, {
            ...(existing ?? {}),
            pairAddress: parsedPair,
         });
      }

      const pairAddress = tokenMetaMap.get(addr)?.pairAddress;
      if (pairAddress) {
         pairsToFetch.push({ chainId: b.chainId, pairAddress });
      }
   }

   const pairMetaMap = await fetchPairsMetaMap(pairsToFetch).catch(
      () => new Map(),
   );

   const nodes = top.map((b, idx) => {
      const addr = b.tokenAddress.toLowerCase();
      const meta = pairMetaMap.get(addr) ?? tokenMetaMap.get(addr);
      return mapBoostToBubbleNode(b, idx + 1, meta);
   });

   const state: CacheState = { updatedAtMs: Date.now(), data: nodes };
   cache.latest = state;
   cache.lastError = null;
   return state;
}

function mapBoostToRecentBubbleNode(
   entry: RecentEntry,
   rank: number,
): BubbleNode {
   const meta = entry.meta;
   return {
      ...mapBoostToBubbleNode(entry.boost, rank, meta),
      id: entry.key,
      rank,
   };
}

async function refreshRecentBoostBubbles(): Promise<RecentCacheState> {
   recentCache.lastAttemptedAtMs = Date.now();
   const now = Date.now();

   const boosts = await fetchCombinedBoosts(RECENT_CAPACITY);

   const addrs = boosts.map((b) => b.tokenAddress);
   const tokenMetaMap = await fetchTokenMetaMap(addrs).catch(() => new Map());

   const pairsToFetch: PairKey[] = [];

   for (const b of boosts) {
      const key = boostToTokenKey(b);
      const keyStr = tokenKeyToString(key);

      const existing = recentCache.entries.get(keyStr);
      const next: RecentEntry = {
         key: keyStr,
         boost: b,
         lastSeenAtMs: now,
         meta: existing?.meta,
      };

      recentCache.entries.set(keyStr, next);

      const addr = b.tokenAddress.toLowerCase();

      const parsedPair = key.kind === "pair" ? key.pairAddress : undefined;
      if (parsedPair) {
         const current = tokenMetaMap.get(addr);
         tokenMetaMap.set(addr, {
            ...(current ?? {}),
            pairAddress: parsedPair,
         });
         pairsToFetch.push({ chainId: b.chainId, pairAddress: parsedPair });
         continue;
      }

      const pairAddress = tokenMetaMap.get(addr)?.pairAddress;
      if (pairAddress) {
         pairsToFetch.push({ chainId: b.chainId, pairAddress });
      }
   }

   const pairMetaByPairKey = await fetchPairsMetaByPairKey(pairsToFetch).catch(
      () => new Map(),
   );

   for (const [keyStr, entry] of recentCache.entries) {
      if (now - entry.lastSeenAtMs > RECENT_TTL_MS) {
         recentCache.entries.delete(keyStr);
         continue;
      }

      const addr = entry.boost.tokenAddress.toLowerCase();

      const tokenKey = boostToTokenKey(entry.boost);
      const pairKey =
         tokenKey.kind === "pair"
            ? pairKeyToString({
                 chainId: tokenKey.chainId,
                 pairAddress: tokenKey.pairAddress,
              })
            : undefined;

      const meta =
         (pairKey ? pairMetaByPairKey.get(pairKey) : undefined) ??
         tokenMetaMap.get(addr) ??
         entry.meta;

      if (meta) {
         entry.meta = meta;
      }
   }

   const sorted = Array.from(recentCache.entries.values()).sort(
      (a, b) => b.lastSeenAtMs - a.lastSeenAtMs,
   );

   if (sorted.length > RECENT_CAPACITY) {
      const keep = new Set(sorted.slice(0, RECENT_CAPACITY).map((x) => x.key));
      for (const key of recentCache.entries.keys()) {
         if (!keep.has(key)) {
            recentCache.entries.delete(key);
         }
      }
   }

   const finalSorted = Array.from(recentCache.entries.values()).sort(
      (a, b) => b.lastSeenAtMs - a.lastSeenAtMs,
   );
   const nodes = finalSorted.map((e, idx) =>
      mapBoostToRecentBubbleNode(e, idx + 1),
   );

   const state: RecentCacheState = { updatedAtMs: Date.now(), data: nodes };
   recentCache.latest = state;
   recentCache.lastError = null;
   return state;
}

function ensureRecentRefreshInBackground(log?: {
   info: (obj: unknown, msg: string) => void;
   warn: (obj: unknown, msg: string) => void;
}) {
   if (recentCache.inFlight) return;

   recentCache.inFlight = (async () => {
      try {
         const state = await refreshRecentBoostBubbles();
         log?.info(
            { updatedAt: state.updatedAtMs },
            "Dexscreener recent 刷新成功",
         );
         return state;
      } catch (err) {
         recentCache.lastError = err;
         log?.warn({ err }, "Dexscreener recent 刷新失败");
         throw err;
      } finally {
         recentCache.inFlight = null;
      }
   })();

   void recentCache.inFlight.catch(() => undefined);
}

async function getRecentBoostBubbles(opts: {
   freshTtlMs: number;
   staleTtlMs: number;
   log?: {
      info: (obj: unknown, msg: string) => void;
      warn: (obj: unknown, msg: string) => void;
   };
}) {
   const now = Date.now();
   const latest = recentCache.latest;

   if (latest && now - latest.updatedAtMs <= opts.freshTtlMs) {
      return { state: latest, stale: false };
   }

   if (latest && now - latest.updatedAtMs <= opts.staleTtlMs) {
      ensureRecentRefreshInBackground(opts.log);
      return { state: latest, stale: true };
   }

   if (recentCache.inFlight) {
      const state = await recentCache.inFlight;
      return { state, stale: false };
   }

   recentCache.inFlight = refreshRecentBoostBubbles()
      .catch((err) => {
         recentCache.lastError = err;
         throw err;
      })
      .finally(() => {
         recentCache.inFlight = null;
      });

   const state = await recentCache.inFlight;
   return { state, stale: false };
}

function ensureRefreshInBackground(
   limit: number,
   log?: {
      info: (obj: unknown, msg: string) => void;
      warn: (obj: unknown, msg: string) => void;
   },
) {
   if (cache.inFlight) return;

   cache.inFlight = (async () => {
      try {
         const state = await refreshTopBoostBubbles(limit);
         log?.info(
            { updatedAt: state.updatedAtMs },
            "Dexscreener boosts 刷新成功",
         );
         return state;
      } catch (err) {
         cache.lastError = err;
         log?.warn({ err }, "Dexscreener boosts 刷新失败");
         throw err;
      } finally {
         cache.inFlight = null;
      }
   })();

   void cache.inFlight.catch(() => undefined);
}

async function getTopBoostBubbles(opts: {
   limit: number;
   freshTtlMs: number;
   staleTtlMs: number;
   log?: {
      info: (obj: unknown, msg: string) => void;
      warn: (obj: unknown, msg: string) => void;
   };
}) {
   const now = Date.now();
   const latest = cache.latest;

   if (
      latest &&
      now - latest.updatedAtMs <= opts.freshTtlMs &&
      latest.data.length >= opts.limit
   ) {
      return { state: latest, stale: false };
   }

   if (
      latest &&
      now - latest.updatedAtMs <= opts.staleTtlMs &&
      latest.data.length >= opts.limit
   ) {
      ensureRefreshInBackground(opts.limit, opts.log);
      return { state: latest, stale: true };
   }

   if (cache.inFlight) {
      const state = await cache.inFlight;
      return { state, stale: false };
   }

   cache.inFlight = refreshTopBoostBubbles(opts.limit)
      .catch((err) => {
         cache.lastError = err;
         throw err;
      })
      .finally(() => {
         cache.inFlight = null;
      });

   const state = await cache.inFlight;
   return { state, stale: false };
}

async function main() {
   const env: Env = envSchema.parse(process.env);

   const fastify = Fastify({
      logger: {
         level: process.env.LOG_LEVEL ?? "info",
      },
   });

   await fastify.register(cors, {
      origin: env.FRONTEND_ORIGIN ? [env.FRONTEND_ORIGIN] : true,
   });

   await fastify.register(rateLimit, {
      max: 120,
      timeWindow: "1 minute",
   });

   fastify.get("/api/v1/health", async () => {
      const latest = cache.latest;
      return {
         ok: true,
         cached: Boolean(latest),
         cacheAgeMs: latest ? Date.now() - latest.updatedAtMs : null,
         lastAttemptedAtMs: cache.lastAttemptedAtMs,
         lastError: cache.lastError ? "上游请求失败" : null,
      };
   });

   fastify.get("/api/v1/bubbles/top-boosts", async (request, reply) => {
      const parse = querySchema.safeParse(request.query);
      if (!parse.success) {
         return reply.status(400).send({
            message: "参数不合法",
            issues: parse.error.issues,
         });
      }

      const { limit } = parse.data;

      try {
         const { state, stale } = await getTopBoostBubbles({
            limit,
            freshTtlMs: 30_000,
            staleTtlMs: 120_000,
            log: {
               info: (obj, msg) => request.log.info(obj as object, msg),
               warn: (obj, msg) => request.log.warn(obj as object, msg),
            },
         });

         const payload: TopBoostBubblesResponse = {
            source: "dexscreener",
            endpoint: "/token-boosts/top/v1",
            limit,
            updatedAt: new Date(state.updatedAtMs).toISOString(),
            stale,
            data: state.data.slice(0, limit),
         };

         return reply.send(payload);
      } catch (err) {
         request.log.error({ err }, "拉取 Dexscreener boosts 失败");
         return reply.status(502).send({
            message: "上游数据源暂不可用，请稍后再试",
         });
      }
   });

   fastify.get("/api/v1/bubbles/recent", async (request, reply) => {
      const parse = recentQuerySchema.safeParse(request.query);
      if (!parse.success) {
         return reply.status(400).send({
            message: "参数不合法",
            issues: parse.error.issues,
         });
      }

      const { limit } = parse.data;

      try {
         const { state, stale } = await getRecentBoostBubbles({
            freshTtlMs: 30_000,
            staleTtlMs: 120_000,
            log: {
               info: (obj, msg) => request.log.info(obj as object, msg),
               warn: (obj, msg) => request.log.warn(obj as object, msg),
            },
         });

         const payload: RecentBoostBubblesResponse = {
            source: "dexscreener",
            endpoint: "/token-boosts/top/v1",
            mode: "recent",
            limit,
            updatedAt: new Date(state.updatedAtMs).toISOString(),
            stale,
            data: state.data.slice(0, limit),
         };

         return reply.send(payload);
      } catch (err) {
         request.log.error({ err }, "拉取 Dexscreener recent 失败");
         return reply.status(502).send({
            message: "上游数据源暂不可用，请稍后再试",
         });
      }
   });

   const port = env.PORT ?? 3001;
   const host = env.HOST ?? "0.0.0.0";

   const refreshIntervalMs = 30_000;

   const runSchedule = async () => {
      try {
         if (cache.latest === null) {
            ensureRefreshInBackground(30, fastify.log);
         }

         if (recentCache.latest === null) {
            ensureRecentRefreshInBackground(fastify.log);
         }
      } catch {
         return;
      }
   };

   void runSchedule();
   setInterval(() => {
      ensureRefreshInBackground(30, fastify.log);
      ensureRecentRefreshInBackground(fastify.log);
   }, refreshIntervalMs);

   await fastify.listen({ port, host });
   fastify.log.info({ port, host }, "API 服务已启动");
}

main().catch((err) => {
   console.error("服务启动失败", err);
   process.exit(1);
});
