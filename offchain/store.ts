import * as fs from "fs";
import * as path from "path";
import { JsonMessage } from "./lib";

export interface SignatureRecord {
  digest: string;
  message: JsonMessage;
  signature: string;
  signer: string;
  sourceChain: string;
  txHash: string;
  logIndex: number;
  signedAt: string;
}

interface StoreShape {
  watermarks: Record<string, number>; // last fully processed block per chain
  signatures: Record<string, SignatureRecord>; // keyed by digest
  submitted: Record<string, string>; // digest -> tx hash (relayer only)
}

/**
 * Tiny durable JSON store. Writes go to a temp file then rename, so a crash
 * mid-write never corrupts the previous state. Adequate for testnet volumes;
 * swap for sqlite/postgres before production.
 */
export class JsonStore {
  private data: StoreShape;

  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
      this.data.watermarks ??= {};
      this.data.signatures ??= {};
      this.data.submitted ??= {};
    } else {
      this.data = { watermarks: {}, signatures: {}, submitted: {} };
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  getWatermark(chain: string): number | undefined {
    return this.data.watermarks[chain];
  }

  setWatermark(chain: string, block: number) {
    this.data.watermarks[chain] = block;
    this.save();
  }

  hasSignature(digest: string): boolean {
    return digest in this.data.signatures;
  }

  addSignature(rec: SignatureRecord) {
    this.data.signatures[rec.digest] = rec;
    this.save();
  }

  allSignatures(): SignatureRecord[] {
    return Object.values(this.data.signatures);
  }

  getSignature(digest: string): SignatureRecord | undefined {
    return this.data.signatures[digest];
  }

  isSubmitted(digest: string): boolean {
    return digest in this.data.submitted;
  }

  markSubmitted(digest: string, txHash: string) {
    this.data.submitted[digest] = txHash;
    this.save();
  }
}
