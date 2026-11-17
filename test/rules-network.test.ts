import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/index.js';
import { crash, info } from './helpers.js';

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function refused(address: string, port: number) {
  return Object.assign(new Error(`connect ECONNREFUSED ${address}:${port}`), {
    code: 'ECONNREFUSED',
    errno: -61,
    syscall: 'connect',
    address,
    port,
  });
}

describe('connection-refused', () => {
  it('diagnoses a real fetch() to a closed port', async () => {
    const port = await closedPort();
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'client.js': `await fetch('http://127.0.0.1:${port}/api');\n`,
      },
      'client.js',
    );
    expect(diagnosis?.id).toBe('connection-refused');
    expect(diagnosis?.title).toBe(`Nothing is accepting connections on localhost:${port}`);
    expect(diagnosis?.explanation).toMatch(/^fetch\(\) could not connect/);
    // Node.js 26+ throws fetch errors without a stack trace, so a location isn't always available.
    if (diagnosis?.location) expect(diagnosis.location.line).toBe(1);
  });

  it('diagnoses a live AggregateError from a real connection attempt', async () => {
    const port = await closedPort();
    const error = await new Promise<Error>((resolve) => {
      const socket = net.connect(port, 'localhost');
      socket.on('error', resolve);
    });
    expect(explain(error)?.title).toBe(`Nothing is accepting connections on localhost:${port}`);
  });

  it('names well-known services', () => {
    expect(explain(refused('127.0.0.1', 5432))?.title).toBe(
      "Can't reach PostgreSQL on localhost:5432 — is it running?",
    );
    expect(explain(refused('10.0.0.5', 6379))?.title).toBe(
      "Can't reach Redis on 10.0.0.5:6379 — is it running?",
    );
  });

  it('explains IPv6 localhost', () => {
    const d = explain(refused('::1', 3000));
    expect(d?.explanation).toContain('resolved to the IPv6 address `::1`');
    expect(d?.fixes.join('\n')).toContain('Use `127.0.0.1` instead of `localhost`');
  });

  it('explains localhost inside containers', () => {
    const d = explain(refused('127.0.0.1', 5432), { inContainer: true });
    expect(d?.explanation).toContain('runs inside a container');
    expect(d?.fixes[0]).toContain('host.docker.internal');
  });

  it('works from a bare error message', () => {
    expect(explain('Error: connect ECONNREFUSED 127.0.0.1:27017')?.title).toBe(
      "Can't reach MongoDB on localhost:27017 — is it running?",
    );
  });
});

describe('dns-lookup-failed', () => {
  const dns = (hostname: string, code = 'ENOTFOUND') =>
    Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), {
      code,
      syscall: 'getaddrinfo',
      hostname,
    });

  it('suggests Docker service names for single-word hosts', () => {
    expect(explain(dns('db'), { inContainer: false })?.title).toBe(
      "Can't resolve `db` — is that a Docker service name?",
    );
    expect(explain(dns('db'), { inContainer: true })?.fixes[1]).toContain('same Docker network');
  });

  it('spots undefined hosts and URLs passed as hosts', () => {
    expect(explain(dns('undefined'))?.title).toBe(
      'The hostname is `undefined` — a config value is missing',
    );
    const url = explain(dns('localhost:5432'));
    expect(url?.title).toBe("`localhost:5432` isn't a hostname — it looks like a URL");
    expect(url?.fixes[0]).toContain('`localhost`');
  });

  it('handles regular and temporary failures', () => {
    expect(explain(dns('api.exmaple.com'))?.title).toBe(
      'The hostname `api.exmaple.com` could not be found (DNS)',
    );
    expect(explain(dns('api.example.com', 'EAI_AGAIN'))?.title).toBe(
      'Temporary DNS failure looking up `api.example.com`',
    );
  });

  it('mentions fetch when the error came through fetch()', () => {
    const d = explain(new TypeError('fetch failed', { cause: dns('api.exmaple.com') }));
    expect(d?.explanation).toMatch(/^fetch\(\) failed/);
  });
});

describe('network-timeout / connection-reset', () => {
  it('explains connect timeouts', () => {
    const err = Object.assign(
      new Error('Connect Timeout Error (attempted address: api.openai.com:443, timeout: 10000ms)'),
      {
        code: 'UND_ERR_CONNECT_TIMEOUT',
        name: 'ConnectTimeoutError',
      },
    );
    const d = explain(new TypeError('fetch failed', { cause: err }));
    expect(d?.title).toBe('Timed out connecting to api.openai.com:443');
    expect(d?.fixes[0]).toContain('curl -v https://api.openai.com:443');
  });

  it('explains response timeouts with the undici Agent fix', () => {
    const d = explain(
      Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    );
    expect(d?.title).toBe('The server took too long to send the response headers');
    expect(d?.fixes[1]).toContain('headersTimeout');
  });

  it('explains resets and socket hang ups', () => {
    expect(explain(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))?.id).toBe(
      'connection-reset',
    );
    expect(explain(new Error('socket hang up'))?.id).toBe('connection-reset');
  });
});

describe('tls-certificate', () => {
  const tls = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('explains untrusted chains and only offers --use-system-ca where it exists', () => {
    const err = tls('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain');
    const modern = explain(err, { nodeVersion: 'v24.0.0' });
    expect(modern?.title).toBe("Node.js doesn't trust this server's TLS certificate");
    expect(modern?.fixes.join('\n')).toContain('--use-system-ca');
    expect(explain(err, { nodeVersion: 'v22.11.0' })?.fixes.join('\n')).not.toContain(
      '--use-system-ca',
    );
  });

  it('explains expired certificates, wrong hosts and HTTP ports', () => {
    expect(explain(tls('CERT_HAS_EXPIRED', 'certificate has expired'))?.title).toContain('expired');
    expect(
      explain(
        tls(
          'ERR_TLS_CERT_ALTNAME_INVALID',
          "Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames: DNS:example.com",
        ),
      )?.explanation,
    ).toContain('DNS:example.com');
    expect(explain(tls('ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number'))?.title).toContain(
      'plain HTTP port',
    );
  });
});

describe('address-in-use', () => {
  it('diagnoses a real EADDRINUSE', () => {
    const { diagnosis } = crash(
      {
        'server.cjs':
          "const http = require('http');\nconst a = http.createServer().listen(0, () => {\n  http.createServer().listen(a.address().port);\n});\n",
      },
      'server.cjs',
    );
    expect(diagnosis?.title).toMatch(/^Port \d+ is already in use$/);
  });

  it('gives platform-specific commands and the macOS AirPlay hint', () => {
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use :::5000'), {
      code: 'EADDRINUSE',
      syscall: 'listen',
      port: 5000,
    });
    expect(explain(err, { platform: 'darwin' })?.explanation).toContain('AirPlay Receiver');
    expect(explain(err, { platform: 'linux' })?.explanation).not.toContain('AirPlay');
    expect(explain(err, { platform: 'win32' })?.fixes.join('\n')).toContain(
      'netstat -ano | findstr :5000',
    );
    expect(explain(err, { platform: 'linux' })?.fixes.join('\n')).toContain('lsof -i :5000');
  });
});

describe('invalid-url', () => {
  it('explains relative URLs in server-side fetch()', () => {
    const { diagnosis } = crash(
      { 'package.json': '{"type":"module"}', 'a.js': "await fetch('/api/users');\n" },
      'a.js',
    );
    expect(diagnosis?.title).toBe('fetch() on the server needs an absolute URL, not `/api/users`');
  });

  it('explains URLs built from undefined values', () => {
    const { diagnosis } = crash(
      {
        'package.json': '{"type":"module"}',
        'a.js': 'await fetch(`${process.env.WHYCRASH_TEST_NOPE}/users`);\n',
      },
      'a.js',
    );
    expect(diagnosis?.title).toBe('The URL contains `undefined`: `undefined/users`');
  });

  it('explains missing protocols', () => {
    const { diagnosis } = crash(
      { 'package.json': '{"type":"module"}', 'a.js': "await fetch('localhost:3000/api');\n" },
      'a.js',
    );
    expect(diagnosis?.title).toBe('The URL is missing its protocol (http:// or https://)');
    const d = explain(
      Object.assign(new TypeError('Invalid URL'), {
        code: 'ERR_INVALID_URL',
        input: 'api.example.com/users',
      }),
    );
    expect(d?.fixes[0]).toContain('https://api.example.com/users');
  });
});

describe('invalid-url: blocked ports', () => {
  it('explains fetch() "bad port" errors', () => {
    const d = explain(new TypeError('fetch failed', { cause: new Error('bad port') }));
    expect(d?.title).toBe('fetch() refuses to connect to this port');
  });
});

describe('body-already-read / request-aborted', () => {
  it('explains reading a body twice', async () => {
    const res = new Response('{}');
    await res.text();
    const error = await res.json().catch((e: unknown) => e);
    expect(explain(error)?.title).toBe('The response body was already read');
  });

  it('explains AbortSignal timeouts and aborts', () => {
    expect(
      explain(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))?.title,
    ).toBe('An AbortSignal timeout cancelled the operation');
    expect(explain(new DOMException('This operation was aborted', 'AbortError'))?.title).toBe(
      'The operation was cancelled by an AbortController',
    );
  });

  it('ignores unrelated errors', () => {
    expect(explain(info({ message: 'all good' }))).toBeUndefined();
  });
});
