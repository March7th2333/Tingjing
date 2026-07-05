declare module "qrc-decoder" {
  export function decryptQrc(encryptedHexString: string): string;
  export function encryptQrc(plaintext: string): string;
}
