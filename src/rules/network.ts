import type { Rule } from '../types.js';
import { code, numberProp, serviceForPort, stringProp } from '../util.js';
import {
  DOCS,
  defineRule,
  endpoints,
  finding,
  fixes,
  fromFetch,
  hostPort,
  isAggregateChild,
  isLoopback,
  locate,
} from './helpers.js';

function hasCode(error: { code?: string; message: string }, ...codes: string[]): boolean {
  return codes.some((c) => error.code === c || new RegExp(`\\b${c}\\b`).test(error.message));
}

export const connectionRefused = defineRule({
  id: 'connection-refused',
  summary:
    'Nothing is listening on the host/port (with hints for databases, IPv6 localhost and Docker)',
  diagnose(error, ctx) {
    if (!hasCode(error, 'ECONNREFUSED') || isAggregateChild(error, ctx)) return undefined;
    const eps = endpoints(error);
    const port = eps.find((e) => e.port !== undefined)?.port;
    const addresses = [...new Set(eps.map((e) => e.address).filter((a): a is string => !!a))];
    const local = addresses.length === 0 || addresses.every(isLoopback);
    const host = local ? 'localhost' : (addresses[0] ?? 'the server');
    const target = port === undefined ? host : `${host}:${port}`;
    const service = serviceForPort(port);
    const onlyIpv6 = addresses.length === 1 && addresses[0] === '::1';
    const container = local && ctx.inContainer();
    const tried = addresses.map((a) => code(hostPort(a, port))).join(' and ');

    let explanation = `${fromFetch(ctx) ? 'fetch() could not connect: the' : 'The'} connection${
      tried ? ` to ${tried}` : ''
    } was refused, so no process is accepting connections there${container ? '' : ' (or a firewall rejected it)'}.`;
    if (onlyIpv6) {
      explanation += ` ${code('localhost')} resolved to the IPv6 address ${code('::1')} — if your server only listens on IPv4 (${code('127.0.0.1')}), IPv6 connections are refused.`;
    }
    if (container) {
      explanation += ` This process runs inside a container, where ${code('localhost')} is the container itself — not your machine and not other containers.`;
    }
    return finding({
      title: service
        ? `Can't reach ${service} on ${target} — is it running?`
        : `Nothing is accepting connections on ${target}`,
      explanation,
      fixes: fixes(
        container &&
          `Use the Docker Compose service name as the host (e.g. ${code('db')}), or ${code('host.docker.internal')} to reach your machine`,
        service
          ? `Start ${service} (e.g. ${code('docker compose up -d')} or your system's service manager), then retry`
          : `Start the server that should be listening${port === undefined ? '' : ` on port ${port}`}, then retry`,
        onlyIpv6 &&
          `Use ${code('127.0.0.1')} instead of ${code('localhost')}, or make the server listen on all interfaces (${code("'::'")} or ${code("'0.0.0.0'")})`,
        'Check the host and port in your URL or config — a missing or stale environment variable is a common culprit',
      ),
      location: locate(error, ctx),
      docs: DOCS.systemErrors,
    });
  },
});

export const dnsLookupFailed = defineRule({
  id: 'dns-lookup-failed',
  summary: 'A hostname could not be resolved (typos, Docker service names, URLs passed as hosts)',
  diagnose(error, ctx) {
    if (!hasCode(error, 'ENOTFOUND', 'EAI_AGAIN') || isAggregateChild(error, ctx)) return undefined;
    const temporary = hasCode(error, 'EAI_AGAIN');
    const host =
      stringProp(error.props.hostname) ??
      /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) (\S+)/.exec(error.message)?.[1] ??
      stringProp(error.props.host);
    const location = locate(error, ctx);
    const docs = DOCS.systemErrors;
    const via = fromFetch(ctx) ? 'fetch() failed because the' : 'The';
    if (!host) {
      return finding({
        title: 'A hostname could not be resolved (DNS)',
        explanation:
          'The DNS lookup for the server failed: a typo in the host, a missing environment variable, or no network access.',
        fixes: ['Check the URL/host in your config', 'Check your internet or VPN connection'],
        location,
        docs,
        confidence: 'medium',
      });
    }
    if (host === 'undefined' || host === 'null') {
      return finding({
        title: `The hostname is ${code(host)} — a config value is missing`,
        explanation: `${via} code tried to connect to a host literally named ${code(host)}: the variable holding the hostname (often an environment variable) wasn't set.`,
        fixes: [
          'Check the environment variable or config field that provides the host',
          `Make sure your .env file is loaded (e.g. ${code('node --env-file=.env')} on Node.js 20.6+)`,
        ],
        location,
        docs,
      });
    }
    if (/[:/]/.test(host)) {
      const bare = host.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0] || host;
      return finding({
        title: `${code(host)} isn't a hostname — it looks like a URL`,
        explanation: `The DNS lookup was given ${code(host)}, including a protocol, port or path. This option expects only the hostname.`,
        fixes: [
          `Pass just the host (${code(bare)}) and set the port separately`,
          'Or use the client option that accepts a full connection URL',
        ],
        location,
        docs,
      });
    }
    if (!host.includes('.') && host !== 'localhost') {
      const inside = ctx.inContainer();
      return finding({
        title: `Can't resolve ${code(host)} — is that a Docker service name?`,
        explanation: inside
          ? `Single-word hostnames like ${code(host)} are usually Docker Compose service names. This process is in a container, but it can't see a service called ${code(host)}.`
          : `Single-word hostnames like ${code(host)} are usually Docker Compose service names. They only resolve inside that Docker network, not from your machine.`,
        fixes: inside
          ? [
              'Check the service name in docker-compose.yml',
              'Make sure both containers are attached to the same Docker network',
            ]
          : [
              `From your machine, use ${code('localhost')} and the port published in docker-compose.yml`,
              `Or run this code inside the Compose network (${code('docker compose run …')})`,
            ],
        location,
        docs,
        confidence: 'medium',
      });
    }
    if (temporary) {
      return finding({
        title: `Temporary DNS failure looking up ${code(host)}`,
        explanation:
          "The DNS server didn't answer in time. You may be offline, on a flaky VPN or proxy, or the DNS server is having trouble.",
        fixes: [
          'Check your internet/VPN connection and retry',
          `Test resolution: ${code(`nslookup ${host}`)}`,
        ],
        location,
        docs,
      });
    }
    return finding({
      title: `The hostname ${code(host)} could not be found (DNS)`,
      explanation: `${via} DNS has no record for ${code(host)}. Usually that's a typo in the URL, a wrong environment variable, or a private hostname that only resolves on a VPN.`,
      fixes: [
        `Check the spelling of ${code(host)}`,
        `Test resolution: ${code(`nslookup ${host}`)}`,
        'If it is an internal hostname, connect to the network or VPN that can resolve it',
      ],
      location,
      docs,
    });
  },
});

export const networkTimeout = defineRule({
  id: 'network-timeout',
  summary: 'A connection or response timed out',
  diagnose(error, ctx) {
    const connect =
      hasCode(error, 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT') ||
      error.name === 'ConnectTimeoutError';
    const response =
      hasCode(error, 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ESOCKETTIMEDOUT') ||
      error.name === 'HeadersTimeoutError' ||
      error.name === 'BodyTimeoutError';
    if ((!connect && !response) || isAggregateChild(error, ctx)) return undefined;
    const ep = endpoints(error)[0];
    const target = ep?.address ? hostPort(ep.address, ep.port) : 'the server';
    if (connect) {
      return finding({
        title: `Timed out connecting to ${target}`,
        explanation:
          'The connection attempt got no answer at all — packets are being dropped rather than refused. Typical causes: the host is down or unreachable, a firewall or cloud security group blocks the port, the host needs a VPN, or an IPv6 route is broken.',
        fixes: [
          `Check reachability from this machine: ${code(`curl -v ${ep?.address ? `${ep.port === 443 ? 'https' : 'http'}://${target}` : '<url>'}`)}`,
          'Check firewall rules, security groups or database IP allowlists for your current IP',
          'Connect to the VPN if the host is internal',
        ],
        location: locate(error, ctx),
        docs: DOCS.systemErrors,
      });
    }
    const body = hasCode(error, 'UND_ERR_BODY_TIMEOUT') || error.name === 'BodyTimeoutError';
    return finding({
      title: `The server took too long to send the response ${body ? 'body' : 'headers'}`,
      explanation: `The connection worked, but ${target} didn't finish responding within the client's time limit.`,
      fixes: [
        'Check whether the server is overloaded or the request is unusually expensive',
        `For slow endpoints (LLM APIs, exports, reports), raise the limit — for Node.js fetch, pass an undici Agent:\nimport { Agent } from 'undici';\nawait fetch(url, { dispatcher: new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }) });`,
        'Prefer streaming responses for long-running work',
      ],
      location: locate(error, ctx),
      confidence: 'medium',
    });
  },
});

export const connectionReset = defineRule({
  id: 'connection-reset',
  summary: 'The other side closed the connection mid-request (ECONNRESET, socket hang up, EPIPE)',
  diagnose(error, ctx) {
    const reset =
      hasCode(error, 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET') ||
      /^socket hang up$|other side closed/i.test(error.message);
    if (!reset || isAggregateChild(error, ctx)) return undefined;
    const ep = endpoints(error)[0];
    const target = ep?.address ? code(hostPort(ep.address, ep.port)) : 'The server';
    return finding({
      title: `${ep?.address ? `${target} closed` : 'The other side closed'} the connection unexpectedly`,
      explanation:
        'The server, or a proxy/load balancer between you and it, dropped the connection in the middle of the request.',
      fixes: [
        "Check the server's logs — it may have crashed or restarted during the request",
        'Retry idempotent requests (GET, PUT) with backoff',
        `Behind a load balancer? Keep your server's keep-alive timeout longer than the balancer's idle timeout (Node.js: ${code('server.keepAliveTimeout')})`,
        'Speaking HTTPS to a plain-HTTP port (or the reverse) also causes resets — check the scheme and port',
      ],
      location: locate(error, ctx),
      docs: DOCS.systemErrors,
      confidence: 'medium',
    });
  },
});

const UNTRUSTED = [
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_UNTRUSTED',
];

export const tlsCertificate = defineRule({
  id: 'tls-certificate',
  summary:
    'TLS/HTTPS certificate problems: untrusted (corporate proxy), expired, wrong host, HTTP on an HTTPS port',
  diagnose(error, ctx) {
    const location = locate(error, ctx);
    if (
      UNTRUSTED.some((c) => hasCode(error, c)) ||
      /self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate/i.test(
        error.message,
      )
    ) {
      const selfSigned = hasCode(error, 'DEPTH_ZERO_SELF_SIGNED_CERT');
      return finding({
        title: "Node.js doesn't trust this server's TLS certificate",
        explanation: `The certificate chain ends at an authority Node.js doesn't know. That's typical of a corporate proxy or antivirus inspecting HTTPS traffic, or of a self-signed certificate. Node.js uses its own bundled list of certificate authorities, not your operating system's keychain.`,
        fixes: fixes(
          `Give Node.js the extra CA certificate: ${code('NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem')}`,
          ctx.nodeAtLeast(23, 8) &&
            `Or trust your operating system's certificate store: ${code('node --use-system-ca')}`,
          selfSigned &&
            `For local development certificates, a tool like ${code('mkcert')} creates certificates your machine trusts`,
          `Don't set ${code('NODE_TLS_REJECT_UNAUTHORIZED=0')} outside a quick local test — it turns off certificate checks entirely`,
        ),
        location,
        docs: DOCS.extraCaCerts,
      });
    }
    if (
      hasCode(error, 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID') ||
      /certificate has expired|certificate is not yet valid/i.test(error.message)
    ) {
      return finding({
        title: "The server's TLS certificate is expired (or not valid yet)",
        explanation: "Either the certificate really expired, or this computer's clock is wrong.",
        fixes: [
          `Inspect it: ${code('openssl s_client -connect <host>:443 -servername <host>')}`,
          'Check that your system clock and time zone are correct',
          'If you run the server, renew its certificate',
        ],
        location,
        docs: DOCS.systemErrors,
      });
    }
    if (
      hasCode(error, 'ERR_TLS_CERT_ALTNAME_INVALID') ||
      /does not match certificate's altnames/.test(error.message)
    ) {
      const detail = /altnames: (.+)$/m.exec(error.message)?.[1];
      return finding({
        title: 'The TLS certificate belongs to a different hostname',
        explanation: `The server presented a certificate for another name${detail ? ` (${detail.trim()})` : ''}.`,
        fixes: [
          'Connect using a hostname listed in the certificate',
          'If you run the server, issue a certificate that includes this hostname',
        ],
        location,
        docs: DOCS.error('ERR_TLS_CERT_ALTNAME_INVALID'),
      });
    }
    if (
      hasCode(error, 'ERR_SSL_WRONG_VERSION_NUMBER') ||
      /wrong version number|packet length too long/i.test(error.message)
    ) {
      return finding({
        title: 'TLS handshake failed — is this a plain HTTP port?',
        explanation:
          'The client spoke TLS (`https://`), but the server answered with something else — usually plain HTTP on that port.',
        fixes: [`Use ${code('http://')} for this port, or the server's HTTPS port (usually 443)`],
        location,
        confidence: 'medium',
      });
    }
    return undefined;
  },
});

export const addressInUse = defineRule({
  id: 'address-in-use',
  summary: 'The port is already taken by another process (with macOS AirPlay detection)',
  diagnose(error, ctx) {
    if (!hasCode(error, 'EADDRINUSE')) return undefined;
    const port = numberProp(error.props.port) ?? numberProp(/:(\d+)\s*$/.exec(error.message)?.[1]);
    const label = port === undefined ? 'The port' : `Port ${port}`;
    const airplay = ctx.platform === 'darwin' && (port === 5000 || port === 7000);
    const p = port ?? '<port>';
    return finding({
      title: `${label} is already in use`,
      explanation:
        `Another process is already listening on ${port === undefined ? 'that port' : `port ${port}`} — often an earlier run of this same server that's still alive, or another app.` +
        (airplay ? ` On macOS, ports 5000 and 7000 are taken by the AirPlay Receiver.` : ''),
      fixes: fixes(
        airplay &&
          'Turn off AirPlay Receiver (System Settings → General → AirDrop & Handoff), or use another port',
        ctx.platform === 'win32'
          ? `Find the process: ${code(`netstat -ano | findstr :${p}`)}, then stop it: ${code('taskkill /PID <pid> /F')}`
          : `Find the process: ${code(`lsof -i :${p}`)}, then stop it: ${code('kill <pid>')}`,
        port !== undefined && `Or use another port, e.g. ${code(`PORT=${port + 1}`)}`,
        `In tests and watch mode, close the previous server (${code('server.close()')}) and call ${code('listen()')} only once`,
      ),
      location: locate(error, ctx),
      docs: DOCS.systemErrors,
    });
  },
});

export const invalidUrl = defineRule({
  id: 'invalid-url',
  summary:
    'fetch()/new URL() got a relative URL, a missing protocol, or a URL containing "undefined"',
  diagnose(error, ctx) {
    const parse = /^Failed to parse URL from (.*)$/s.exec(error.message);
    const unknownScheme = error.message === 'unknown scheme';
    const badPort = error.message === 'bad port';
    const invalid = error.code === 'ERR_INVALID_URL' || /^Invalid URL/.test(error.message);
    if (!parse && !invalid && !unknownScheme && !badPort) return undefined;
    if (badPort) {
      return finding({
        title: 'fetch() refuses to connect to this port',
        explanation:
          'The Fetch standard blocks a list of "bad ports" that belong to other protocols (for example 6000, 6665–6669 and 10080), so browsers and Node.js refuse to fetch from them.',
        fixes: ['Run the server on a different port, such as 3000 or 8080'],
        location: locate(error, ctx),
      });
    }
    const input =
      stringProp(error.props.input) ??
      parse?.[1] ??
      /^Invalid URL: (.+)$/.exec(error.message)?.[1] ??
      (ctx.parent ? /^Failed to parse URL from (.*)$/s.exec(ctx.parent.message)?.[1] : undefined);
    const location = locate(error, ctx);
    const docs = DOCS.error('ERR_INVALID_URL');
    if (unknownScheme) {
      return finding({
        title: 'The URL is missing its protocol (http:// or https://)',
        explanation: `fetch() read the start of the URL (such as ${code('localhost:')}) as an unknown protocol.`,
        fixes: [`Add the protocol, e.g. ${code('http://localhost:3000/api')}`],
        location,
        docs,
      });
    }
    if (input === undefined) return undefined;
    if (/(?:^|\/)(?:undefined|null)(?:\/|$|:|\?)/.test(input)) {
      return finding({
        title: `The URL contains ${code(/undefined/.test(input) ? 'undefined' : 'null')}: ${code(input)}`,
        explanation:
          'Part of the URL came from a value that was never set — typically an environment variable such as `API_URL` or a missing config field.',
        fixes: [
          'Check that the variable is defined where this code runs (server vs. browser, CI, Docker)',
          `Make sure your .env file is loaded (${code('node --env-file=.env')} on Node.js 20.6+, or your framework's env loading)`,
          'Validate required environment variables at startup so this fails early',
        ],
        location,
        docs,
      });
    }
    if (input.startsWith('/')) {
      return finding({
        title: `fetch() on the server needs an absolute URL, not ${code(input)}`,
        explanation:
          'In a browser, relative URLs resolve against the current page. On the server there is no page, so a path like this has nothing to resolve against.',
        fixes: [
          `Build a full URL: ${code(`new URL('${input}', process.env.BASE_URL)`)}`,
          'Calling your own API route from server code (e.g. a Next.js Server Component)? Call the underlying function directly instead of making an HTTP request',
        ],
        location,
        docs,
      });
    }
    if (input.trim() === '') {
      return finding({
        title: 'The URL is an empty string',
        explanation:
          'The value used as the URL was empty — probably an unset variable or config field.',
        fixes: [
          'Check where the URL comes from (environment variables, config, function arguments)',
        ],
        location,
        docs,
      });
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      return finding({
        title: `The URL is missing its protocol: ${code(input)}`,
        explanation: 'URLs must start with a protocol such as `https://`.',
        fixes: [`Use ${code(`https://${input}`)} (or ${code('http://')} for local servers)`],
        location,
        docs,
      });
    }
    return finding({
      title: `Invalid URL: ${code(input)}`,
      explanation: "This string can't be parsed as a URL.",
      fixes: [
        'Check for spaces, a missing protocol, or unescaped characters (use `encodeURIComponent` for query values)',
      ],
      location,
      docs,
      confidence: 'medium',
    });
  },
});

export const bodyAlreadyRead = defineRule({
  id: 'body-already-read',
  summary: 'A fetch Response/Request body was read twice',
  diagnose(error, ctx) {
    if (
      !/Body is unusable|Body has already been (?:read|used|consumed)|body used already/i.test(
        error.message,
      )
    )
      return undefined;
    return finding({
      title: 'The response body was already read',
      explanation: `A fetch ${code('Response')} body is a stream, so it can be consumed only once. Calling ${code('.json()')}, ${code('.text()')} or ${code('.arrayBuffer()')} a second time fails.`,
      fixes: [
        `Read it once and reuse the result: ${code('const data = await res.json()')}`,
        `Need it twice (e.g. for logging)? Read a copy first: ${code('const copy = res.clone()')}`,
        `Look for a debugging line such as ${code('await res.text()')} just before ${code('res.json()')}`,
      ],
      location: locate(error, ctx),
    });
  },
});

export const requestAborted = defineRule({
  id: 'request-aborted',
  summary: 'An AbortSignal timeout fired or an AbortController cancelled the operation',
  diagnose(error, ctx) {
    const timeout = error.name === 'TimeoutError' || /aborted due to timeout/i.test(error.message);
    const aborted =
      error.name === 'AbortError' ||
      /^This operation was aborted$|^The operation was aborted\.?$/.test(error.message);
    if (!timeout && !aborted) return undefined;
    if (timeout) {
      return finding({
        title: 'An AbortSignal timeout cancelled the operation',
        explanation: `${code('AbortSignal.timeout(ms)')} (or a client timeout built on it) fired before the operation finished.`,
        fixes: [
          'Raise the timeout if the operation is legitimately slow',
          'Otherwise, find out why the server or operation is slow',
          `Handle it explicitly: ${code("if (err.name === 'TimeoutError') { … }")}`,
        ],
        location: locate(error, ctx),
        confidence: 'medium',
      });
    }
    return finding({
      title: 'The operation was cancelled by an AbortController',
      explanation: `Something called ${code('controller.abort()')}: your own cancellation logic, a component or effect cleanup, or a framework cancelling work because the client disconnected.`,
      fixes: [
        `If cancellation is expected, ignore it: ${code("if (err.name === 'AbortError') return;")}`,
        `If it isn't, find where ${code('abort()')} is called on the controller whose signal you passed`,
      ],
      location: locate(error, ctx),
      confidence: 'medium',
    });
  },
});

export const networkRules: Rule[] = [
  connectionRefused,
  dnsLookupFailed,
  networkTimeout,
  connectionReset,
  tlsCertificate,
  addressInUse,
  invalidUrl,
  bodyAlreadyRead,
  requestAborted,
];
