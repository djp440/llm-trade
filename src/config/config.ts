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
    logInteractions: boolean;
    includeChart: boolean;
    chartLimit: number;
    chartHeight: number;
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

    const rawCommissionRatePercent =
      tomlConfig.execution?.commission_rate_percent;
    const commission_rate_percent =
      typeof rawCommissionRatePercent === "number" &&
      Number.isFinite(rawCommissionRatePercent)
        ? rawCommissionRatePercent
        : 0;

    if (commission_rate_percent < 0 || commission_rate_percent > 100) {
      logger.warn(
        `警告: execution.commission_rate_percent 配置无效 (${commission_rate_percent})，已回退为 0。`
      );
    }

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
        model: process.env.LLM_MODEL || "deepseek-chat",
        logInteractions: tomlConfig.llm?.log_interactions || false,
        includeChart: tomlConfig.llm?.include_chart ?? true,
        chartLimit: tomlConfig.llm?.chart_limit || 48,
        chartHeight: tomlConfig.llm?.chart_height || 20,
      },

      // TOML Strategy Config
      strategy: {
        timeframe: tomlConfig.strategy?.timeframe || "15m",
        lookback_candles: tomlConfig.strategy?.lookback_candles || 20,
        risk_per_trade: tomlConfig.strategy?.risk_per_trade || 0.01,
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
        slippage_tolerance: tomlConfig.execution?.slippage_tolerance || 0.001,
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
