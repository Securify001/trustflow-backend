import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

/**
 * #652 — `backup-postgres.sh` must stream its dump and must never record a backup it has not
 * verified.
 *
 * These cases drive the real script with a stubbed `pg_dump`/`gzip` on `PATH`, so they need no
 * database and no privileges: the behaviour under test is entirely in the script's error
 * handling, not in Postgres. `backup-restore.integration.spec.ts` covers the real round trip
 * when `DATABASE_URL` is available; this suite covers the failure modes that must hold even on
 * a machine with no infrastructure at all.
 */

// This spec lives in src/backup, so the backend root is two levels up.
const BACKEND_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(BACKEND_ROOT, 'scripts', 'backup-postgres.sh');

/**
 * Absolute path to the real `gzip`, so the `gzip` stub below can delegate the `-t`/`-dc`
 * invocations the script makes for verification while faking only the compression step.
 */
const REAL_GZIP = spawnSync('bash', ['-c', 'command -v gzip'], { encoding: 'utf8' }).stdout.trim();

let workDir: string;
let binDir: string;
let outDir: string;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

function writeStub(name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A `pg_dump` that emits a small, valid plain-format dump and succeeds. */
const WORKING_PG_DUMP = `#!/usr/bin/env bash
echo "-- trustflow dump"
echo "CREATE TABLE probe (id int);"
echo "INSERT INTO probe VALUES (1);"
exit 0
`;

function runScript(env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      DATABASE_URL: 'postgres://stub/stub',
      BACKUP_DIR: outDir,
      // Keep retention wide so a test's own outputs are never pruned mid-run; the
      // stale-debris case sets this explicitly.
      BACKUP_RETENTION_DAYS: '3650',
      ...env,
    },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status, stdout, stderr, combined: `${stdout}${stderr}` };
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** Names of the recorded dumps, i.e. the artefacts an operator would treat as backups. */
function recordedDumps(): string[] {
  return filesIn(outDir).filter(name => name.endsWith('.sql.gz'));
}

describe('backup-postgres.sh dump verification (#652)', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tf-backup-'));
    binDir = join(workDir, 'bin');
    outDir = join(workDir, 'out');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('streaming', () => {
    it('compresses through a pipe so the dump is never buffered in memory', () => {
      // The dump must reach gzip as a stream rather than via a temp file or a command
      // substitution, which is what keeps peak RSS independent of database size.
      const source = readFileSync(SCRIPT, 'utf8');
      expect(source).toMatch(/pg_dump[\s\S]*\|\s*gzip/);
      // No uncompressed intermediate file is left where a full dump could be buffered.
      expect(source).not.toMatch(/pg_dump[^\n]*>\s*"?\$\{?[A-Za-z_]*[Ss][Qq][Ll]/);
    });
  });

  describe('failure handling', () => {
    it('records a valid dump and reports success', () => {
      writeStub('pg_dump', WORKING_PG_DUMP);

      const result = runScript();

      expect(result.status).toBe(0);
      expect(result.combined).toMatch(/Dump complete/);
      expect(recordedDumps()).toHaveLength(1);
      // The dump is actually restorable, not merely present.
      expect(result.combined).toMatch(/checksum written to/);
    });

    it('fails with a clear message and records nothing when pg_dump exits non-zero', () => {
      writeStub(
        'pg_dump',
        `#!/usr/bin/env bash
echo "-- partial output"
exit 3
`,
      );

      const result = runScript();

      expect(result.status).toBe(1);
      expect(result.combined).toMatch(/pg_dump failed with exit code 3/);
      expect(recordedDumps()).toHaveLength(0);
    });

    it('leaves no partial dump behind when pg_dump fails', () => {
      // A nightly job that dies mid-dump must not accumulate debris. The retention sweep
      // only matches `*.sql.gz`, so an orphaned `.partial` would never be cleaned up.
      writeStub(
        'pg_dump',
        `#!/usr/bin/env bash
echo "-- partial output"
exit 1
`,
      );

      runScript();

      expect(filesIn(outDir)).toEqual([]);
    });

    it('rejects a dump that decompresses to zero bytes', () => {
      // gzip emits a valid ~20 byte stream even for empty input, so checking the compressed
      // file for non-emptiness is always true. Without a decompressed-size check this
      // content-free dump would be checksummed and retained as a successful backup.
      writeStub(
        'pg_dump',
        `#!/usr/bin/env bash
exit 0
`,
      );

      const result = runScript();

      expect(result.status).toBe(1);
      expect(result.combined).toMatch(/decompresses to zero bytes/);
      expect(recordedDumps()).toHaveLength(0);
    });

    it('rejects a corrupt gzip stream even when the compressor reports success', () => {
      // Models a compressor killed mid-write by a full disk: it exits 0 and leaves a file
      // that only fails its CRC at restore time. `gzip -t` is what catches it here.
      writeStub('pg_dump', WORKING_PG_DUMP);
      writeStub(
        'gzip',
        `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    -t|-dc) exec ${REAL_GZIP} "$@" ;;
  esac
done
# Drain stdin so the pg_dump stub on the other end of the pipe can finish writing
# without receiving SIGPIPE. Without this the race between the two processes would
# cause pg_dump to exit 141 (128+SIGPIPE) before the script ever reaches the gzip -t
# integrity check that this test is actually exercising.
cat >/dev/null
echo "THIS IS NOT A VALID GZIP STREAM"
exit 0
`,
      );

      const result = runScript();

      expect(result.status).toBe(1);
      expect(result.combined).toMatch(/failed gzip integrity verification/);
      expect(recordedDumps()).toHaveLength(0);
    });

    it('prunes an orphaned partial dump left by a previously killed run', () => {
      writeStub('pg_dump', WORKING_PG_DUMP);
      const orphan = join(outDir, 'trustflow-20200101T000000Z.sql.gz.partial');
      writeFileSync(orphan, 'incomplete', 'utf8');
      // Backdate it past the retention window.
      spawnSync('bash', ['-c', `touch -d '30 days ago' ${JSON.stringify(orphan)}`]);

      const result = runScript({ BACKUP_RETENTION_DAYS: '1' });

      expect(result.status).toBe(0);
      expect(filesIn(outDir)).not.toContain('trustflow-20200101T000000Z.sql.gz.partial');
      // The live dump from this run is retained.
      expect(recordedDumps()).toHaveLength(1);
    });
  });
});
