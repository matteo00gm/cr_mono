/**
 * What `tenant-export.mjs` writes and how `tenant-delete.mjs` asks (P7-08).
 *
 * Pure, so the scripts' tests can hold it without a database: the archive's
 * layout and its CSV, and the confirmation an erasure waits for.
 */

/** A cell as a spreadsheet will read it: text as text, anything structured as JSON. */
const cell = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);

  return String(value);
};

/** RFC 4180: a cell with a comma, a quote or a line break is quoted, and its quotes doubled. */
const quoted = (text) => (/[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/**
 * Rows as CSV, with every column any row has, in the order first seen. An empty
 * table is a header-less empty file rather than a missing one.
 */
export const toCsv = (rows) => {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  if (columns.length === 0) return '';

  return [
    columns.map(quoted).join(','),
    ...rows.map((row) => columns.map((column) => quoted(cell(row[column]))).join(',')),
  ]
    .join('\r\n')
    .concat('\r\n');
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Every file of one winery's archive, by name: the winery, its members, each
 * table as JSON and as CSV, and a manifest that says what is in it and what is
 * not, and why.
 */
export const archiveFiles = (data, { tenantId, exportedAt, notExported }) => {
  const files = {
    'tenant.json': json(data.tenant),
    'members.json': json(data.members),
    'members.csv': toCsv(data.members),
  };
  const counts = {};

  for (const [table, rows] of Object.entries(data.tables)) {
    files[`tables/${table}.json`] = json(rows);
    files[`tables/${table}.csv`] = toCsv(rows);
    counts[table] = rows.length;
  }

  files['manifest.json'] = json({
    tenantId,
    exportedAt,
    members: data.members.length,
    tables: counts,
    notExported,
    note:
      'Credentials are left out of every row: key hashes and the pieces of a key, ' +
      'invitation tokens, OAuth nonces and domain verification values.',
  });

  return files;
};

/** Whether what was typed is the winery's slug, exactly: no trimming of anything but the line's end. */
export const confirmed = (slug, typed) =>
  typeof typed === 'string' && typed.replace(/\r?\n$/u, '') === slug;

/** `--name value` pairs and `--flag`s, and nothing else. */
export const parseArgs = (argv) => {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);

    const name = arg.slice(2);
    const next = argv[i + 1];

    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }

  return args;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The winery a script was pointed at: a uuid, or nothing is done. */
export const tenantArg = (args) => {
  const tenant = args.tenant;

  if (typeof tenant !== 'string' || !UUID.test(tenant)) {
    throw new Error('Name the winery with --tenant <uuid>.');
  }

  return tenant.toLowerCase();
};
