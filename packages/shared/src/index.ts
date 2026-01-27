export type DexscreenerBoostLink = {
  url: string;
  type?: string;
  label?: string;
};

export type DexscreenerTopBoost = {
  url: string;
  chainId: string;
  tokenAddress: string;
  description?: string;
  icon?: string;
  header?: string;
  openGraph?: string;
  links?: DexscreenerBoostLink[];
  totalAmount: number;
};

export type BubbleNode = {
  id: string;
  rank: number;
  chainId: string;
  tokenAddress: string;
  label: string;
  score: number;
  url: string;
  description?: string;
  iconUrl?: string;
  headerImageUrl?: string;
  links: DexscreenerBoostLink[];
};

export type TopBoostBubblesResponse = {
  source: "dexscreener";
  endpoint: "/token-boosts/top/v1";
  limit: number;
  updatedAt: string;
  stale: boolean;
  data: BubbleNode[];
};
