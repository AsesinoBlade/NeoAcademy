/**
 * Download a project's dependencies BEFORE it is built, in a container that
 * has network but runs no project code:
 *  - CMake FetchContent_Declare(...): read as text; git repositories are
 *    cloned (cloning never executes repository code); archive URLs are
 *    downloaded/extracted by a CMake script NeoAcademy writes, not the project.
 *  - npm: `npm install --ignore-scripts` (no lifecycle scripts).
 *  - pip: `pip download --only-binary=:all:` (wheels only; sdists can run code).
 * HTTPS only. The build then runs in the no-network sandbox, pointed at these
 * copies (FETCHCONTENT_FULLY_DISCONNECTED + FETCHCONTENT_SOURCE_DIR_<NAME>).
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { runContained } from './sandbox';

export interface PrefetchResult {
  /** Extra arguments for every CMake configure command. */
  cmakeArgs: string[];
  /** pip install should use these flags (offline). */
  pipOffline: boolean;
  notes: string[];
}

async function listFiles(dir: string, match: (name: string) => boolean, depth = 6): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || e.name === '_deps' || e.name === 'build' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, match, depth - 1)));
    else if (match(e.name)) out.push(p);
  }
  return out;
}

interface FetchDecl {
  name: string;
  gitRepository?: string;
  gitTag?: string;
  url?: string;
}

/** FetchContent_Declare(name GIT_REPOSITORY x GIT_TAG y ...) / URL x — parsed, never evaluated. */
export function parseFetchContent(text: string): FetchDecl[] {
  const decls: FetchDecl[] = [];
  for (const m of text.matchAll(/FetchContent_Declare\s*\(([\s\S]*?)\)/gi)) {
    const tokens = m[1].replace(/#[^\n]*/g, '').split(/\s+/).map((t) => t.replace(/^"|"$/g, '')).filter(Boolean);
    const name = tokens[0];
    if (!name || !/^[A-Za-z0-9_.+-]+$/.test(name)) continue;
    const get = (key: string) => {
      const i = tokens.findIndex((t) => t.toUpperCase() === key);
      return i >= 0 ? tokens[i + 1] : undefined;
    };
    decls.push({ name, gitRepository: get('GIT_REPOSITORY'), gitTag: get('GIT_TAG'), url: get('URL') });
  }
  return decls;
}

const SAFE_REF = /^[A-Za-z0-9._\-/]+$/;

export async function prefetchDependencies(work: string): Promise<PrefetchResult> {
  const result: PrefetchResult = { cmakeArgs: [], pipOffline: false, notes: [] };
  const depsDir = path.join(work, '_deps');

  // ── CMake FetchContent ──
  const cmakeFiles = await listFiles(work, (n) => n === 'CMakeLists.txt' || n.endsWith('.cmake'));
  const decls = new Map<string, FetchDecl>();
  for (const f of cmakeFiles) for (const d of parseFetchContent(await fs.readFile(f, 'utf-8'))) decls.set(d.name, d);
  if (decls.size) {
    await fs.mkdir(depsDir, { recursive: true });
    result.cmakeArgs.push('-DFETCHCONTENT_FULLY_DISCONNECTED=ON');
  }
  for (const d of decls.values()) {
    const target = path.join(depsDir, `${d.name.toLowerCase()}-src`);
    const containerTarget = `/work/_deps/${d.name.toLowerCase()}-src`;
    let ok = false;
    if (d.gitRepository && /^https:\/\//i.test(d.gitRepository) && (!d.gitTag || SAFE_REF.test(d.gitTag))) {
      const shallow = await runContained({
        argv: ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--depth', '1', ...(d.gitTag ? ['--branch', d.gitTag] : []), d.gitRepository, containerTarget],
        work, runsCode: false, network: true, timeoutSec: 600,
      });
      ok = shallow.code === 0;
      if (!ok && d.gitTag) {
        // A commit hash cannot be cloned with --branch: full clone, then check it out.
        await fs.rm(target, { recursive: true, force: true });
        const full = await runContained({
          argv: ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', d.gitRepository, containerTarget],
          work, runsCode: false, network: true, timeoutSec: 900,
        });
        if (full.code === 0) {
          const checkout = await runContained({
            argv: ['git', '-c', 'core.hooksPath=/dev/null', '-C', containerTarget, 'checkout', '--quiet', d.gitTag],
            work, runsCode: false, timeoutSec: 120,
          });
          ok = checkout.code === 0;
        }
      }
      if (!ok) result.notes.push(`Could not download ${d.name} from ${d.gitRepository}${d.gitTag ? ` (${d.gitTag})` : ''}.`);
    } else if (d.url && /^https:\/\//i.test(d.url)) {
      // Our own script (not the project's) downloads and extracts the archive.
      const script = path.join(depsDir, `fetch-${d.name.toLowerCase()}.cmake`);
      await fs.writeFile(
        script,
        `file(DOWNLOAD "${d.url.replace(/"/g, '')}" "/tmp/${d.name}.archive" STATUS s TLS_VERIFY ON)\n` +
          `list(GET s 0 code)\nif(NOT code EQUAL 0)\n  message(FATAL_ERROR "download failed")\nendif()\n` +
          `file(ARCHIVE_EXTRACT INPUT "/tmp/${d.name}.archive" DESTINATION "/tmp/${d.name}-x")\n` +
          `file(GLOB top LIST_DIRECTORIES true "/tmp/${d.name}-x/*")\nlist(LENGTH top n)\n` +
          `if(n EQUAL 1)\n  file(COPY "\${top}/" DESTINATION "${containerTarget}")\nelse()\n  file(COPY "/tmp/${d.name}-x/" DESTINATION "${containerTarget}")\nendif()\n`,
        'utf-8',
      );
      const res = await runContained({ argv: ['cmake', '-P', `/work/_deps/fetch-${d.name.toLowerCase()}.cmake`], work, runsCode: false, network: true, timeoutSec: 600 });
      ok = res.code === 0;
      if (!ok) result.notes.push(`Could not download ${d.name} from ${d.url}.`);
    } else {
      result.notes.push(`${d.name}: only HTTPS git repositories or archive URLs are downloaded; it will be unavailable offline.`);
    }
    if (ok) result.cmakeArgs.push(`-DFETCHCONTENT_SOURCE_DIR_${d.name.toUpperCase()}=${containerTarget}`);
  }

  // ── npm ──
  if (existsSync(path.join(work, 'package.json'))) {
    const res = await runContained({
      argv: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      work, runsCode: false, network: true, timeoutSec: 900,
    });
    result.notes.push(res.code === 0 ? 'npm packages downloaded (install scripts disabled).' : `npm install failed: ${res.output.slice(-300)}`);
  }

  // ── pip ──
  const requirements = path.join(work, 'requirements.txt');
  if (existsSync(requirements)) {
    const res = await runContained({
      argv: ['pip', 'download', '--only-binary=:all:', '--quiet', '-r', '/work/requirements.txt', '-d', '/work/_deps/wheels'],
      work, runsCode: false, network: true, timeoutSec: 900,
    });
    result.pipOffline = res.code === 0;
    result.notes.push(res.code === 0 ? 'Python wheels downloaded (binary packages only).' : `pip download failed: ${res.output.slice(-300)}`);
  }
  return result;
}
