/**
 * OP-Stack specifics: the `0x7e` **deposit transaction** and its Merkle leaf.
 *
 * OP-Stack rollups (Base, OP Mainnet, ...) are Ethereum-equivalent except for one extra
 * transaction type. Every L2 block opens with a deposit transaction that writes the L1 block
 * attributes into the `L1Block` predeploy, and user deposits through the `OptimismPortal` are
 * delivered the same way. Deposit transactions are *unsigned* (they are derived from L1) and
 * carry three fields no L1 type has: `sourceHash`, `mint` and `isSystemTx`.
 *
 * ethers cannot represent the `0x7e` type as a `TransactionResponse`, so this module has its own
 * {@link DepositTransaction} type. Parsing it out of an RPC response is the caller's job.
 *
 * ## Specification references
 *
 * - Deposit transaction type and RLP layout: OP-Stack specs, `deposits.md`
 *   (`0x7E || rlp([sourceHash, from, to, mint, value, gas, isSystemTx, data])`).
 * - Receipt encoding: `op-geth` `core/types/receipt.go`, `Receipts.EncodeIndex`.
 *
 * ## Leaf layout (`txType = 126`)
 *
 * Three chunks, mirroring the V1 layout for types `0x0`-`0x2` so a decoder that already
 * understands the common and receipt chunks needs only the middle one:
 *
 * | chunk         | fields                                                                                  |
 * | ------------- | --------------------------------------------------------------------------------------- |
 * | `chunks[0]` common  | `(uint64 nonce, uint64 gasLimit, address from, bool toIsNull, address to, uint256 value, bytes data)` |
 * | `chunks[1]` deposit | `(bytes32 sourceHash, uint256 mint, bool isSystemTx)`                             |
 * | `chunks[2]` receipt | `(uint8 status, uint64 gasUsed, (address,bytes32[],bytes)[] logs, bytes logsBloom)` |
 *
 * `nonce` is the receipt's `depositNonce` when `depositReceiptVersion` is present (Canyon
 * and later), so it is authenticated by the header's `receiptsRoot`. Before Canyon neither the
 * transaction root nor the receipt root commits to a nonce: the leaf uses **zero**, meaning
 * unavailable, even if RPC metadata reports a nonzero execution nonce. Do not use that
 * historical zero to derive a contract-creation address. There are no signature fields:
 * deposits are unsigned.
 */
import { AbiCoder, encodeRlp, getAddress, keccak256, toBeHex, ZeroAddress } from 'ethers';
import type { TransactionReceipt } from 'ethers';
import type { EncodingResult } from './index';

/** EIP-2718 type byte of an OP-Stack deposit transaction. */
export const DEPOSIT_TX_TYPE = 0x7e;

/**
 * Raised when a deposit receipt reports a `depositReceiptVersion` but no `depositNonce`;
 * op-geth never produces this shape.
 */
export class MissingDepositNonceError extends Error {
  constructor() {
    super('deposit receipt has depositReceiptVersion but no depositNonce');
    this.name = 'MissingDepositNonceError';
  }
}

/** Deposit-specific receipt fields (`depositNonce` / `depositReceiptVersion`). */
export interface DepositReceiptFields {
  /** Sequencer-assigned deposit nonce (Regolith and later). */
  depositNonce?: bigint | number | null;
  /** Receipt encoding version (Canyon and later, currently always `1`). */
  depositReceiptVersion?: bigint | number | null;
}

/**
 * The nonce that goes into the leaf.
 *
 * Only Canyon and later receipt roots commit to the nonce. Earlier metadata must not
 * influence an attestation leaf, even when a provider happens to include it, so those
 * receipts canonicalize to zero.
 *
 * @throws {MissingDepositNonceError} if the receipt is versioned but carries no nonce
 */
export function canonicalNonce(fields: DepositReceiptFields): bigint {
  if (fields.depositReceiptVersion == null) {
    return 0n;
  }
  if (fields.depositNonce == null) {
    throw new MissingDepositNonceError();
  }
  return BigInt(fields.depositNonce);
}

/**
 * An OP-Stack deposit transaction as it appears in an L2 block.
 *
 * Field names follow the OP-Stack spec. `nonce` is not part of the transaction's consensus
 * encoding; set it from {@link canonicalNonce}.
 */
export interface DepositTransaction {
  /** Transaction hash. */
  hash: string;
  /**
   * Uniquely identifies the L1 origin of this deposit (user-deposited and L1-info deposits
   * derive it differently).
   */
  sourceHash: string;
  /** L2 sender. For the L1-attributes deposit this is the fixed depositor address. */
  from: string;
  /** Call target, or `null` for contract creation. */
  to: string | null;
  /** ETH minted on L2 as part of this deposit. */
  mint: bigint;
  /** ETH value transferred from `from` to `to`. */
  value: bigint;
  /** Gas limit. */
  gasLimit: bigint;
  /**
   * Whether the deposit is exempt from L2 gas accounting (always `false` since Regolith, but
   * still part of the encoding).
   */
  isSystemTx: boolean;
  /** Calldata. */
  input: string;
  /** Receipt-backed nonce since Canyon; zero (unavailable) before Canyon. */
  nonce: bigint;
}

/**
 * A deposit receipt. Only the fields that go into the leaf are required, so an ethers
 * `TransactionReceipt` satisfies it.
 */
export type DepositReceipt = Pick<TransactionReceipt, 'status' | 'gasUsed' | 'logsBloom'> & {
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>;
};

/** RLP integers are big-endian without leading zeros; zero is the empty string. */
function rlpUint(value: bigint): string {
  return value === 0n ? '0x' : toBeHex(value);
}

/** EIP-2718 encoding: `0x7e || rlp([sourceHash, from, to, mint, value, gas, isSystemTx, data])`. */
export function encode2718(tx: DepositTransaction): string {
  const payload = encodeRlp([
    tx.sourceHash,
    tx.from,
    tx.to ?? '0x',
    rlpUint(tx.mint),
    rlpUint(tx.value),
    rlpUint(tx.gasLimit),
    tx.isSystemTx ? '0x01' : '0x',
    tx.input,
  ]);
  return `0x${DEPOSIT_TX_TYPE.toString(16)}${payload.slice(2)}`;
}

/**
 * Hash of the EIP-2718 encoding. Equals `tx.hash` for a well-formed deposit, which lets
 * callers verify an RPC-reported hash against the fields they parsed.
 */
export function computedHash(tx: DepositTransaction): string {
  return keccak256(encode2718(tx));
}

/** Flat ABI types of the V1 deposit leaf, in field order across the three chunks. */
const DEPOSIT_TYPES_V1 = [
  // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
  'uint64',
  'uint64',
  'address',
  'bool',
  'address',
  'uint256',
  'bytes',
  // Chunk 2: Deposit fields (sourceHash, mint, isSystemTx)
  'bytes32',
  'uint256',
  'bool',
  // Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
  'uint8',
  'uint64',
  'tuple(address, bytes32[], bytes)[]',
  'bytes',
];

/**
 * ABI-encodes the V1 Merkle leaf for a (deposit tx, receipt) pair. See the
 * [module docs](./op-stack.ts) for the layout.
 */
export function abiEncodeDepositV1(tx: DepositTransaction, rx: DepositReceipt): EncodingResult {
  const coder = AbiCoder.defaultAbiCoder();

  const common = coder.encode(
    ['uint64', 'uint64', 'address', 'bool', 'address', 'uint256', 'bytes'],
    [tx.nonce, tx.gasLimit, tx.from, tx.to == null, tx.to ? getAddress(tx.to) : ZeroAddress, tx.value, tx.input],
  );

  const deposit = coder.encode(['bytes32', 'uint256', 'bool'], [tx.sourceHash, tx.mint, tx.isSystemTx]);

  // For status field, default to 1 (success) if undefined (pre-EIP-658 receipts), as for
  // the Ethereum encoder. A post-state receipt cannot occur on an OP-Stack chain.
  const receipt = coder.encode(
    ['uint8', 'uint64', 'tuple(address, bytes32[], bytes)[]', 'bytes'],
    [rx.status ?? 1, rx.gasUsed, rx.logs.map((log) => [log.address, log.topics, log.data]), rx.logsBloom],
  );

  const abi = coder.encode(['uint8', 'bytes[]'], [DEPOSIT_TX_TYPE, [common, deposit, receipt]]);

  return { types: DEPOSIT_TYPES_V1, abi };
}
