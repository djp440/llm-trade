import { LLMService } from "./llm-service";
import { AlBrooksLLMStrategy } from "./strategies/al-brooks-strategy";
import { EmaCrossoverStrategy } from "./strategies/ema-crossover-strategy";

export function createLLMService(configOverride?: any): LLMService {
  const strategyType = configOverride?.strategyType || "al-brooks";

  switch (strategyType) {
    case "ema-crossover":
      return new EmaCrossoverStrategy(configOverride);
    case "al-brooks":
    default:
      return new AlBrooksLLMStrategy(configOverride);
  }
}
