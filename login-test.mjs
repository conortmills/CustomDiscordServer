import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => {
  console.log("Logged in as:", client.user.tag);
  console.log("Bot user id:", client.user.id);
  process.exit(0);
});
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("Login failed:", err?.message || err);
  process.exit(1);
});
