// Prints a fresh Ed25519 signing key for JWT_PRIVATE_KEY (base64 of the PEM).
// Usage: node scripts/generate-jwt-key.mjs >> .env
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.stdout.write(`JWT_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}\n`);
