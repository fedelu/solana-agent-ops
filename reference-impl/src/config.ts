// Config, env-driven, validated at startup. NO secrets in code. (safety.md: validate inputs)
const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`config ${k} must be a non-negative number, got "${v}"`);
  return n;
};
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k];
  return v === undefined ? d : v === "true" || v === "1";
};

const CLUSTER = (process.env.CLUSTER ?? "devnet") as "devnet" | "testnet" | "mainnet-beta";
if (!["devnet", "testnet", "mainnet-beta"].includes(CLUSTER)) throw new Error(`bad CLUSTER: ${CLUSTER}`);

const defaultRpc: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export const config = {
  cluster: CLUSTER,
  rpcUrl: process.env.RPC_URL ?? defaultRpc[CLUSTER],
  dryRun: bool("DRY_RUN", true),
  agentSecret: process.env.AGENT_SECRET, // base58 or JSON byte array; if unset, dev key is generated
  amountLamports: BigInt(num("AMOUNT_LAMPORTS", 1000)),
  caps: {
    perTx: BigInt(num("CAP_PER_TX", 100_000)),
    perCycle: BigInt(num("CAP_PER_CYCLE", 200_000)),
    perDay: BigInt(num("CAP_PER_DAY", 2_000_000)),
    maxFee: BigInt(num("CAP_MAX_FEE", 50_000)),
  },
  funding: {
    threshold: BigInt(num("FUND_THRESHOLD_LAMPORTS", 50_000_000)),
    topUpTo: BigInt(num("FUND_TOPUP_TO_LAMPORTS", 200_000_000)),
  },
  ntfyTopic: process.env.NTFY_TOPIC,
  stateDir: ".state",
  cycleTimeoutMs: 90_000,
} as const;

// safety.md: mainnet requires the gate to have passed. The reference refuses to wire mainnet itself.
if (config.cluster === "mainnet-beta" && !config.dryRun && process.env.I_PASSED_THE_SAFETY_GATE !== "yes") {
  throw new Error(
    "Refusing to run live on mainnet from the reference bot. Pass the pre-mainnet gate (skill/safety.md) " +
      "and set I_PASSED_THE_SAFETY_GATE=yes once you have caps, breaker, kill switch, and monitoring verified.",
  );
}
