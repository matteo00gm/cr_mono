/**
 * Which IP addresses we are willing to connect to (P4-03a, §3.3).
 *
 * **This is the allowlist half of the SSRF defence, and it is deliberately a
 * denylist of ranges rather than a list of hosts** — the hosts are chosen by
 * sellers, and the thing that must never be reachable is our own inside: the
 * instance metadata endpoint, the VPC, the loopback, the database.
 *
 * **Every range here has cost somebody a breach.** `169.254.169.254` is the
 * metadata endpoint and the reason Capital One happened; `127.0.0.1` reaches
 * anything the process itself is listening on; RFC1918 is the VPC; CGNAT is
 * routable-looking and is not ours; and `::ffff:127.0.0.1` is the one a
 * reviewer's eye slides past, because it *looks* like an IPv6 address and is a
 * loopback in an IPv4 coat.
 *
 * **Parsed, never matched with a regular expression.** `010.0.0.1` is octal,
 * `0x7f.1` is hex, `2130706433` is an integer, and every one of them is
 * `127.0.0.1` to a resolver. This module never sees those forms — it is handed
 * what the resolver returned, which is canonical — and that is exactly why
 * validation belongs *after* resolution and *at* the socket rather than on a
 * string a seller typed.
 */

/**
 * An address without its zone identifier.
 *
 * `fe80::1%eth0` is a link-local address carrying the interface it is scoped
 * to, and the part that matters is in front of the `%`.
 */
const withoutZone = (address: string): string => address.replace(/%.*/u, '');

/** A parsed IPv4 address, as four octets. */
const ipv4Octets = (address: string): readonly number[] | undefined => {
  const parts = address.split('.');

  /* One to three digits and nothing else — no sign, no `0x`, no space — so the
   * only thing a parsed octet can still get wrong is its size. */
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return undefined;

  const octets = parts.map((part) => Number.parseInt(part, 10));

  return octets.every((octet) => octet <= 255) ? octets : undefined;
};

/**
 * Whether an IPv4 address is one a public host would answer on.
 *
 * Every rejected range is named because "private" is not one idea: some of
 * these are ours, some are nobody's, and one of them is AWS's.
 */
const isPublicIpv4 = (octets: readonly number[]): boolean => {
  const [a = 0, b = 0] = octets;

  /* 0.0.0.0/8 — "this network". On Linux, connecting to 0.0.0.0 reaches
   * localhost, which makes it a loopback with a different spelling. */
  if (a === 0) return false;

  /* 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — RFC1918, which is the VPC. */
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;

  /* 127.0.0.0/8 — loopback: anything this process is listening on. */
  if (a === 127) return false;

  /* 169.254.0.0/16 — link-local, and 169.254.169.254 is the instance metadata
   * endpoint. This is the single most valuable address to an attacker. */
  if (a === 169 && b === 254) return false;

  /* 100.64.0.0/10 — CGNAT. Routable-looking, and not ours. */
  if (a === 100 && b >= 64 && b <= 127) return false;

  /* 192.0.0.0/24 IETF protocol assignments, 192.0.2.0/24 TEST-NET-1,
   * 198.51.100.0/24 TEST-NET-2, 203.0.113.0/24 TEST-NET-3. */
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;

  /* 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast. */
  if (a >= 224) return false;

  return true;
};

/** Colon-separated groups, each one to four hex digits or `undefined` where it is not. */
const hexGroups = (text: string): (number | undefined)[] =>
  text === ''
    ? []
    : text
        .split(':')
        .map((group) => (/^[0-9a-f]{1,4}$/iu.test(group) ? Number.parseInt(group, 16) : undefined));

/** The groups either side of a `::`, with the zeros it stands for between them. */
const expand = (
  left: readonly (number | undefined)[],
  right: readonly (number | undefined)[],
): (number | undefined)[] => [
  ...left,
  ...Array.from({ length: 8 - left.length - right.length }, () => 0),
  ...right,
];

/**
 * Expands an IPv6 address to its eight groups, or nothing.
 *
 * **Each group is checked on its own, and that check is the whole parse.** A
 * stray character, a second `::`, a lone leading or trailing `:` and an
 * embedded dotted quad each leave behind a group that is not one to four hex
 * digits — so there is no screen in front of it for the two to disagree about.
 */
const ipv6Groups = (address: string): readonly number[] | undefined => {
  const bare = withoutZone(address);

  /* Split on the elision by index rather than `split`, which would hand back a
   * `string | undefined` head that can never actually be undefined. */
  const elision = bare.indexOf('::');
  const groups =
    elision === -1
      ? hexGroups(bare)
      : expand(hexGroups(bare.slice(0, elision)), hexGroups(bare.slice(elision + 2)));

  /* `every` narrows the array itself, so nothing here needs an assertion. */
  return groups.length === 8 && groups.every((group) => group !== undefined) ? groups : undefined;
};

/**
 * The IPv4 address inside an IPv4-mapped IPv6 one, or nothing.
 *
 * **The bypass this exists for is easy to miss.** `::ffff:127.0.0.1` is a
 * loopback, and an implementation that validates IPv6 and IPv4 separately
 * treats it as neither — it does not look like `127.0.0.1` and it is not in any
 * IPv6 range anybody thinks to reject.
 */
export const mappedIpv4 = (address: string): string | undefined => {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/iu.exec(withoutZone(address));

  if (dotted?.[1] !== undefined) return dotted[1];

  const groups = ipv6Groups(address);

  if (groups === undefined) return undefined;

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (g0 !== 0 || g1 !== 0 || g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0xffff) return undefined;

  return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
};

/** Whether an IPv6 address is one a public host would answer on. */
const isPublicIpv6 = (groups: readonly number[]): boolean => {
  const [first = 0] = groups;

  /*
   * ::/8 — reserved by the IETF, and nothing in it is a public host. It holds
   * `::` (unspecified), `::1` (loopback), the deprecated IPv4-compatible
   * `::a.b.c.d` — so `::7f00:1` is a loopback in yet another coat — and
   * 64:ff9b::/96, NAT64, which embeds an IPv4 address we would then not be
   * checking. The IPv4-mapped block lives here too, and is unwrapped and
   * checked as IPv4 before this is reached.
   */
  if ((first & 0xff00) === 0x0000) return false;

  /* fc00::/7 — unique local, the IPv6 RFC1918. */
  if ((first & 0xfe00) === 0xfc00) return false;

  /* fe80::/10 — link-local, which is where the IPv6 metadata endpoint lives. */
  if ((first & 0xffc0) === 0xfe80) return false;

  /* ff00::/8 — multicast. */
  if ((first & 0xff00) === 0xff00) return false;

  /* 2001:db8::/32 — documentation. Not routable, and a common test value. */
  if (first === 0x2001 && groups[1] === 0x0db8) return false;

  /* 2002::/16 — 6to4, which, like NAT64 above, embeds an IPv4 address we would
   * then not be checking. */
  if (first === 0x2002) return false;

  return true;
};

/**
 * Whether we may connect to this address.
 *
 * **Anything unparseable is refused.** A resolver returning something this
 * cannot read is a resolver doing something unexpected, and "unexpected" is not
 * a reason to connect.
 */
export const isPublicUnicast = (address: string): boolean => {
  const mapped = mappedIpv4(address);

  if (mapped !== undefined) {
    const octets = ipv4Octets(mapped);

    return octets !== undefined && isPublicIpv4(octets);
  }

  const octets = ipv4Octets(address);

  if (octets !== undefined) return isPublicIpv4(octets);

  const groups = ipv6Groups(address);

  return groups !== undefined && isPublicIpv6(groups);
};
