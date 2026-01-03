# LLM 交易服务模块

本模块定义了与大语言模型 (LLM) 交互的核心接口，用于市场分析、交易信号生成和挂单管理。采用策略模式设计，支持多种交易策略的灵活切换。

## 核心接口：LLMService

`LLMService` 是所有 LLM 交易策略必须实现的接口。它定义了系统与 LLM 交互的标准契约。

### 接口定义

```typescript
export interface LLMService {
  // 验证模型是否具备视觉分析能力
  validateVisionCapability(): Promise<boolean>;

  // 测试与 LLM 服务的连接
  testConnection(): Promise<boolean>;

  // 获取本次会话的总 Token 使用量
  getTotalTokenUsage(): number;

  // 分析市场并生成交易信号（核心方法）
  analyzeMarket(
    symbol: string,
    tradingData: OHLC[], // 交易周期数据 (如 5m)
    contextData: OHLC[], // 上下文周期数据 (如 1h)
    trendData: OHLC[],   // 趋势周期数据 (如 4h)
    accountEquity: number,
    riskPerTrade: number,
    options?: {
      enableImageAnalysis?: boolean;
      timeframes?: { trading: string; context: string; trend: string };
    }
  ): Promise<TradeSignal>;

  // 检查挂单的有效性
  checkPendingOrderValidity(
    symbol: string,
    currentPrice: number,
    order: any,
    ohlcContext: string
  ): Promise<PendingOrderDecision>;

  // 分析挂单逻辑
  analyzePendingOrder(
    symbol: string,
    tradingData: OHLC[],
    contextData: OHLC[],
    trendData: OHLC[],
    accountEquity: number,
    riskPerTrade: number,
    pendingOrder: {
      action: "BUY" | "SELL";
      entryPrice: number;
      reason: string;
    }
  ): Promise<PendingOrderDecision>;
}
```

## 现有策略

### Al Brooks Price Action Strategy
- **类名**: `AlBrooksLLMStrategy`
- **文件**: `src/llm/strategies/al-brooks-strategy.ts`
- **描述**: 基于 Al Brooks 的价格行为学理论，结合多时间框架分析和 K 线形态识别（支持视觉分析）。

## 使用指南

### 1. 获取服务实例

使用工厂方法 `createLLMService` 获取当前配置的策略实例：

```typescript
import { createLLMService } from "./llm/llm-factory";

const llmService = createLLMService();
```

### 2. 扩展新策略

要添加新的交易策略（例如 "Wyckoff" 策略），请遵循以下步骤：

1. 在 `src/llm/strategies/` 目录下创建新文件（如 `wyckoff-strategy.ts`）。
2. 实现 `LLMService` 接口：

```typescript
import { LLMService } from "../llm-service";
// ... 其他导入

export class WyckoffStrategy implements LLMService {
  // 实现接口中定义的所有方法
  async analyzeMarket(...) {
    // Wyckoff 具体的分析逻辑
  }
  // ...
}
```

3. 修改 `src/llm/llm-factory.ts` 以支持新策略的选择（可以通过环境变量或配置参数）：

```typescript
export function createLLMService(configOverride?: any): LLMService {
  // 示例：根据配置返回不同策略
  if (configOverride?.strategy === 'wyckoff') {
      return new WyckoffStrategy(configOverride);
  }
  return new AlBrooksLLMStrategy(configOverride);
}
```

## 目录结构

- `llm-service.ts`: 核心接口定义
- `llm-factory.ts`: 实例创建工厂
- `strategies/`: 具体策略实现目录
- `prompts/`: LLM 提示词模板
- `context-builder.ts`: 构建发送给 LLM 的上下文数据
