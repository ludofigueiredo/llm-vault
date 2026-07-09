const fs = require('fs');
const path = require('path');
const JSZip = require('../extension/lib/jszip.min.js');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');
const OUTPUT_DIR = path.join(__dirname, '..', 'dist');

function walk(dir, baseDir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walk(fullPath, baseDir, files);
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const version = manifest.version;

  const zip = new JSZip();
  const files = walk(EXTENSION_DIR, EXTENSION_DIR, []);

  for (const relativePath of files) {
    const content = fs.readFileSync(path.join(EXTENSION_DIR, relativePath));
    zip.file(relativePath, content);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `llm-vault-v${version}.zip`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buffer);

  console.log(`Built ${files.length} files into ${path.relative(process.cwd(), outputPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
