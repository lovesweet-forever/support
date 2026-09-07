// Packs electron-builder's linux-unpacked directory into a .tar.gz with real
// Linux file modes (Windows tar tools drop the executable bits), and adds a
// run.sh launcher next to the binary.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [srcDir, outFile, topName] = process.argv.slice(2);
if (!srcDir || !outFile || !topName) {
  console.error('usage: make-linux-tar.js <linux-unpacked dir> <out.tar.gz> <top-level folder name>');
  process.exit(1);
}

const RUN_SH = `#!/bin/sh
# Launches Interview Copilot.
#
# Chromium's SUID sandbox helper (chrome-sandbox) only works when it is owned by
# root with mode 4755:
#     sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
# Kernels that allow unprivileged user namespaces do not need it. When neither
# applies (e.g. Ubuntu 24.04 defaults) the app is started with --no-sandbox.
DIR="$(cd "$(dirname "$0")" && pwd)"

sandbox_ok() {
  [ "$(stat -c %u "$DIR/chrome-sandbox" 2>/dev/null)" = "0" ] && [ -u "$DIR/chrome-sandbox" ] && return 0
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] && return 1
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] && return 1
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ] && return 1
  return 0
}

if sandbox_ok; then
  exec "$DIR/interview-copilot" "$@"
else
  echo "interview-copilot: SUID sandbox helper not set up; starting with --no-sandbox" >&2
  exec "$DIR/interview-copilot" --no-sandbox "$@"
fi
`;

const EXEC_NAMES = new Set(['interview-copilot', 'chrome_crashpad_handler', 'run.sh']);
function modeFor(rel, isDir) {
  if (isDir) return 0o755;
  const base = path.posix.basename(rel);
  if (base === 'chrome-sandbox') return 0o4755;
  if (EXEC_NAMES.has(base) || /\.so(\.\d+)*$/.test(base)) return 0o755;
  return 0o644;
}

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name, mode, size, mtime, type) {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 154);
    if (i <= 0 || name.length - i - 1 > 100) throw new Error('path too long for ustar: ' + name);
    prefix = name.slice(0, i);
    name = name.slice(i + 1);
  }
  buf.write(name, 0, 100);
  buf.write(octal(mode, 8), 100, 8);
  buf.write(octal(0, 8), 108, 8);
  buf.write(octal(0, 8), 116, 8);
  buf.write(octal(size, 12), 124, 12);
  buf.write(octal(mtime, 12), 136, 12);
  buf.write('        ', 148, 8); // checksum placeholder
  buf.write(type, 156, 1);
  buf.write('ustar\0', 257, 6);
  buf.write('00', 263, 2);
  buf.write('root', 265, 32);
  buf.write('root', 297, 32);
  buf.write(octal(0, 8), 329, 8);
  buf.write(octal(0, 8), 337, 8);
  buf.write(prefix, 345, 155);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

async function main() {
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(outFile);
  gz.pipe(out);
  const write = (chunk) => new Promise((res) => (gz.write(chunk) ? res() : gz.once('drain', res)));
  const mtime = Math.floor(Date.now() / 1000);
  let files = 0;

  async function addFile(tarPath, absPath, mode, size) {
    await write(header(tarPath, mode, size, mtime, '0'));
    for await (const chunk of fs.createReadStream(absPath)) await write(chunk);
    const pad = (512 - (size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad, 0));
    files++;
  }

  async function walk(dir, rel) {
    await write(header(rel + '/', 0o755, 0, mtime, '5'));
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, ent.name);
      const r = rel + '/' + ent.name;
      if (ent.isDirectory()) await walk(abs, r);
      else await addFile(r, abs, modeFor(r, false), fs.statSync(abs).size);
    }
  }

  await walk(srcDir, topName);
  // run.sh launcher (LF line endings, executable)
  const sh = Buffer.from(RUN_SH.replace(/\r\n/g, '\n'), 'utf8');
  await write(header(topName + '/run.sh', 0o755, sh.length, mtime, '0'));
  await write(sh);
  await write(Buffer.alloc((512 - (sh.length % 512)) % 512, 0));
  files++;
  await write(Buffer.alloc(1024, 0)); // end-of-archive
  await new Promise((res) => gz.end(res));
  await new Promise((res) => out.on('finish', res));
  console.log(`wrote ${outFile} (${files} files, ${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
