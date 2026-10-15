/**
 * Standard Ethereum transaction types (`0x0`-`0x4`) and their Merkle leaf encodings, one file per
 * encoding version. Also the encoding of the non-deposit transactions of an OP-Stack block.
 */
import { TransactionReceipt } from 'ethers';
import { EncodingResult, EncodingVersion } from '../common';
import { TransactionWithRaw } from '../../common';
import { abiEncode as abiEncodeV1 } from './v1';

/**
 * ABI-encodes the Merkle leaf for an Ethereum transaction and its receipt according to the
 * specified encoding version.
 */
export function abiEncode(
  tx: TransactionWithRaw,
  rx: TransactionReceipt,
  encoding: EncodingVersion = EncodingVersion.V1,
): EncodingResult {
  switch (encoding) {
    case EncodingVersion.V1:
      return abiEncodeV1(tx, rx);
    default:
      return abiEncodeV1(tx, rx);
  }
}
