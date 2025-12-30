/**
 * Main Entry Point for LLM-PriceAction-Bot
 */
import { ConfigLoader } from "./config/loader";

async function main() {
    console.log("Starting LLM-PriceAction-Bot...");
    
    try {
        const config = new ConfigLoader();
        await config.load();
        
        // TODO: Initialize TradeManagers for each symbol and start loops
        console.log("System initialized. Monitoring markets...");
        
    } catch (error) {
        console.error("Failed to start system:", error);
        process.exit(1);
    }
}

main();