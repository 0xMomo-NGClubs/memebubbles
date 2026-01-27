import https from "node:https";
import dotenv from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { BubbleNode, DexscreenerTopBoost, TopBoostBubblesResponse } from "@memebubbles/shared";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const DEXSCREENER_TOP_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1" as const;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().optional(),
  HOST: z.string().optional(),
  FRONTEND_ORIGIN: z.string().optional()
});

type Env = z.infer<typeof envSchema>;

function shortAddress(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function mapBoostToBubbleNode(boost: DexscreenerTopBoost, rank: number): BubbleNode {
  const id = `${boost.chainId}:${boost.tokenAddress}`;

  const links = (boost.links ?? []).map((l) => {
    const type = l.type;
    const label = l.label ?? (type === "twitter" ? "X" : type === "telegram" ? "Telegram" : undefined);
    return { url: l.url, type, label };
  });

  return {
    id,
    rank,
    chainId: boost.chainId,
    tokenAddress: boost.tokenAddress,
    label: shortAddress(boost.tokenAddress),
    score: boost.totalAmount,
    url: boost.url,
    description: boost.description,
    headerImageUrl: boost.header,
    iconUrl: undefined,
    links
  };
}

type CacheState = {
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
  lastAttemptedAtMs: null
};

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(30)
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
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN";
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
  maxSockets: 16
});

async function httpsGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "memebubbles/0.0.0"
        },
        agent: httpsAgent
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
                ? new Error("Dexscreener 返回 JSON 解析失败", { cause: err })
                : new Error("Dexscreener 返回 JSON 解析失败")
            );
          }
        });
      }
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

async function fetchTopBoostsFromDexscreener(): Promise<DexscreenerTopBoost[]> {
  const arrSchema = z.array(
    z.object({
      url: z.string().url(),
      chainId: z.string(),
      tokenAddress: z.string(),
      description: z.string().optional(),
      icon: z.string().optional(),
      header: z.string().optional(),
      openGraph: z.string().optional(),
      links: z
        .array(
          z.object({
            url: z.string().url(),
            type: z.string().optional(),
            label: z.string().optional()
          })
        )
        .optional(),
      totalAmount: z.number()
    })
  );

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const timeoutMs = Number(process.env.DEXSCREENER_TIMEOUT_MS ?? 8000);
      const json = await httpsGetJson(DEXSCREENER_TOP_BOOSTS_URL, timeoutMs);
      return arrSchema.parse(json);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableNetworkError(err)) {
        const prefix = `Dexscreener 请求失败（第 ${attempt}/${maxAttempts} 次）`;
        throw err instanceof Error ? new Error(prefix, { cause: err }) : new Error(prefix);
      }

      const delayMs = 200 * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }
  }

  throw new Error("Dexscreener 请求失败：未知原因");
}

async function refreshTopBoostBubbles(limit: number): Promise<CacheState> {
  cache.lastAttemptedAtMs = Date.now();

  const boosts = await fetchTopBoostsFromDexscreener();
  const nodes = boosts.slice(0, limit).map((b, idx) => mapBoostToBubbleNode(b, idx + 1));

  const state: CacheState = { updatedAtMs: Date.now(), data: nodes };
  cache.latest = state;
  cache.lastError = null;
  return state;
}

function ensureRefreshInBackground(
  limit: number,
  log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void }
) {
  if (cache.inFlight) return;

  cache.inFlight = (async () => {
    try {
      const state = await refreshTopBoostBubbles(limit);
      log?.info({ updatedAt: state.updatedAtMs }, "Dexscreener boosts 刷新成功");
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

async function getTopBoostBubbles(opts: { limit: number; freshTtlMs: number; staleTtlMs: number; log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void } }) {
  const now = Date.now();
  const latest = cache.latest;

  if (latest && now - latest.updatedAtMs <= opts.freshTtlMs) {
    return { state: latest, stale: false };
  }

  if (latest && now - latest.updatedAtMs <= opts.staleTtlMs) {
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
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  await fastify.register(cors, {
    origin: env.FRONTEND_ORIGIN ? [env.FRONTEND_ORIGIN] : true
  });

  await fastify.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute"
  });

  fastify.get("/api/v1/health", async () => {
    const latest = cache.latest;
    return {
      ok: true,
      cached: Boolean(latest),
      cacheAgeMs: latest ? Date.now() - latest.updatedAtMs : null,
      lastAttemptedAtMs: cache.lastAttemptedAtMs,
      lastError: cache.lastError ? "上游请求失败" : null
    };
  });

  fastify.get("/api/v1/bubbles/top-boosts", async (request, reply) => {
    const parse = querySchema.safeParse(request.query);
    if (!parse.success) {
      return reply.status(400).send({
        message: "参数不合法",
        issues: parse.error.issues
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
          warn: (obj, msg) => request.log.warn(obj as object, msg)
        }
      });

      const payload: TopBoostBubblesResponse = {
        source: "dexscreener",
        endpoint: "/token-boosts/top/v1",
        limit,
        updatedAt: new Date(state.updatedAtMs).toISOString(),
        stale,
        data: state.data.slice(0, limit)
      };

      return reply.send(payload);
    } catch (err) {
      request.log.error({ err }, "拉取 Dexscreener boosts 失败");
      return reply.status(502).send({
        message: "上游数据源暂不可用，请稍后再试"
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
    } catch {
      return;
    }
  };

  void runSchedule();
  setInterval(() => {
    ensureRefreshInBackground(30, fastify.log);
  }, refreshIntervalMs);

  await fastify.listen({ port, host });
  fastify.log.info({ port, host }, "API 服务已启动");
}

main().catch((err) => {
  console.error("服务启动失败", err);
  process.exit(1);
});
