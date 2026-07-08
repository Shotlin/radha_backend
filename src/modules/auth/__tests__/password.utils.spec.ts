import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
} from '../utils/password.utils';

describe('password.utils', () => {
  it('hashPassword produces a bcrypt cost-12 hash', async () => {
    const hash = await hashPassword('Str0ng!Phrase-AB');
    expect(hash.startsWith('$2')).toBe(true);
    expect(hash).toMatch(/\$12\$/); // bcrypt cost segment
  });

  it('verifyPassword round-trips and rejects mismatches', async () => {
    const hash = await hashPassword('Str0ng!Phrase-AB');
    expect(await verifyPassword('Str0ng!Phrase-AB', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('generateOpaqueToken produces matching plaintext + sha256 hash', () => {
    const { plaintext, hash } = generateOpaqueToken();
    expect(plaintext.length).toBeGreaterThan(40);
    expect(hash).toBe(hashOpaqueToken(plaintext));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces distinct tokens across calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 64; i += 1) set.add(generateOpaqueToken().plaintext);
    expect(set.size).toBe(64);
  });
});
