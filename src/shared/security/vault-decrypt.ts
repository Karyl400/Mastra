import { createDecipheriv } from 'crypto';

import { ENCRYPTION_ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH } from './vault-constants';

export function decryptWithKeyRing(
  encryptedData: string,
  keys: readonly Buffer[],
  activeVersion: number,
): string {
  const encrypted = Buffer.from(encryptedData, 'base64');

  const version = encrypted.readUInt32BE(0);
  const key = keys[activeVersion - version] || keys[0];

  const iv = encrypted.subarray(4, 4 + IV_LENGTH);
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(4 + IV_LENGTH, encrypted.length - AUTH_TAG_LENGTH);

  const errors: Error[] = [];

  for (const tryKey of [key, ...keys.filter((k) => k !== key)]) {
    try {
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, tryKey as Buffer, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error) {
      errors.push(error as Error);
    }
  }

  throw new Error(
    `Decryption failed with all available keys: ${errors.map((e) => e.message).join('; ')}`,
  );
}
