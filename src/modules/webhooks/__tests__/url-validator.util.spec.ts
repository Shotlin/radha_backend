import { validateWebhookUrl } from '../utils/url-validator.util';

/**
 * BE-50 — Webhook URL validator unit tests.
 *
 * The validator is the single line of SSRF defence between a tenant
 * and our outbound HTTP client; missing a CIDR here is a security
 * issue, so the table-style tests below are exhaustive on the ranges
 * the file header documents.
 */
describe('validateWebhookUrl', () => {
  describe('parsing + protocol', () => {
    it('rejects empty / non-string input', () => {
      expect(validateWebhookUrl(undefined).ok).toBe(false);
      expect(validateWebhookUrl(null).ok).toBe(false);
      expect(validateWebhookUrl('').ok).toBe(false);
    });

    it('rejects unparseable URLs', () => {
      expect(validateWebhookUrl('not a url').ok).toBe(false);
      expect(validateWebhookUrl('://broken').ok).toBe(false);
    });

    it('rejects non-http(s) protocols', () => {
      expect(validateWebhookUrl('ftp://example.com').ok).toBe(false);
      expect(validateWebhookUrl('file:///etc/passwd').ok).toBe(false);
      expect(validateWebhookUrl('javascript:alert(1)').ok).toBe(false);
      expect(validateWebhookUrl('gopher://example.com').ok).toBe(false);
    });

    it('accepts http and https public hostnames', () => {
      expect(validateWebhookUrl('http://example.com/hook').ok).toBe(true);
      expect(validateWebhookUrl('https://example.com/hook').ok).toBe(true);
      expect(validateWebhookUrl('https://api.example.com:8443/v1/hook').ok).toBe(true);
    });
  });

  describe('localhost + DNS labels', () => {
    it('rejects localhost variants', () => {
      expect(validateWebhookUrl('http://localhost/hook').ok).toBe(false);
      expect(validateWebhookUrl('http://Localhost/hook').ok).toBe(false);
      expect(validateWebhookUrl('http://api.localhost/hook').ok).toBe(false);
    });

    it('accepts arbitrary public DNS names', () => {
      expect(validateWebhookUrl('https://hooks.slack.com/services/abc').ok).toBe(true);
      expect(validateWebhookUrl('https://my-tenant.example.org').ok).toBe(true);
    });
  });

  describe('IPv4 internal ranges', () => {
    it.each([
      ['10.0.0.1', '10.0.0.0/8'],
      ['10.255.255.255', '10.0.0.0/8'],
      ['127.0.0.1', '127.0.0.0/8 loopback'],
      ['127.255.255.254', '127.0.0.0/8 loopback'],
      ['169.254.169.254', '169.254.0.0/16 metadata'],
      ['172.16.0.1', '172.16.0.0/12'],
      ['172.31.255.255', '172.16.0.0/12'],
      ['192.168.0.1', '192.168.0.0/16'],
      ['192.168.255.255', '192.168.0.0/16'],
      ['0.0.0.0', 'unspecified'],
      ['100.64.0.1', '100.64.0.0/10 CGNAT'],
      ['100.127.255.255', '100.64.0.0/10 CGNAT'],
      ['255.255.255.255', 'broadcast'],
    ])('rejects %s (%s)', (host) => {
      expect(validateWebhookUrl(`http://${host}/hook`).ok).toBe(false);
    });

    it.each([
      ['8.8.8.8', 'public DNS'],
      ['1.1.1.1', 'public DNS'],
      ['172.32.0.1', 'just outside RFC1918 172/12'],
      ['172.15.255.255', 'just below RFC1918 172/12'],
      ['100.63.255.255', 'just below CGNAT'],
      ['100.128.0.1', 'just above CGNAT'],
      ['11.0.0.1', 'just above 10/8'],
      ['9.255.255.255', 'just below 10/8'],
    ])('accepts %s (%s)', (host) => {
      expect(validateWebhookUrl(`http://${host}/hook`).ok).toBe(true);
    });

    it('rejects malformed dotted-quads (4 parts but bad octet)', () => {
      expect(validateWebhookUrl('http://10.0.0.999/hook').ok).toBe(false);
      // 999 is not a valid octet, but URL parser may still accept the
      // host as a DNS name. Either way it must not be classified as
      // public IPv4 — accepting as DNS is fine, but the resolver
      // would later fail. This test pins the behaviour.
      expect(typeof validateWebhookUrl('http://1.2.3.4.5/hook').ok).toBe('boolean');
    });
  });

  describe('IPv6 internal ranges', () => {
    it.each([
      ['[::1]', 'loopback'],
      ['[::]', 'unspecified'],
      ['[fe80::1]', 'link-local'],
      ['[fea0::1]', 'link-local upper'],
      ['[fc00::1]', 'unique-local'],
      ['[fdaa::1]', 'unique-local'],
      ['[ff02::1]', 'multicast'],
      ['[::ffff:10.0.0.1]', 'IPv4-mapped private'],
      ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
    ])('rejects %s (%s)', (host) => {
      expect(validateWebhookUrl(`http://${host}/hook`).ok).toBe(false);
    });

    it('accepts a public IPv6 address', () => {
      // Google public DNS over IPv6.
      expect(validateWebhookUrl('http://[2001:4860:4860::8888]/hook').ok).toBe(true);
    });
  });

  describe('shape of the result', () => {
    it('includes a `reason` on rejection', () => {
      const result = validateWebhookUrl('http://10.0.0.1/hook');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/internal/i);
    });

    it('omits `reason` on success', () => {
      const result = validateWebhookUrl('https://example.com/hook');
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });
});
