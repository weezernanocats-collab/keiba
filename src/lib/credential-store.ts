/**
 * IPAT認証情報の暗号化保管モジュール
 *
 * AES-256-GCM で暗号化し、Turso に保存する。
 * 暗号化キーは IPAT_ENCRYPTION_KEY 環境変数（ローカルMacのみ）。
 * 平文はメモリ上のみで使用し、ディスクに書き出さない。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits

export interface IpatCredentials {
  inetId: string;
  memberNo: string;
  password: string;
  parsNo: string;
}

function getEncryptionKey(): Buffer {
  const keyHex = process.env.IPAT_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== KEY_LENGTH * 2) {
    throw new Error(
      'IPAT_ENCRYPTION_KEY が未設定または不正です。' +
      '64文字のhex文字列を .env.local に設定してください。\n' +
      '生成コマンド: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export function encrypt(credentials: IpatCredentials): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // GCM推奨: 12バイト
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(credentials);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, ivHex: string, authTagHex: string): IpatCredentials {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}
