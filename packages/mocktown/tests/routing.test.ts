/**
 * The front door's mode table, and the two ways traffic used to leave through it quietly.
 *
 * A silent escape is the worst failure this product has (02-architecture.md), so the cases
 * here are the ones where the registry and reality disagree: a host the recorder pinned to
 * `record` that a provider is now serving, and a `NO_PROXY` entry that excludes a service
 * the caller believes is being captured.
 */
import { describe, expect, test } from 'bun:test';
import { bypassedByNoProxy, isLoopbackName, planNoProxy } from '#src/capture/launch.ts';
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
  test('suffix matching is the rule, and it is why a blanket entry is dangerous', () => {
    // Proxy clients match NO_PROXY by domain suffix, so `localhost` takes every
    // `*.localhost` name with it. That is the behaviour `planNoProxy` exists to work around.
    expect(bypassedByNoProxy('billing.localhost', ['localhost'])).toBe(true);
    expect(bypassedByNoProxy('api.stripe.localhost', ['localhost'])).toBe(true);
    expect(bypassedByNoProxy('localhost', ['localhost'])).toBe(true);
  });

  test('loopback literals are excluded unconditionally, and never shadow a hostname', () => {
    // Nobody records a service by bare IP, so these entries cost nothing and can stay.
    expect(bypassedByNoProxy('127.0.0.1')).toBe(true);
    expect(bypassedByNoProxy('billing.localhost')).toBe(false);
  });

  test('a real hostname is not excluded, and a partial suffix is not a match', () => {
    expect(bypassedByNoProxy('api.stripe.com', ['localhost'])).toBe(false);
    // `notlocalhost` ends with the entry's letters but is not a subdomain of it.
    expect(bypassedByNoProxy('notlocalhost', ['localhost'])).toBe(false);
  });

  test('the port is not part of the comparison', () => {
    // Not a simplification: curl ignores a port in a NO_PROXY entry and proxies the host
    // anyway, so a port-scoped bypass is not something the list can express portably.
    expect(bypassedByNoProxy('billing.localhost:5599', ['localhost'])).toBe(true);
    expect(bypassedByNoProxy('api.stripe.com:443', ['localhost'])).toBe(false);
  });

  test('a leading dot in an entry means the same thing', () => {
    expect(bypassedByNoProxy('billing.test', ['.test'])).toBe(true);
    expect(bypassedByNoProxy('billing.test', ['test'])).toBe(true);
  });
});

describe('planning the bypass list', () => {
  test('with no `.localhost` service, the blanket entry stays', () => {
    const plan = planNoProxy({ services: ['api.stripe.com'] });
    expect(plan.entries).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(plan.droppedLocalhost).toBe(false);
    expect(plan.bypassed).toEqual([]);
  });

  test('a registered `.localhost` service drops it, so the service can be recorded', () => {
    const plan = planNoProxy({ services: ['billing.localhost'] });
    expect(plan.entries).toEqual(['127.0.0.1', '::1']);
    expect(plan.droppedLocalhost).toBe(true);
    expect(plan.bypassed).toEqual([]);
  });

  test("the project's own hosts are holes it asked for", () => {
    const plan = planNoProxy({ services: ['billing.localhost'], declared: ['localhost', 'db.internal'] });
    expect(plan.entries).toEqual(['127.0.0.1', '::1', 'localhost', 'db.internal']);
    // Declared bypass beats capture: the caller said this host is theirs, so say what it costs.
    expect(plan.bypassed).toEqual(['billing.localhost']);
    // Nothing was lost here — the project asked for the entry back, so warning that it is
    // gone would be false.
    expect(plan.droppedLocalhost).toBe(false);
  });

  test('a portless TLD that shadows a service is reported, not silently resolved', () => {
    // Under portless the app must reach its own mocks directly, so `.localhost` has to
    // bypass — which makes a `.localhost` upstream unrecordable in that mode. Inherent,
    // so the plan names it rather than pretending the collision does not exist.
    const plan = planNoProxy({ services: ['billing.localhost'], required: ['.localhost'] });
    expect(plan.entries).toEqual(['127.0.0.1', '::1', '.localhost']);
    expect(plan.bypassed).toEqual(['billing.localhost']);
  });

  test('entries are not repeated when the project declares one the plan already has', () => {
    expect(planNoProxy({ declared: ['localhost', '127.0.0.1'] }).entries).toEqual(['127.0.0.1', '::1', 'localhost']);
  });
});

describe('recognising the app talking to itself', () => {
  test('RFC 6761 names and loopback literals need no DNS', () => {
    expect(isLoopbackName('localhost')).toBe(true);
    expect(isLoopbackName('billing.localhost:5599')).toBe(true);
    expect(isLoopbackName('127.0.0.1')).toBe(true);
    expect(isLoopbackName('127.5.0.1')).toBe(true);
    expect(isLoopbackName('[::1]')).toBe(true);
  });

  test('a third-party host is not mistaken for one', () => {
    expect(isLoopbackName('api.stripe.com')).toBe(false);
    expect(isLoopbackName('notlocalhost')).toBe(false);
    // The population this covers is exactly the one the dropped blanket entry stops
    // bypassing, so a name that was never bypassed anyway is out of scope.
    expect(isLoopbackName('db.internal')).toBe(false);
  });
});
