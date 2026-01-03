import { LLMService } from "./llm-service";
import { AlBrooksLLMStrategy } from "./strategies/al-brooks-strategy";

export function createLLMService(configOverride?: any): LLMService {
  const strategyType = configOverride?.strategyType || "al-brooks";

  switch (strategyType) {
    case "al-brooks":
    default:
      return new AlBrooksLLMStrategy(configOverride);
  }
}
