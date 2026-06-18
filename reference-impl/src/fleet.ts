// Signer custody + funding. Secrets by reference; dev key persisted to gitignored .state. (keypair-fleet.md)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  address,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  lamports,
  type KeyPairSigner,
} from "@solana/kit";
import { config } from "./config.ts";
import { rpc, withRetry } from "./rpc.ts";
import { log } from "./monitor.ts";

// Accept a base58 secret (64 or 32 bytes) or a JSON byte array. Minimal base58 decode (no extra dep).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  let bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 char: ${ch}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

async function signerFromSecretBytes(bytes: Uint8Array): Promise<KeyPairSigner> {
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`secret must be 32 or 64 bytes, got ${bytes.length}`);
}

// Load by reference (env), else generate a dev seed persisted to .state (devnet convenience only).
export async function loadSigner(): Promise<KeyPairSigner> {
  if (config.agentSecret) {
    const raw = config.agentSecret.trim();
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw) as number[]) : base58Decode(raw);
    const signer = await signerFromSecretBytes(bytes);
    bytes.fill(0); // best-effort scrub of raw material
    return signer;
  }
  if (config.cluster === "mainnet-beta") {
    throw new Error("Refusing to auto-generate a hot key on mainnet. Set AGENT_SECRET from KMS/secrets.");
  }
  mkdirSync(config.stateDir, { recursive: true });
  const seedPath = join(config.stateDir, "dev-seed.json");
  let seed: Uint8Array;
  if (existsSync(seedPath)) {
    seed = Uint8Array.from(JSON.parse(readFileSync(seedPath, "utf8")) as number[]);
  } else {
    seed = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(seedPath, JSON.stringify(Array.from(seed))); // gitignored; devnet only
    log.info("generated dev seed (gitignored, .state/dev-seed.json)");
  }
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  log.info("loaded signer", { address: signer.address });
  return signer;
}

// Funding: top up below threshold. Devnet uses airdrop; mainnet would alert + use a funder. (keypair-fleet.md)
export async function ensureFunded(signer: KeyPairSigner): Promise<void> {
  const { value: bal } = await withRetry(() => rpc.getBalance(address(signer.address)).send());
  if (bal >= config.funding.threshold) {
    log.info("funded", { address: signer.address, balanceLamports: bal });
    return;
  }
  const need = config.funding.topUpTo - bal;
  if (config.cluster === "mainnet-beta") {
    log.warn("below funding threshold on mainnet, would top up from funder & reduce activity", { need });
    return; // mainnet: alert + back off, never crash
  }
  log.info("requesting devnet airdrop", { address: signer.address, lamports: Number(need) });
  try {
    await withRetry(() => rpc.requestAirdrop(address(signer.address), lamports(need)).send(), { max: 3 });
    for (let i = 0; i < 15; i++) {
      const { value } = await rpc.getBalance(address(signer.address)).send();
      if (value >= config.funding.threshold) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    log.warn("airdrop not reflected yet, continuing (faucet may be rate-limited)");
  } catch (e) {
    log.warn("airdrop failed (devnet faucet rate-limited), continuing", { err: String(e) });
  }
}
