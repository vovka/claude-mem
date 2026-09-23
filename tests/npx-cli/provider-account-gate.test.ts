import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

const source = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

describe('providerNeedsAccount', () => {
  it.each([
    ['claude', false],
    ['host', false],
    ['opencode', false],
    ['gemini', true],
    ['openrouter', true],
    [undefined, true],
  ] as const)('%s → %s', (provider, expected) => {
    expect(providerNeedsAccount(provider)).toBe(expected);
  });
});

describe('install flow wiring', () => {
  it('gates the OAuth login call behind providerNeedsAccount', () => {
    expect(source).toMatch(
      /if \(providerNeedsAccount\(options\.provider\)\) \{\s*\n\s*oauthPairing = await requireInstallerOAuthLogin\(version\);/,
    );
  });

  it('refuses CMEM Pro enrollment without a pairing', () => {
    expect(source).toContain("throw new Error('CMEM Pro requires a signed-in claude-mem account.');");
  });
});
