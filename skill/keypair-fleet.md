# Keypair Fleet

> How to hold the keys for one signer, or twenty-four, without leaking them, losing them, or letting
> a single compromise drain everything.

Read this when an agent manages one or more **hot signer wallets**: storage, loading, rotation, and
keeping them funded enough to pay fees without sitting on a fat balance.

> Scope: this is about **operational hot keys** that sign routine transactions unattended. Treasury
> funds, program upgrade authority, and anything high-value belong behind a **multisig** (Squads) , 
> never in a hot fleet. See the boundary note at the end.

## The cardinal rules

1. **Never write a secret key to `/tmp`, a log, a commit, or a chat.** `/tmp` is world-readable on many
 systems and survives long enough to be scraped. A key that touched `/tmp` is a burned key, rotate it.
2. **A hot wallet holds only what it can afford to lose.** Fund it for fees + a small working balance,
 top up on a threshold, sweep excess to cold/multisig. A drained hot wallet should be an annoyance,
 not an incident.
3. **One blast radius per key.** If you run N agents, give them N keys so a single leak compromises 1/N
 of the operation, and you can rotate one without halting the fleet.
4. **Secrets come from the environment or a KMS, never from source.** Code references a key *by id*;
 the bytes live in env / a secrets manager / an encrypted file outside the repo.

## Where keys actually live (in order of preference)

| Tier | Mechanism | Use when |
|------|-----------|----------|
| Best | **KMS / HSM** (AWS KMS, GCP KMS, Turnkey, Fireblocks), key never leaves the vault; you call a *sign* API | Production with real value; compliance requirements |
| Good | **Secrets manager** (Vault, AWS/GCP Secrets Manager, Doppler) injected as env at runtime | Most production bots |
| OK | **Encrypted file** decrypted at startup with a passphrase from env (`age`, `sops`, libsodium secretbox) | Self-hosted, single box |
| Dev only | **Plain keypair JSON** outside the repo, `chmod 600`, path from env | Local/devnet only, never mainnet |
| Never | Hardcoded, in-repo, in `/tmp`, in env committed to `.env` that's tracked |, |

Load by reference, validate, and **zero the buffer** when you're done with the raw bytes:

```ts
import { createKeyPairSignerFromBytes } from "@solana/kit";

// The 64-byte secret arrives from env/KMS as a base58 or JSON array, never a literal in code.
async function loadSigner(secretBytes: Uint8Array) {
 const signer = await createKeyPairSignerFromBytes(secretBytes);
 secretBytes.fill(0); // best-effort scrub of the raw material once the signer holds it
 return signer;
}
```

> `.env` must be in `.gitignore`. Ship a committed `.env.example` with **public addresses only**, never
> secrets. The `/audit-agent-safety` command greps for this exact mistake.

## Managing a fleet (N wallets)

A fleet is a registry of `{ id, publicKey, secretRef }`, never a folder of bare JSON keypairs with the
secret inline. Each entry points at where its secret is fetched from.

```ts
type FleetMember = {
 id: string; // "agent-07"
 publicKey: string; // base58, safe to log
 secretRef: string; // "env:AGENT_07_SK" | "kms:projects/…/agent-07" | "file:./keys/agent-07.age"
};

// Resolve lazily, per-action, don't hold all secrets in memory at once if you can avoid it.
async function signerFor(member: FleetMember) {
 const bytes = await resolveSecret(member.secretRef); // env / KMS / decrypt-file
 return loadSigner(bytes);
}
```

**Selection strategy** matters operationally:

- **Round-robin / random** across the fleet spreads load and rate-limit exposure, and avoids one wallet
 becoming a fingerprinted, easily-front-run actor. (This is the pattern behind real 24-agent fleets.)
- **Sticky-by-task** when an action must continue from the same wallet (e.g. managing a position that
 wallet opened), pair with [idempotency.md](idempotency.md) so a re-run picks the same signer.

## Funding automation (the part everyone hand-rolls badly)

A bot that runs out of fee lamports silently stops working. Bake funding into the loop:

```ts
const FUND_THRESHOLD = 0.05 * LAMPORTS_PER_SOL; // below this, top up
const TOP_UP_TO = 0.20 * LAMPORTS_PER_SOL; // refill target
const MAX_HOT_BALANCE = 0.50 * LAMPORTS_PER_SOL; // above this, sweep excess to cold/multisig

async function ensureFunded(member: FleetMember, funder: TransactionSigner) {
 const { value: bal } = await rpc.getBalance(address(member.publicKey)).send();
 if (bal < FUND_THRESHOLD) {
 const need = TOP_UP_TO - Number(bal);
 await transferSol(funder, member.publicKey, need); // from a funder wallet or treasury withdrawal
 log.info({ member: member.id, topUp: need }, "funded agent");
 }
 if (bal > MAX_HOT_BALANCE) {
 await transferSol(await signerFor(member), COLD_ADDRESS, Number(bal) - TOP_UP_TO); // sweep
 }
}
```

Environment differences to encode:

- **Devnet/testnet**: top up via faucet/airdrop (`requestAirdrop`, rate-limited) before falling back to a funder.
- **Mainnet**: no faucet. Below threshold → **alert and reduce activity**, don't crash. Top-ups come
 from a funder wallet whose own balance you also monitor (the funder running dry is a fleet-wide outage).

Always check that the **funder** is solvent before a top-up cycle, and cap total top-ups per run
(a [safety.md](safety.md) spend cap) so a balance-read bug can't drain the funder.

## Rotation

Rotate a key when: it may have leaked, on a schedule for high-value fleets, or when an employee with
access leaves. Rotation without downtime:

```
1. Generate the new keypair; store its secret in KMS/secrets-manager under a new ref.
2. Add the new member to the registry as `active`; mark the old one `draining`.
3. Stop assigning new work to `draining` members; let in-flight actions finish.
4. Sweep the old wallet's balance to the new one (or cold).
5. Remove the old member once balance is 0 and no in-flight work references it.
```

Keep rotation a config/registry change, not a code change, so it can happen fast under incident pressure.

## Boundary: hot fleet vs. multisig (don't mix them)

| | Hot signer fleet (this file) | Multisig (Squads skill) |
|---|---|---|
| Holds | Fee lamports + small working balance | Treasury, reserves, program upgrade authority |
| Signs | Routine, automated txs | Rare, high-value, human-approved txs |
| Keys | Single-sig, in KMS/secrets, rotatable | M-of-N, distributed, hardware |
| If compromised | Lose ≤ one wallet's small balance | Catastrophic, protect accordingly |

> **War story → hard rule:** upgrade-authority or treasury keys must live in a multisig, and **every
> member keypair must be backed up off-box**. Keys staged in `/tmp` for a deploy and never persisted are
> gone the moment the box reboots, and an upgrade authority you can't sign with is a program you can
> never fix. Back up multisig members to durable, access-controlled storage *before* you fund anything.

## Checklist

- [ ] No secret key in source, logs, `/tmp`, or a tracked `.env`
- [ ] Secrets resolved by reference from env/KMS/secrets-manager at runtime
- [ ] One key per agent; blast radius is 1/N
- [ ] Funding threshold + top-up + sweep automated; funder solvency checked
- [ ] Devnet uses faucet, mainnet alerts instead of crashing on low funds
- [ ] Rotation is a registry change, no code deploy needed
- [ ] High-value funds are behind a multisig with off-box member backups, not in the hot fleet
