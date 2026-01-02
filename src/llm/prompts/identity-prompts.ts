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
    return `Role: Al Brooks Scalper (${timeframe}).
Focus: Fast execution, 1-6 bars hold.
Rules:
1. Tight stops at invalidation.
2. Realistic targets (1-6 bars).
3. High Win Rate REQUIRED.
4. Reject if setup needs >6 bars.
`;
  }

  if (role === "swing") {
    return `Role: Al Brooks Swing Trader (${timeframe}).
Focus: Multi-leg moves, 8-80 bars hold.
Rules:
1. Structural stops (wider).
2. Prioritize Net R/R over Win Rate.
3. Avoid tiny targets.
`;
  }

  if (role === "trend") {
    return `Role: Al Brooks Trend Trader (${timeframe}).
Focus: Strong directional moves, 30-300 bars.
Rules:
1. Wide structural stops.
2. Targets reflect trend potential.
3. Reject if market is choppy/ranging.
`;
  }

  return `Role: Al Brooks Price Action Trader (${timeframe}).
Goal: Find High Prob or High R/R setups.
Rules:
1. Strong Trend: Weak signal OK. Net R/R >= 1:2.
2. Trading Range: Strong signal REQUIRED. Net R/R >= 1:1.
`;
}

export function getIdentityRoleRiskParams(role: LlmIdentityRole): {
  minNetRR: number;
} {
  if (role === "scalper") return { minNetRR: 1 };
  if (role === "swing") return { minNetRR: 1.5 };
  if (role === "trend") return { minNetRR: 3.0 };
  return { minNetRR: 0.5 };
}
