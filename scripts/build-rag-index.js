import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function cleanText(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '\n')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function chunkText(text, maxChars = 900) {
  const paragraphs = cleanText(text).split(/\n{2,}|(?<=[。！？；])\s*\n?/u).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) chunks.push(current);
      current = '';
      for (let start = 0; start < paragraph.length; start += maxChars - 120) chunks.push(paragraph.slice(start, start + maxChars));
      continue;
    }
    if (current && current.length + paragraph.length + 1 > maxChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function inferredSection(text) {
  const firstLine = text.split('\n').find(Boolean) || '正文';
  return firstLine.slice(0, 80);
}

async function main() {
  const manifestPath = process.argv[2];
  const outputPath = process.argv[3] || path.join('data', 'knowledge', 'field-service-rag.v1.json');
  if (!manifestPath) throw new Error('Usage: node scripts/build-rag-index.js <manifest.json> [output.json]');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const chunks = [];
  for (const source of manifest.sources || []) {
    const sourcePath = path.resolve(path.dirname(manifestPath), source.path);
    const text = cleanText(await fs.readFile(sourcePath, 'utf8'));
    const sourceHash = `sha256:${sha256(text)}`;
    chunkText(text, Number(manifest.max_chunk_chars) || 900).forEach((chunk, index) => {
      chunks.push({
        chunk_id: `${source.document_id}:chunk-${String(index + 1).padStart(3, '0')}`,
        document_id: source.document_id,
        domain: source.domain,
        title: source.title,
        section: inferredSection(chunk),
        text: chunk,
        source: source.source || path.basename(source.path),
        source_hash: sourceHash,
        tags: source.tags || [],
        report_sections: source.report_sections || [],
      });
    });
  }
  const output = {
    schema_version: 'field-service-rag-index.v1',
    knowledge_version: manifest.knowledge_version || new Date().toISOString().slice(0, 10),
    generated_at: new Date().toISOString(),
    source_count: (manifest.sources || []).length,
    chunk_count: chunks.length,
    chunks,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${chunks.length} chunks from ${output.source_count} sources to ${outputPath}`);
}

await main();

