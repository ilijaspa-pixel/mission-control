// Claude pricing per million tokens (USD). Source: Anthropic pricing docs.
// We use standard tier; service_tier == "batch" would be 50% off but almost
// never used interactively from Claude Code.

export type ModelId = string;

type Rate = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

// Per-1M-token rates. Back-solved against Claude Code's own displayed cost
// for a known session (Opus 4.6 was ~20% cheaper than Opus 4.5 in practice,
// which matches what Anthropic shipped at GA).
const RATES: Record<string, Rate> = {
  // Opus 4.6 (current generation — reduced rates vs 4.5)
  "claude-opus-4-6": {
    input: 12,
    output: 60,
    cacheWrite5m: 15,
    cacheWrite1h: 24,
    cacheRead: 1.2,
  },
  // Opus 4.5 (previous generation — keep classic rates)
  "claude-opus-4-5": {
    input: 15,
    output: 75,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
  },
  // Sonnet 4.x
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
  },
  // Haiku 4.5
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
  },
};

const DEFAULT_RATE = RATES["claude-opus-4-6"];

function resolveRate(model: string): Rate {
  if (RATES[model]) return RATES[model];
  // Handle suffixes like "claude-opus-4-6[1m]"
  const base = model.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  if (RATES[base]) return RATES[base];
  // Fuzzy match by family
  if (model.includes("opus")) return RATES["claude-opus-4-6"];
  if (model.includes("sonnet")) return RATES["claude-sonnet-4-6"];
  if (model.includes("haiku")) return RATES["claude-haiku-4-5"];
  return DEFAULT_RATE;
}

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
};

/** Cost in USD for one assistant turn's usage record. */
export function costForUsage(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  const rate = resolveRate(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  // If ephemeral breakdown is present use it, else assume 5m writes.
  const cache5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const cache1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  const cacheCreateTotal = usage.cache_creation_input_tokens ?? 0;
  const write5m = cache5m ?? (cache1h != null ? 0 : cacheCreateTotal);
  const write1h = cache1h ?? 0;

  const cost =
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.cacheRead +
      write5m * rate.cacheWrite5m +
      write1h * rate.cacheWrite1h) /
    1_000_000;

  return cost;
}

export function displayModel(model: string): string {
  // "claude-opus-4-6" -> "Opus 4.6", "claude-sonnet-4-5" -> "Sonnet 4.5"
  const cleaned = model.replace(/\[.*\]$/, "");
  const m = cleaned.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!m) return model;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}.${m[3]}`;
}
