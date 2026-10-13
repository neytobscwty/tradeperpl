export type Market = {
  id: number;
  symbol: string;
  name: string;
  size_units: string;
  funding_interval_sec: number;
  points_boost_bps?: number;
  order_ttl_blocks?: number;
  config: {
    is_open: boolean;
    price_decimals: number;
    size_decimals: number;
    maintenance_margin: number;
    initial_margin?: number;
    maker_fee?: number;
    maker_fees?: number[];
    taker_fee?: number;
    taker_fees?: number[];
  };
  state?: MarketState;
  funding?: FundingEvent;
};

export type MarketState = {
  at?: { b?: number; t?: number };
  orl: number;
  mrk: number;
  lst: number;
  mid: number;
  bid: number;
  ask: number;
  prv: number;
  dv: number;
  dva: number | string;
  oi: number;
  tvl: number;
};

type FundingEvent = { rate: number };
type Context = { markets: Market[] };
type TickerResponse = { d: Record<string, MarketState> };
export type Candle = { t: number; o: number; c: number; h: number; l: number; v: string; n: number };
type CandleResponse = { d: Candle[] };
export type BookResponse = {
  bid: Array<{ p: number; s: number; o: number }>;
  ask: Array<{ p: number; s: number; o: number }>;
};

export class PerplClient {
  private context: Context | null = null;
  private contextAt = 0;
  private tickerCache: { value: Record<string, MarketState>; at: number } | null = null;
  private tickerRequest: Promise<Record<string, MarketState>> | null = null;
  private bookCache = new Map<string, { value: BookResponse; at: number }>();
  private bookRequests = new Map<string, Promise<BookResponse>>();

  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Perpl API returned ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async markets(): Promise<Market[]> {
    if (!this.context || Date.now() - this.contextAt > 60_000) {
      this.context = await this.get<Context>("/v1/pub/context");
      this.contextAt = Date.now();
    }
    return this.context.markets;
  }

  async market(symbol: string): Promise<Market> {
    const normalized = symbol.trim().toUpperCase();
    const market = (await this.markets()).find((item) => marketSymbol(item) === normalized);
    if (!market) throw new Error(`Unknown market: ${normalized}`);
    return market;
  }

  async ticker(market: Market): Promise<MarketState> {
    const state = (await this.tickers())[String(market.id)];
    if (!state) throw new Error(`No ticker available for ${market.symbol}`);
    return state;
  }

  async tickers(): Promise<Record<string, MarketState>> {
    if (this.tickerCache && Date.now() - this.tickerCache.at < 1_500) return this.tickerCache.value;
    if (!this.tickerRequest) {
      this.tickerRequest = this.get<TickerResponse>("/v1/market-data/ticker")
        .then(payload => {
          this.tickerCache = { value: payload.d, at: Date.now() };
          return payload.d;
        })
        .finally(() => { this.tickerRequest = null; });
    }
    return this.tickerRequest;
  }

  async candles(market: Market, resolution = 3600, hours = 24, endTime = Date.now()): Promise<Candle[]> {
      const step = resolution * 1000;
      const to = Math.floor(endTime / step) * step;
    const from = to - hours * 60 * 60 * 1000;
    const payload = await this.get<CandleResponse>(
      `/v1/market-data/${market.id}/candles/${resolution}/${from}-${to}`,
    );
    return payload.d ?? [];
  }

  async book(market: Market, levels = 5): Promise<BookResponse> {
    const key = `${market.id}:${levels}`, cached = this.bookCache.get(key);
    if (cached && Date.now() - cached.at < 1_500) return cached.value;
    const existing = this.bookRequests.get(key);
    if (existing) return existing;
    const request = this.get<BookResponse>(`/v1/market-data/${market.id}/book?levels=${levels}`)
      .then(value => { this.bookCache.set(key, { value, at: Date.now() }); return value; })
      .finally(() => { this.bookRequests.delete(key); });
    this.bookRequests.set(key, request);
    return request;
  }
}

export function marketSymbol(market: Pick<Market, "symbol" | "name" | "size_units">): string {
  return (market.symbol || market.name || market.size_units).trim().toUpperCase();
}

export function scaled(value: number | string | undefined, decimals: number): number {
  return Number(value ?? 0) / 10 ** decimals;
}

export function money(value: number): string {
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : magnitude >= 0.01 ? 5 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

export function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
