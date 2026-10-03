import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  process.stderr.write('deploy/.env already exists; leaving it unchanged.\n');
  process.exit(1);
}
mkdirSync(join(root, 'secrets', 'platform'), { recursive: true, mode: 0o700 });
const contents = [
  `ACCOUNT_JWT_SECRET=${randomBytes(48).toString('hex')}`,
  'ACCOUNT_PLATFORM_ADMIN_IDS=',
  'ACCOUNT_REQUIRE_HTTPS=false',
  'ACCOUNT_PUBLIC_BASE_URL=http://localhost:8080',
  'ACCOUNT_EMAIL_VERIFY_BASE_URL=',
  'ACCOUNT_MAIL_WEBHOOK_URL=',
  'EC_WEB_PORT=8080',
  'EC_ELECTRON_DOWNLOAD_URL=',
  'EC_TAURI_DOWNLOAD_URL=',
  '',
].join('\n');
writeFileSync(envPath, contents, { flag: 'wx', mode: 0o600 });
if (process.platform !== 'win32') chmodSync(envPath, 0o600);
process.stdout.write('Created deploy/.env with a random local JWT secret. It is ignored by Git.\n');
process.stdout.write('Leave the admin allowlist empty until local accounts have been registered.\n');
