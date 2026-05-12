// Helpers for parsing wikilinks/tags/frontmatter out of note content,
// computing semantic diffs for Edit blocks, and classifying Write paths.

const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;
// Tags: # followed by non-whitespace tag chars; require start-of-string or
// non-word boundary so URL fragments like `foo.com#bar` don't match.
const TAG_RE = /(?:^|[^\w/&#])#([A-Za-z][\w\-/]*)/g;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\s*\n?/;

export function extractWikilinks(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    out.add(m[1].trim());
  }
  return Array.from(out);
}

export function extractTags(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    out.add(`#${m[1]}`);
  }
  return out.size ? Array.from(out) : [];
}

export interface SetDiff<T> {
  added: T[];
  removed: T[];
}

export function diffSets<T>(oldArr: T[], newArr: T[]): SetDiff<T> {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  const added: T[] = [];
  const removed: T[] = [];
  for (const v of newSet) if (!oldSet.has(v)) added.push(v);
  for (const v of oldSet) if (!newSet.has(v)) removed.push(v);
  return { added, removed };
}

export interface FrontmatterRename {
  titleChanged?: { from?: string; to?: string };
  aliasesChanged?: boolean;
  newTitle?: string;
}

interface ParsedFrontmatter {
  raw: string | null;
  title?: string;
  aliases?: string[];
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { raw: null };
  const body = m[1];
  let title: string | undefined;
  let aliases: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    const titleMatch = /^title:\s*(.+)$/.exec(line);
    if (titleMatch) title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
    const aliasMatch = /^aliases:\s*(.+)$/.exec(line);
    if (aliasMatch) {
      const v = aliasMatch[1].trim();
      if (v.startsWith("[")) {
        aliases = v
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        aliases = [v.replace(/^["']|["']$/g, "")];
      }
    }
  }
  return { raw: body, title, aliases };
}

export function detectFrontmatterRename(oldText: string, newText: string): FrontmatterRename | null {
  const oldFm = parseFrontmatter(oldText);
  const newFm = parseFrontmatter(newText);
  if (!oldFm.raw && !newFm.raw) return null;
  const titleChanged = (oldFm.title ?? "") !== (newFm.title ?? "") && (oldFm.title || newFm.title);
  const oldAliases = (oldFm.aliases ?? []).join("|");
  const newAliases = (newFm.aliases ?? []).join("|");
  const aliasesChanged = oldAliases !== newAliases;
  if (!titleChanged && !aliasesChanged) return null;
  return {
    titleChanged: titleChanged
      ? { from: oldFm.title, to: newFm.title }
      : undefined,
    aliasesChanged: aliasesChanged || undefined,
    newTitle: newFm.title ?? newFm.aliases?.[0],
  };
}

export interface SemanticEditDiff {
  links: SetDiff<string>;
  tags: SetDiff<string>;
  rename: FrontmatterRename | null;
  isEmpty: boolean;
}

export function computeSemanticEditDiff(oldText: string, newText: string): SemanticEditDiff {
  const links = diffSets(extractWikilinks(oldText), extractWikilinks(newText));
  const tags = diffSets(extractTags(oldText), extractTags(newText));
  const rename = detectFrontmatterRename(oldText, newText);
  const isEmpty =
    links.added.length === 0 &&
    links.removed.length === 0 &&
    tags.added.length === 0 &&
    tags.removed.length === 0 &&
    !rename;
  return { links, tags, rename, isEmpty };
}

/**
 * Net-effect aggregation of N edit diffs on the same file. Cancels out chips
 * that were both added AND removed across the run (e.g. wikilink added in edit
 * 2 then removed in edit 4 → not shown). The latest non-null rename wins.
 */
export function mergeEditDiffs(diffs: SemanticEditDiff[]): SemanticEditDiff {
  const addLinks = new Set<string>();
  const removeLinks = new Set<string>();
  const addTags = new Set<string>();
  const removeTags = new Set<string>();
  let rename: FrontmatterRename | null = null;

  for (const d of diffs) {
    d.links.added.forEach((x) => addLinks.add(x));
    d.links.removed.forEach((x) => removeLinks.add(x));
    d.tags.added.forEach((x) => addTags.add(x));
    d.tags.removed.forEach((x) => removeTags.add(x));
    if (d.rename) rename = d.rename;
  }

  const netLinksAdded = [...addLinks].filter((x) => !removeLinks.has(x));
  const netLinksRemoved = [...removeLinks].filter((x) => !addLinks.has(x));
  const netTagsAdded = [...addTags].filter((x) => !removeTags.has(x));
  const netTagsRemoved = [...removeTags].filter((x) => !addTags.has(x));

  const isEmpty =
    netLinksAdded.length === 0 &&
    netLinksRemoved.length === 0 &&
    netTagsAdded.length === 0 &&
    netTagsRemoved.length === 0 &&
    !rename;

  return {
    links: { added: netLinksAdded, removed: netLinksRemoved },
    tags: { added: netTagsAdded, removed: netTagsRemoved },
    rename,
    isEmpty,
  };
}

export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "");
}

export function wordCount(text: string): number {
  const stripped = stripFrontmatter(text).trim();
  if (!stripped) return 0;
  return stripped.split(/\s+/).length;
}

export function previewSnippet(text: string, max = 120): string {
  const cleaned = stripFrontmatter(text).trim().replace(/\s+/g, " ");
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trimEnd() + "…";
}

