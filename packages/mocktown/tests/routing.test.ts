/**
 * The front door's mode table, and the two ways traffic used to leave through it quietly.
 *
 * A silent escape is the worst failure this product has (02-architecture.md), so the cases
 * here are the ones where the registry and reality disagree: a host the recorder pinned to
 * `record` that a provider is now serving, and a `NO_PROXY` entry that excludes a service
 * the caller believes is being captured.
 */
import { describe, expect, test } from 'bun:test';
import { bypassedByNoProxy } from '#src/capture/launch.ts';
import { escapingHosts, routeForProvider } from '#src/frontdoor/routing.ts';

const served = new Map([['billing.example.com', 'http://127.0.0.1:5000']]);

describe('the mode table', () => {
  test('a committed provider that is up is mocked, and one that is down is denied', () => {
    const up = routeForProvider('billing.example.com', 'generated:billing.example.com', served);
    expect(up.mode).toBe('mock');
    expect(up.target).toBe('127.0.0.1:5000');
    expect(up.targetProtocol).toBe('http');

    // Never the real upstream: denying is loud and files an issue.
    const down = routeForProvider('api.stripe.com', 'generated:api.stripe.com', served);
    expect(down.mode).toBe('deny');
    expect(down.provider).toBe('generated:api.stripe.com');
  });

  test('the registry literals keep their meanings outside serve mode', () => {
    expect(routeForProvider('h', 'record', served).mode).toBe('record');
    expect(routeForProvider('h', 'passthrough', served).mode).toBe('passthrough');
    expect(routeForProvider('h', 'deny', served).mode).toBe('deny');
  });
});

describe('a discovered `record` pin does not survive into serve mode', () => {
  // The recorder pins every host it observes, so every recorded service arrives in serve
  // mode carrying `record` — which forwards to the real upstream. That is the escape.
  test('a provider that is serving the host outranks the pin', () => {
    const route = routeForProvider('billing.example.com', 'record', served, {
      serving: true,
      discovered: true,
      servedBy: 'generated',
    });
    expect(route.mode).toBe('mock');
    expect(route.target).toBe('127.0.0.1:5000');
    expect(route.provider).toBe('generated');
  });

  test('with no provider up, a sealed run denies rather than escaping', () => {
    const sealed = routeForProvider('api.stripe.com', 'record', served, { serving: true, discovered: true, sealed: true });
    expect(sealed.mode).toBe('deny');

    // Unsealed serve is the mixed mode: recording the un-mocked half is the point.
    const unsealed = routeForProvider('api.stripe.com', 'record', served, { serving: true, discovered: true, sealed: false });
    expect(unsealed.mode).toBe('record');
  });

  test('a pin committed to mocktown.json is a decision, so it stands', () => {
    // `discovered: false` means someone wrote it down. Overriding that would be the
    // mirror-image bug: the tool quietly ignoring the file.
    const route = routeForProvider('billing.example.com', 'record', served, {
      serving: true,
      discovered: false,
      sealed: true,
      servedBy: 'generated',
    });
    expect(route.mode).toBe('record');
  });

  test('recording mode is untouched — a pin is exactly what it means there', () => {
    const route = routeForProvider('billing.example.com', 'record', served, { serving: false, discovered: true });
    expect(route.mode).toBe('record');
  });
});

describe('whatever still reaches a real upstream is named', () => {
  test('record and passthrough are reported, mock and deny are not', () => {
    const hosts = escapingHosts({
      fallthrough: 'deny',
      routes: [
        { host: 'a.example.com', mode: 'record' },
        { host: 'b.example.com', mode: 'passthrough' },
        { host: 'c.example.com', mode: 'mock', target: '127.0.0.1:1' },
        { host: 'd.example.com', mode: 'deny' },
      ],
    });
    expect(hosts).toEqual(['a.example.com', 'b.example.com']);
  });
});

describe('NO_PROXY suffix matching', () => {
  test('the `localhost` entry excludes every `*.localhost` name', () => {
    // Why a `.localhost` upstream records nothing: proxy clients match NO_PROXY by domain
    // suffix, so the entry that keeps loopback unproxied takes the subdomains with it.
    expect(bypassedByNoProxy('billing.localhost')).toBe(true);
    expect(bypassedByNoProxy('api.stripe.localhost')).toBe(true);
    expect(bypassedByNoProxy('localhost')).toBe(true);
    expect(bypassedByNoProxy('127.0.0.1')).toBe(true);
  });

  test('a real hostname is not excluded, and a partial suffix is not a match', () => {
    expect(bypassedByNoProxy('api.stripe.com')).toBe(false);
    // `notlocalhost` ends with the entry's letters but is not a subdomain of it.
    expect(bypassedByNoProxy('notlocalhost')).toBe(false);
  });

  test('the port is not part of the comparison', () => {
    expect(bypassedByNoProxy('billing.localhost:5599')).toBe(true);
    expect(bypassedByNoProxy('api.stripe.com:443')).toBe(false);
  });

  test('a leading dot in an entry means the same thing', () => {
    expect(bypassedByNoProxy('billing.test', ['.test'])).toBe(true);
    expect(bypassedByNoProxy('billing.test', ['test'])).toBe(true);
  });
});
