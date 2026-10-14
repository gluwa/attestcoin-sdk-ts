import { TransactionReceipt } from 'ethers';
import { abiEncode as abiEncodeV1 } from './v1';
import { abiEncodeDepositV1, DepositReceipt, DepositTransaction } from './op-stack';
import { TransactionWithRaw } from '../common';

export * as opStack from './op-stack';
export type { DepositReceipt, DepositTransaction } from './op-stack';

export enum EncodingVersion {
  V1 = 1,
}

export type EncodingResult = {
  types: string[];
  abi: string;
};

/**
 * A transaction and its receipt, ready to be encoded into a Merkle leaf.
 *
 * The `kind` selects the leaf layout.
 */
export type TxRxInput =
  /**
   * A standard Ethereum transaction (types `0x0`-`0x4`) and its receipt. Also the right
   * variant for the non-deposit transactions of an OP-Stack block.
   */
  | { kind: 'ethereum'; tx: TransactionWithRaw; rx: TransactionReceipt }
  /** An OP-Stack deposit transaction (type `0x7e`) and its receipt. */
  | { kind: 'opDeposit'; tx: DepositTransaction; rx: DepositReceipt };

/**
 * Encodes a given transaction and its receipt into ABI format according to the specified
 * encoding version.
 *
 * For `kind: 'ethereum'` the transaction and receipt are expected to comply with the ethereum
 * specifications as modelled by `ethers`; for `kind: 'opDeposit'`, with the OP-Stack
 * specification (see {@link opStack}).
 */
export function abiEncode(input: TxRxInput, encoding: EncodingVersion = EncodingVersion.V1): EncodingResult {
  switch (input.kind) {
    case 'ethereum':
      switch (encoding) {
        case EncodingVersion.V1:
          return abiEncodeV1(input.tx, input.rx);
        default:
          return abiEncodeV1(input.tx, input.rx);
      }
    case 'opDeposit':
      // Matching exhaustively makes a future encoding version a compile error here instead of a
      // silently V1-shaped deposit leaf.
      switch (encoding) {
        case EncodingVersion.V1:
          return abiEncodeDepositV1(input.tx, input.rx);
        default: {
          const unsupported: never = encoding;
          throw new Error(`Unsupported encoding version for OP-Stack deposits: ${unsupported}`);
        }
      }
  }
}
