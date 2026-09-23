import { describe, it, expect } from 'bun:test';
import { redactSecrets, redactSecretsDeep } from '../../src/utils/redact-secrets.js';

// Every credential-shaped fixture below is built via string concatenation on
// purpose: a contiguous literal in this exact shape trips GitHub's secret
// scanner even though it is fake, so no full token ever appears as one token
// in the source.
const suffix = '1234567890123456789012345678901234AB';
const openAiSuffix = 'abcdefghijklmnopqrstuvwx1234567890';
const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIBOwIBAAJBAKj34GkxFhD91' + '\n-----END RSA PRIVATE KEY-----';
const jwt =
  'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redactSecrets', () => {
  it.each([
    ['PEM private key block', `key: ${pem}`, 'key: [REDACTED:private_key]'],
    ['AWS access key id', `id is ${'AKIA' + 'IOSFODNN7EXAMPLE'} done`, 'id is [REDACTED:aws_access_key_id] done'],
    ['aws_secret_access_key assignment', `aws_secret_access_key=${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY'}`,
      'aws_secret_access_key=[REDACTED:field:aws_secret_access_key]'],
    ['ghp_ token', `token ghp_${suffix}`, 'token [REDACTED:github_token]'],
    ['gho_ token', `token gho_${suffix}`, 'token [REDACTED:github_token]'],
    ['github_pat_ token', 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      '[REDACTED:github_token]'],
    ['Anthropic key', `ANTHROPIC_API_KEY=${'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz0123456789'}`,
      'ANTHROPIC_API_KEY=[REDACTED:anthropic_key]'],
    ['legacy OpenAI key', 'sk-' + openAiSuffix, '[REDACTED:openai_key]'],
    ['sk-proj- OpenAI key', 'sk-proj-' + openAiSuffix, '[REDACTED:openai_key]'],
    ['Google API key', 'AIzaSyD-' + '1234567890abcdefghijklmnopqrstuv', '[REDACTED:google_api_key]'],
    ['Slack token', 'xoxb-' + '1234567890-1234567890123-abcdefghijklmnopqrstuvwx', '[REDACTED:slack_token]'],
    ['Stripe sk_live key', 'sk_live_' + '1'.repeat(24), '[REDACTED:stripe_key]'],
    ['Stripe rk_live key', 'rk_live_' + '1'.repeat(24), '[REDACTED:stripe_key]'],
    ['JWT', jwt, '[REDACTED:jwt]'],
    ['Authorization: Bearer header', 'Authorization: Bearer abcdef123456',
      'Authorization: Bearer [REDACTED:auth_header]'],
    ['URL credentials', 'connect to postgres://user:hunter2@db.internal:5432/app',
      'connect to postgres://[REDACTED:url_credentials]@db.internal:5432/app'],
    ['PASSWORD= assignment', 'PASSWORD=hunter2secret', 'PASSWORD=[REDACTED:field:password]'],
    ['quoted JSON password', '{"password": "hunter2"}', '{"password": "[REDACTED:field:password]"}'],
    ['YAML token: value', 'token: abcdef123456', 'token: [REDACTED:field:token]'],
    ['--password CLI flag', 'mysql --password supersecret123 -u root',
      'mysql --password [REDACTED:field:password] -u root'],
    ['XML credential element', '<soap:Body><Password>hunter2secret</Password></soap:Body>',
      '<soap:Body><Password>[REDACTED:field:password]</Password></soap:Body>'],
    ['<apiKey> XML element', '<apiKey>abcdef123456</apiKey>', '<apiKey>[REDACTED:field:apikey]</apiKey>'],
  ])('redacts %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  // Ordinary code and prose must survive untouched.
  it.each([
    'function login(password: string, token: number) {}',
    'if (token.length > 0) { return getToken(); }',
    'Remind the user to reset their password after the token expires.',
    'interface Auth { secret: string; }',
  ])('leaves %s alone', (src) => {
    expect(redactSecrets(src)).toBe(src);
  });
});

describe('redactSecretsDeep', () => {
  it('redacts by key recursively, pattern-redacts other string leaves, and recurses arrays', () => {
    const out = redactSecretsDeep({
      auth: { headers: { Authorization: 'ignored-by-key' }, password: 'hunter2' },
      command: 'curl -H "Authorization: Bearer abcdef123456" https://api.example.com',
      items: [{ token: 'abc123456' }, { file_path: '/tmp/a.ts' }],
    }) as any;
    expect(out.auth.password).toBe('[REDACTED:field:password]');
    expect(out.command).toContain('[REDACTED:auth_header]');
    expect(out.items[0].token).toBe('[REDACTED:field:token]');
    expect(out.items[1].file_path).toBe('/tmp/a.ts');
  });

  it('leaves non-sensitive keys and non-string values untouched', () => {
    const input = { file_path: '/tmp/a.ts', line: 42, ok: true };
    expect(redactSecretsDeep(input)).toEqual(input);
  });
});
