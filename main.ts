// mend: one patch tool for every AI edit format, as SPEC.md specifies (MIT).
// Reads unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
// V4A patches and JSON text-editor tool calls; finds the lines an edit names
// at the first of three matching tiers; changes every file or none.
// Node 22 and its standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under SPEC.md section 3: its break, its lines, whether it ends with one. */
interface FileDoc {
  br: string;
  lines: string[];
  fin: boolean;
}
function splitFile(t: string): FileDoc {
  if (t === '') return { br: '\n', lines: [], fin: false };
  const i = t.indexOf('\n');
  const br = i > 0 && t[i - 1] === '\r' ? '\r\n' : '\n';
  const parts = t.split(br);
  const fin = t.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}
function joinFile(d: FileDoc): string {
  return d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.fin ? d.br : '');
}

/** Matching tiers (SPEC.md section 5). */
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
function tierEq(t: number, a: string, b: string): boolean {
  if (t === 0) return a === b;
  if (t === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}
/** Every position at or after `from` where O occurs in F at one tier. */
function occAt(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(tier, O[j], F[i + j])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function firstTier(O: string[], F: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(O, F, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oi: number;
}
/** Replace F[pos .. pos+O.length) with N, re-indenting at tier 2 as section 5 says. */
function applyReplace(F: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out = F.slice(0, pos);
  const fLead = tier === 2 && O.length > 0 ? leadWS(F[pos]) : '';
  const pLead = tier === 2 && O.length > 0 ? leadWS(O[0]) : '';
  for (const n of N) {
    if (n.ctx) out.push(F[pos + n.oi]);
    else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(pLead)) out.push(fLead + n.text.slice(pLead.length));
    else out.push(n.text);
  }
  out.push(...F.slice(pos + O.length));
  return out;
}

/** A move an edit performed, for the R lines of section 2. */
interface MoveRec {
  old: string;
  nu: string;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** --- Unified diffs (SPEC.md section 6). --- */

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
}
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** Split a hunk's O lines and N lines out of its body items, keeping the context mapping. */
function hunkON(items: BodyItem[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      N.push({ text: it.text, ctx: true, oi: O.length });
      O.push(it.text);
    } else if (it.kind === 'old') O.push(it.text);
    else if (it.kind === 'new') N.push({ text: it.text, ctx: false, oi: -1 });
  }
  return { O, N };
}

/** Apply a section's hunks in order to a file's lines; the final break follows section 6. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = doc.lines.slice();
  let fin = doc.fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h.items);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const ins = N.map((n) => n.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd && ins.length > 0) fin = !h.noFinal;
    } else {
      const found = firstTier(O, lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      for (const p of found.occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const touchesEnd = best + O.length === lines.length;
      lines = applyReplace(lines, best, O, N, found.tier);
      if (touchesEnd) fin = !h.noFinal;
    }
    d += N.length - O.length;
  }
  return { br: doc.br, lines, fin };
}

/** A unified section's paths: the `---`/`+++` pair first, then rename, then `diff --git`. */
function resolvePath(dash: string | null, rename: string | null, diff: string | null): { path: string | null; devNull: boolean } {
  const raw = dash ?? rename ?? diff;
  if (raw === null) return { path: null, devNull: false };
  if (raw === '/dev/null') return { path: null, devNull: true };
  let p = raw;
  if (dash !== null) {
    if (p.startsWith('a/')) p = p.slice(2);
    else if (p.startsWith('b/')) p = p.slice(2);
  }
  return { path: p, devNull: false };
}

function parseUnified(lines: string[], strict: boolean, moves: MoveRec[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const dashPath = (l: string): string => {
    const rest = l.slice(4);
    const tab = rest.indexOf('\t');
    return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1], diffNew: m[2], dashOld: null, dashNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j];
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          items.push({ kind: 'ctx', text: '' });
          j++;
        } else if (b[0] === ' ') {
          items.push({ kind: 'ctx', text: b.slice(1) });
          j++;
        } else if (b[0] === '-') {
          items.push({ kind: 'old', text: b.slice(1) });
          j++;
        } else if (b[0] === '+') {
          items.push({ kind: 'new', text: b.slice(1) });
          j++;
        } else if (b[0] === '\\') {
          items.push({ kind: 'bs', text: b.slice(1) });
          j++;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1].kind === 'ctx' && items[items.length - 1].text === '') items.pop();
      let noFinal = false;
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].kind === 'ctx' || items[k].kind === 'new') {
          noFinal = items[k + 1] !== undefined && items[k + 1].kind === 'bs';
          break;
        }
      }
      cur.hunks.push({ a: parseInt(m[1], 10), items, noFinal });
      inHeader = false;
      i = j;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nxt = lines[i + 1] ?? '';
      if (inHeader) {
        if (!nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur!.dashOld === null) cur!.dashOld = dashPath(l);
        if (cur!.dashNew === null) cur!.dashNew = dashPath(nxt);
        i += 2;
        continue;
      }
      if (nxt.startsWith('+++ ')) {
        cur = { diffOld: null, diffNew: null, dashOld: dashPath(l), dashNew: dashPath(nxt), renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => {
    const o = resolvePath(sec.dashOld, sec.renameFrom, sec.diffOld);
    const n = resolvePath(sec.dashNew, sec.renameTo, sec.diffNew);
    const oldP = o.path;
    const newP = n.path;
    const isCreation = o.devNull || sec.newFile;
    const isDeletion = n.devNull || sec.delFile;
    let kind: string;
    if (isCreation && !isDeletion) kind = 'create';
    else if (isDeletion && !isCreation) kind = 'delete';
    else if (isCreation && isDeletion) kind = newP !== null ? 'create' : 'delete';
    else if (oldP !== null && newP !== null && oldP !== newP) kind = 'move';
    else kind = 'change';
    if (kind === 'create') {
      const np = newP ?? '';
      return (tree: Tree): void => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
        let noFinal = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const items = sec.hunks[hi].items;
          for (let k = items.length - 1; k >= 0; k--) {
            if (items[k].kind === 'new') {
              noFinal = items[k + 1] !== undefined && items[k + 1].kind === 'bs';
              break outer;
            }
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      };
    }
    if (kind === 'delete') {
      const op = oldP ?? '';
      return (tree: Tree): void => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    if (kind === 'move') {
      const op = oldP ?? '';
      const np = newP ?? '';
      return (tree: Tree): void => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const t = tree.get(op);
        if (t === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        tree.now.set(op, null);
        tree.now.set(np, joinFile(applyHunks(splitFile(t), sec.hunks, strict, op)));
        moves.push({ old: op, nu: np });
      };
    }
    const p = oldP ?? newP ?? '';
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      tree.now.set(p, joinFile(applyHunks(splitFile(t), sec.hunks, strict, p)));
    };
  });
}

/** --- SEARCH/REPLACE blocks (SPEC.md section 7). --- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j];
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let sep = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '=======') {
          sep = k;
          break;
        }
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      const old = lines.slice(i + 1, sep);
      const nw = lines.slice(sep + 1, rep);
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (old.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
          return;
        }
        const t = tree.get(p);
        if (t === null) throw new Fail('missing', p);
        const doc = splitFile(t);
        const found = firstTier(old, doc.lines, strict, 0);
        if (found === null) throw new Fail('no-match', p);
        if (found.occ.length > 1) throw new Fail('ambiguous', p);
        const N: NLine[] = nw.map((text) => ({ text, ctx: false, oi: -1 }));
        tree.now.set(p, joinFile({ br: doc.br, lines: applyReplace(doc.lines, found.occ[0], old, N, found.tier), fin: doc.fin }));
      });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return edits;
}

/** --- V4A patches (SPEC.md section 8). --- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function parseV4a(lines: string[], strict: boolean, moves: MoveRec[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): { kind: string; path: string } | null => {
    const names: Array<[string, string]> = [
      ['Add File', 'add'],
      ['Delete File', 'del'],
      ['Update File', 'upd'],
    ];
    for (const [name, kind] of names) {
      const pre = `*** ${name}: `;
      if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    }
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    const s = secStart(l);
    if (s === null) throw new Exit2(`error: parse ${i + 1}`);
    if (s.kind === 'add') {
      const ls: string[] = [];
      let j = i + 1;
      while (j < last && secStart(lines[j]) === null) {
        const x = lines[j];
        if (x === '') ls.push('');
        else if (x[0] === '+') ls.push(x.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      const p = s.path;
      const fileLines = ls;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
    } else if (s.kind === 'del') {
      let j = i + 1;
      while (j < last && secStart(lines[j]) === null) {
        if (!blank(lines[j])) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      const p = s.path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
    } else {
      const updLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j].startsWith('*** Move to: ')) {
        moveTo = lines[j].slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < last && secStart(lines[j]) === null) {
        const x = lines[j];
        if (x.startsWith('@@')) {
          closeChunk();
          const anchor = x.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          firstChunk = false;
          j++;
        } else if (x === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          closeChunk();
          firstChunk = false;
          j++;
        } else if (cur === null && !firstChunk && blank(x)) {
          j++;
        } else if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, items: [] };
            firstChunk = false;
          }
          cur.items.push(
            x === ''
              ? { kind: 'ctx', text: '' }
              : x[0] === ' '
                ? { kind: 'ctx', text: x.slice(1) }
                : x[0] === '-'
                  ? { kind: 'old', text: x.slice(1) }
                  : { kind: 'new', text: x.slice(1) },
          );
          j++;
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1];
        while (lc.items.length > 0 && lc.items[lc.items.length - 1].kind === 'ctx' && lc.items[lc.items.length - 1].text === '') lc.items.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      const p = s.path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const t = tree.get(p);
        if (t === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const doc = splitFile(t);
        let flines = doc.lines.slice();
        let cursor = 0;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const ch of chs) {
          if (ch.anchor !== null) {
            let found = -1;
            for (const tier of tiers) {
              for (let k = cursor; k < flines.length; k++) {
                if (tierEq(tier, ch.anchor, flines[k])) {
                  found = k;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          const { O, N } = hunkON(ch.items);
          if (O.length === 0) {
            const at = ch.eof ? flines.length : cursor;
            flines = [...flines.slice(0, at), ...N.map((n) => n.text), ...flines.slice(at)];
            cursor = at + N.length;
          } else {
            let hit: { tier: number; pos: number } | null = null;
            for (const tier of tiers) {
              const occ = occAt(O, flines, tier, cursor).filter((q) => !ch.eof || q + O.length === flines.length);
              if (occ.length > 0) {
                hit = { tier, pos: occ[0] };
                break;
              }
            }
            if (hit === null) throw new Fail('no-match', p);
            flines = applyReplace(flines, hit.pos, O, N, hit.tier);
            cursor = hit.pos + N.length;
          }
        }
        const out = joinFile({ br: doc.br, lines: flines, fin: doc.fin });
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, out);
          moves.push({ old: p, nu: mt });
        } else tree.now.set(p, out);
      });
      i = j;
    }
  }
  return edits;
}

/** --- The command line (SPEC.md sections 1, 2 and 10). --- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: MoveRec[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const m of moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.nu);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      usedOld.add(m.old);
      usedNew.add(m.nu);
      rows.push({ key: m.nu, text: `R ${m.old} -> ${m.nu}` });
    }
  }
  for (const [p, c] of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
