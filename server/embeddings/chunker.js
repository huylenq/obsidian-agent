const CHUNK_SIZE = 6000;

/**
 * Split markdown content into heading-aware chunks.
 * Returns array of { id, path, title, content, chunkIndex }.
 */
export function chunkMarkdown(content, path) {
  const title = path.split("/").pop()?.replace(/\.md$/, "") || path;

  // Strip YAML frontmatter
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n?/, "");

  if (stripped.length <= CHUNK_SIZE) {
    return [{ id: `${path}::0`, path, title, content: stripped, chunkIndex: 0 }];
  }

  // Split at heading boundaries (## and above)
  const sections = splitAtHeadings(stripped);
  const chunks = [];

  for (const section of sections) {
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section);
    } else {
      // Further split oversized sections by paragraphs
      chunks.push(...splitBySize(section, CHUNK_SIZE));
    }
  }

  return chunks.map((text, i) => ({
    id: `${path}::${i}`,
    path,
    title,
    content: text,
    chunkIndex: i,
  }));
}

/**
 * Split text at heading boundaries (lines starting with #).
 * Keeps the heading with its following content.
 */
function splitAtHeadings(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = [];

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join("\n"));
  }

  return sections;
}

/**
 * Split text into chunks of at most maxSize characters,
 * preferring paragraph boundaries.
 */
function splitBySize(text, maxSize) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxSize && current.length > 0) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
