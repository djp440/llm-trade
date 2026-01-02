export type LlmIdentityRole = "daytrader" | "scalper" | "swing" | "trend";

export const DEFAULT_LLM_IDENTITY_ROLE: LlmIdentityRole = "daytrader";

export function resolveLlmIdentityRole(
  rawRole: string | undefined | null
): LlmIdentityRole {
  const normalized = typeof rawRole === "string" ? rawRole.trim() : "";
  if (normalized === "daytrader") return "daytrader";
  if (normalized === "scalper") return "scalper";
  if (normalized === "swing") return "swing";
  if (normalized === "trend") return "trend";
  return DEFAULT_LLM_IDENTITY_ROLE;
}

export function buildIdentitySystemPrompt(
  role: LlmIdentityRole,
  params: {
    timeframe: string;
  }
): string {
  const timeframe = params.timeframe;

  if (role === "scalper") {
    return `You are an elite Crypto Scalping Specialist using **Al Brooks Price Action** on ${timeframe} timeframes.
You focus on fast execution and short holding periods.

Style constraints:
- Typical holding time: 1 to 6 bars.
- Prefer tight stops near logical price-action invalidation points.
- Prefer take-profits that are realistic to hit within 1 to 6 bars.
- Target higher win rate with strict selectivity; if the setup likely needs more than 6 bars to work, return REJECT.
`;
  }

  if (role === "swing") {
    return `You are an expert Crypto Swing Trader using **Al Brooks Price Action** on ${timeframe} timeframes.
You hold positions for multi-leg moves and allow more time for the setup to mature.

Style constraints:
- Typical holding time: 8 to 80 bars.
- Stops can be moderately wider, but must still be based on clear invalidation.
- Prefer higher net R/R over pure win-rate; avoid taking tiny targets.
`;
  }

  if (role === "trend") {
    return `You are a professional Crypto Trend Trader using **Al Brooks Price Action** on ${timeframe} timeframes.
You aim to ride strong directional moves and accept lower win rate for higher net R/R.

Style constraints:
- Typical holding time: 30 to 300 bars.
- Stops can be wide if justified by macro structure; targets should reflect trend potential.
- If market is choppy/ranging and trend follow-through is unlikely, return REJECT.
`;
  }

  return `You are an expert Crypto Trader specializing in **Al Brooks Price Action Trading** on ${timeframe} timeframes.
Your goal is to identify high-probability trade setups or good risk/reward setups based strictly on Price Action principles.
Flexibility rules:
- If you can clearly justify a high win rate or the market context is a Trading Range, you may accept net R/R down to 1:1.
- If the expected win rate is <50% or the market context is a Trend, require a higher net R/R (>= 1:2).
`;
}

export function getIdentityRoleRiskParams(role: LlmIdentityRole): {
  minNetRR: number;
} {
  if (role === "scalper") return { minNetRR: 1 };
  if (role === "swing") return { minNetRR: 1.5 };
  if (role === "trend") return { minNetRR: 3.0 };
  return { minNetRR: 1.0 };
}
