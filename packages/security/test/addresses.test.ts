import { describe, expect, it } from 'vitest';

import { isPublicUnicast, mappedIpv4 } from '../src/net/addresses.js';

/**
 * Which addresses we will connect to (P4-03a, §3.3).
 *
 * **Every rejected range here has cost somebody a breach**, and the table is
 * the test: a range this file does not name is a range nothing stops us
 * reaching, and the failure mode is a server-side request to our own inside
 * that looks in every log like a normal outbound fetch.
 *
 * **The interesting half is what an implementation gets wrong**, not what it
 * gets right. `::ffff:127.0.0.1` is a loopback that fails both an IPv4 check
 * and a naive IPv6 one. `0.0.0.0` reaches localhost on Linux. `100.64.0.0/10`
 * is routable-looking and is not ours. Each has its own case below, named.
 */

describe('addresses a public host answers on', () => {
  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '203.1.113.5',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.0.1',
    '192.169.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.0.1',
    '169.255.0.1',
    '11.0.0.1',
    '126.255.255.255',
    '128.0.0.1',
    '223.255.255.255',
  ])('accepts %s', (address) => {
    expect(isPublicUnicast(address)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:41f::200e',
    '2001:db9::1',
    'fbff:ffff::1',
    'fe7f::1',
    'fec0::1',
  ])('accepts %s', (address) => {
    expect(isPublicUnicast(address)).toBe(true);
  });
});

describe('the ranges that are ours, or belong to nobody', () => {
  it.each([
    ['0.0.0.0', 'this network, which reaches localhost on Linux'],
    ['0.255.255.255', 'the rest of 0.0.0.0/8'],
    ['10.0.0.1', 'RFC1918, which is the VPC'],
    ['10.255.255.254', 'the rest of 10.0.0.0/8'],
    ['172.16.0.1', 'RFC1918'],
    ['172.31.255.254', 'the top of 172.16.0.0/12'],
    ['192.168.1.1', 'RFC1918'],
    ['127.0.0.1', 'loopback: anything this process listens on'],
    ['127.255.255.255', 'the rest of 127.0.0.0/8'],
    ['169.254.169.254', 'the instance metadata endpoint'],
    ['169.254.0.1', 'the rest of link-local'],
    ['100.64.0.1', 'CGNAT: routable-looking, and not ours'],
    ['100.127.255.255', 'the top of CGNAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicUnicast(address)).toBe(false);
  });

  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['0:0:0:0:0:0:0:1', 'loopback, written out'],
    ['fc00::1', 'unique local, the IPv6 RFC1918'],
    ['fd12:3456::1', 'the rest of fc00::/7'],
    ['fe80::1', 'link-local, where the IPv6 metadata endpoint lives'],
    ['febf::1', 'the top of fe80::/10'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['64:ff9b::1.1.1.1', 'NAT64, which embeds an address we would not check'],
    ['2002::1', '6to4, likewise'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicUnicast(address)).toBe(false);
  });
});

describe('the IPv4-mapped bypass', () => {
  /*
   * **The one a reviewer's eye slides past.** It looks like an IPv6 address, it
   * is a loopback, and an implementation that validates the two families
   * separately treats it as neither.
   */
  it.each([
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:0.0.0.0',
  ])('refuses %s', (address) => {
    expect(isPublicUnicast(address)).toBe(false);
  });

  it('refuses the hexadecimal spelling of the same thing', () => {
    /* `::ffff:7f00:1` is `::ffff:127.0.0.1` written in groups, and a check that
     * only matched the dotted form would let it through. */
    expect(isPublicUnicast('::ffff:7f00:1')).toBe(false);
    expect(isPublicUnicast('0:0:0:0:0:ffff:a9fe:a9fe')).toBe(false);
  });

  it('still accepts a mapped public address', () => {
    expect(isPublicUnicast('::ffff:1.1.1.1')).toBe(true);
  });

  it('reads the address out of the mapping', () => {
    expect(mappedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(mappedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
  });

  it('is not a mapping when the prefix is not the mapping prefix', () => {
    expect(mappedIpv4('2606:4700::1')).toBeUndefined();
    expect(mappedIpv4('::fffe:7f00:1')).toBeUndefined();
  });

  it('is not a mapping when it is not an address at all', () => {
    expect(mappedIpv4('nonsense')).toBeUndefined();
  });
});

describe('what it does with input it cannot read', () => {
  /*
   * **Refused, always.** A resolver returning something this cannot parse is a
   * resolver doing something unexpected, and "unexpected" is not a reason to
   * open a socket.
   */
  it.each([
    '',
    'localhost',
    'example.com',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.256.1.1',
    '1.1.1.256',
    '1.1.1.-1',
    'ff:ff:ff:ff:ff:ff',
    '::1::1',
    'gggg::1',
    '1.1.1.1 ',
    ' 1.1.1.1',
    '01.1.1.1x',
  ])('refuses %s', (address) => {
    expect(isPublicUnicast(address)).toBe(false);
  });

  it('refuses an address with too few groups to be IPv6', () => {
    expect(isPublicUnicast('2606:4700:4700')).toBe(false);
  });

  it('refuses an address with too many groups', () => {
    expect(isPublicUnicast('1:2:3:4:5:6:7:8:9')).toBe(false);
  });
});

describe('the spellings a resolver never produces, and a string might', () => {
  /*
   * **This module is handed what the resolver returned, which is canonical.**
   * `010.0.0.1` is octal and `2130706433` is an integer, and both are
   * `127.0.0.1` to a resolver — which is exactly why validation belongs *after*
   * resolution rather than on a hostname a seller typed. Refused here anyway,
   * because a parser that accepted them would be one layer of defence thinner.
   */
  it.each(['010.0.0.1', '2130706433', '0x7f.0.0.1', '127.1', '127.0.1'])(
    'refuses %s',
    (address) => {
      expect(isPublicUnicast(address)).toBe(false);
    },
  );
});

describe('the zone identifier a link-local address carries', () => {
  it('is ignored, and the address underneath is still refused', () => {
    expect(isPublicUnicast('fe80::1%eth0')).toBe(false);
    expect(isPublicUnicast('::ffff:127.0.0.1%lo')).toBe(false);
    expect(mappedIpv4('::ffff:127.0.0.1%lo')).toBe('127.0.0.1');
  });

  it('is ignored on an address that is fine, rather than making it unreadable', () => {
    /*
     * **Refusing this too would look like the same answer and be the wrong
     * one.** A zone is scope, not identity — an implementation that simply
     * failed to parse the `%` would reject every address carrying one, and
     * would be indistinguishable from this until the day one is public.
     */
    expect(isPublicUnicast('2606:4700::1%eth0')).toBe(true);
  });
});
