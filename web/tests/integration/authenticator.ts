// A passkey in software: what a browser and an authenticator do in a WebAuthn ceremony, with real keys and signatures,
// so the tests run Better Auth's own verification and can answer from any origin, with or without user verification.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
}

function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const url64 = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

export interface Ceremony {
  challenge: string;
  rpId: string;
  origin: string;
  verified: boolean;
}

export class SoftwarePasskey {
  readonly id = randomBytes(16).toString("base64url");
  readonly #keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  #counter = 0;

  #authenticatorData(rpId: string, flags: number, attested: Buffer = Buffer.alloc(0)): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE((this.#counter += 1));
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, attested]);
  }

  // The answer to navigator.credentials.create(), attested with fmt "none".
  attestation({ challenge, rpId, origin, verified }: Ceremony): Record<string, unknown> {
    const jwk = this.#keys.publicKey.export({ format: "jwk" });
    const coseKey = cbor(
      new Map<number, Cbor>([
        [1, 2], // EC2
        [3, -7], // ES256
        [-1, 1], // P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ])
    );
    const credentialId = Buffer.from(this.id, "base64url");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, credentialId, coseKey]);
    const flags = USER_PRESENT | ATTESTED_CREDENTIAL | (verified ? USER_VERIFIED : 0);
    const authData = this.#authenticatorData(rpId, flags, attested);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: url64(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })),
        attestationObject: url64(
          cbor(
            new Map<string, Cbor>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", authData],
            ])
          )
        ),
        transports: ["internal"],
      },
    };
  }

  // The answer to navigator.credentials.get(), signed with the passkey's key.
  assertion({ challenge, rpId, origin, verified }: Ceremony): Record<string, unknown> {
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false });
    const authenticatorData = this.#authenticatorData(rpId, USER_PRESENT | (verified ? USER_VERIFIED : 0));
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.#keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: { clientDataJSON: url64(clientDataJSON), authenticatorData: url64(authenticatorData), signature: url64(signature) },
    };
  }
}
