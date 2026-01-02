import dotenv from "dotenv";
import fs from "fs";
import toml from "@iarna/toml";
import path from "path";
import { logger } from "../utils/logger";

// Load environment variables immediately
dotenv.config();

export interface TelescopeConfig {
  micro_count: number;
  macro_group_size: number;
}

export interface StrategyConfig {
  timeframe: string;
  lookback_candles: number;
  risk_per_trade: number;
  max_open_positions: number;
  telescope: TelescopeConfig;
}

export interface SymbolsConfig {
  active: string[];
}

export interface ExecutionConfig {
  slippage_tolerance: number;
  entry_offset_ticks: number;
  min_notional: number;
  commission_rate_percent: number;
}

export interface AppConfig {
  // Environment Variables
  exchange: {
    id: string;
    isSandbox: boolean;
    apiKey: string;
    apiSecret: string;
    apiPassword?: string;
  };
  llm: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    visionEnabled: boolean;
    identityRole: string;
    logInteractions: boolean;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: "ignore" | "none" | "low" | "medium" | "high";
  };

  // TOML Strategy Config
  strategy: StrategyConfig;
  symbols: SymbolsConfig;
  execution: ExecutionConfig;
}

export class ConfigLoader {
  private static instance: AppConfig;

  private constructor() {}

  public static getInstance(): AppConfig {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = ConfigLoader.loadConfig();
    }
    return ConfigLoader.instance;
  }

  private static loadConfig(): AppConfig {
    // Parse TOML config
    const configPath = path.resolve(process.cwd(), "config.toml");
    let tomlConfig: any = {};

    try {
      const fileContent = fs.readFileSync(configPath, "utf-8");
      tomlConfig = toml.parse(fileContent);
    } catch (error) {
      logger.warn(
        `警告: 无法从 ${configPath} 加载 config.toml，正在使用默认值或失败。`
      );
      throw error;
    }

    // Determine if Sandbox
    const isSandbox = process.env.IS_SANDBOX === "true";

    const parsePercent = (
      rawValue: unknown,
      defaultPercent: number,
      fieldPath: string
    ): number => {
      const percent =
        typeof rawValue === "number" && Number.isFinite(rawValue)
          ? rawValue
          : defaultPercent;
      if (percent < 0 || percent > 100) {
        logger.warn(
          `警告: ${fieldPath} 配置无效 (${percent})，已回退为 ${defaultPercent}。`
        );
        return defaultPercent;
      }
      return percent;
    };

    const parseOptionalNumberInRange = (
      rawValue: unknown,
      min: number,
      max: number,
      fieldPath: string
    ): number | undefined => {
      if (rawValue === undefined || rawValue === null) return undefined;
      const value =
        typeof rawValue === "number" && Number.isFinite(rawValue)
          ? rawValue
          : NaN;
      if (!Number.isFinite(value) || value < min || value > max) {
        logger.warn(
          `警告: ${fieldPath} 配置无效 (${String(rawValue)})，已忽略。`
        );
        return undefined;
      }
      return value;
    };

    const parseOptionalPositiveInt = (
      rawValue: unknown,
      fieldPath: string
    ): number | undefined => {
      if (rawValue === undefined || rawValue === null) return undefined;
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
        logger.warn(
          `警告: ${fieldPath} 配置无效 (${String(rawValue)})，已忽略。`
        );
        return undefined;
      }
      if (rawValue <= 0) {
        logger.warn(`警告: ${fieldPath} 配置无效 (${rawValue})，已忽略。`);
        return undefined;
      }
      return Math.floor(rawValue);
    };

    const parseReasoningEffort = (
      rawValue: unknown
    ): "ignore" | "none" | "low" | "medium" | "high" | undefined => {
      if (rawValue === undefined || rawValue === null) return undefined;
      if (typeof rawValue !== "string") {
        logger.warn(
          `警告: llm.reasoning_effort 配置无效 (${String(rawValue)})，已忽略。`
        );
        return undefined;
      }

      const normalized = rawValue.trim().toLowerCase();
      if (normalized === "ignore") return "ignore";
      if (normalized === "none") return "none";
      if (normalized === "low") return "low";
      if (normalized === "medium") return "medium";
      if (normalized === "high") return "high";

      logger.warn(
        `警告: llm.reasoning_effort 配置无效 (${rawValue})，已忽略。`
      );
      return undefined;
    };

    const parseIdentityRole = (rawValue: unknown): string => {
      if (rawValue === undefined || rawValue === null) return "daytrader";
      if (typeof rawValue !== "string") {
        logger.warn(
          `警告: llm.identity_role 配置无效 (${String(
            rawValue
          )})，已回退为 daytrader。`
        );
        return "daytrader";
      }
      const trimmed = rawValue.trim();
      if (!trimmed) return "daytrader";
      return trimmed;
    };

    const riskPerTradePercent = parsePercent(
      tomlConfig.strategy?.risk_per_trade,
      1,
      "strategy.risk_per_trade"
    );
    const slippageTolerancePercent = parsePercent(
      tomlConfig.execution?.slippage_tolerance,
      0.1,
      "execution.slippage_tolerance"
    );

    const commission_rate_percent = parsePercent(
      tomlConfig.execution?.commission_rate_percent,
      0,
      "execution.commission_rate_percent"
    );

    const llmModel = process.env.LLM_MODEL || "deepseek-chat";
    const visionEnabled = process.env.VISION_LLM_ENABLED === "true";

    return {
      exchange: {
        id: process.env.EXCHANGE_ID || "bitget",
        isSandbox,
        apiKey: isSandbox
          ? process.env.DEMO_API_KEY || ""
          : process.env.PROD_API_KEY || "",
        apiSecret: isSandbox
          ? process.env.DEMO_API_SECRET || ""
          : process.env.PROD_API_SECRET || "",
        apiPassword: isSandbox
          ? process.env.DEMO_API_PASSWORD
          : process.env.PROD_API_PASSWORD,
      },
      llm: {
        provider: process.env.LLM_PROVIDER || "deepseek",
        apiKey: process.env.LLM_API_KEY || "",
        baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
        model: llmModel,
        visionEnabled,
        identityRole: parseIdentityRole(
          tomlConfig.llm?.identity_role ?? tomlConfig.llm?.identityRole
        ),
        logInteractions: tomlConfig.llm?.log_interactions || false,
        temperature: parseOptionalNumberInRange(
          tomlConfig.llm?.temperature,
          0,
          2,
          "llm.temperature"
        ),
        topP: parseOptionalNumberInRange(
          tomlConfig.llm?.top_p ?? tomlConfig.llm?.topP,
          0,
          1,
          "llm.top_p"
        ),
        maxTokens: parseOptionalPositiveInt(
          tomlConfig.llm?.max_tokens ?? tomlConfig.llm?.maxTokens,
          "llm.max_tokens"
        ),
        reasoningEffort: parseReasoningEffort(
          tomlConfig.llm?.reasoning_effort ?? tomlConfig.llm?.reasoningEffort
        ),
      },

      // TOML Strategy Config
      strategy: {
        timeframe: tomlConfig.strategy?.timeframe || "15m",
        lookback_candles: tomlConfig.strategy?.lookback_candles || 20,
        risk_per_trade: riskPerTradePercent / 100,
        max_open_positions: tomlConfig.strategy?.max_open_positions || 3,
        telescope: {
          micro_count: tomlConfig.strategy?.telescope?.micro_count || 30,
          macro_group_size:
            tomlConfig.strategy?.telescope?.macro_group_size || 6,
        },
      },
      symbols: {
        active: tomlConfig.symbols?.active || [],
      },
      execution: {
        slippage_tolerance: slippageTolerancePercent / 100,
        entry_offset_ticks: tomlConfig.execution?.entry_offset_ticks || 1,
        min_notional: tomlConfig.execution?.min_notional || 5.0,
        commission_rate_percent:
          commission_rate_percent >= 0 && commission_rate_percent <= 100
            ? commission_rate_percent
            : 0,
      },
    };
  }
}

export const config = ConfigLoader.getInstance();
