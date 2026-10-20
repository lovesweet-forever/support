// sherpa-onnx-node (offline transcription) ships its native addon as one npm
// package per platform + CPU, and npm only installs the one matching the
// machine that runs `npm install`. A macOS build of the *other* architecture
// (x64 on an Apple-silicon Mac, or the reverse) would then have no addon and
// no offline transcription. This fetches the missing darwin packages into
// node_modules before electron-builder packs them.
//
//   node scripts/ensure-sherpa-arch.js arm64 x64
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const version = require('sherpa-onnx-node/package.json').version;
const root = path.join(__dirname, '..', 'node_modules');

for (const arch of process.argv.slice(2)) {
  const name = `sherpa-onnx-darwin-${arch}`;
  const dir = path.join(root, name);
  if (fs.existsSync(path.join(dir, 'sherpa-onnx.node'))) continue;
  console.log(`fetching ${name}@${version} for the ${arch} build`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-'));
  // `npm pack` downloads the tarball regardless of the current platform.
  const tgz = execSync(`npm pack ${name}@${version} --silent`, { cwd: tmp }).toString().trim().split('\n').pop();
  fs.mkdirSync(dir, { recursive: true });
  execSync(`tar -xzf "${path.join(tmp, tgz)}" --strip-components=1 -C "${dir}"`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
