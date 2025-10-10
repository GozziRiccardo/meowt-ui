import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";

const outFile = path.join(process.cwd(), "public", "tokenlist.json");
const raw = (process.env.VITE_TOKEN_ADDRESS || process.env.TOKEN_ADDRESS || "").trim();
if (!raw) { console.error("[gen-tokenlist] Missing VITE_TOKEN_ADDRESS"); process.exit(1); }
if (!isAddress(raw)) { console.error("[gen-tokenlist] Invalid address:", raw); process.exit(1); }
const checksummed = getAddress(raw);

const list = {
  name: "HearMeOwT List",
  timestamp: new Date().toISOString(),
  version: { major: 1, minor: 0, patch: 0 },
  logoURI: "https://www.hearmeowt.app/brand/logo-meowt-192.png",
  keywords: ["meowt", "base", "hearmeowt", "billboard"],
  tags: { official: { name: "Official", description: "Official HearMeOwT tokens" } },
  tokens: [
    {
      chainId: 8453,
      address: checksummed,
      name: "MEOWT",
      symbol: "MEOWT",
      decimals: 18,
      logoURI: "https://www.hearmeowt.app/brand/logo-meowt-192.png",
      tags: ["official"]
    }
  ]
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(list, null, 2));
console.log(`[gen-tokenlist] Wrote ${outFile}`);
