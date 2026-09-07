import { randomBytes, createHash } from 'crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
