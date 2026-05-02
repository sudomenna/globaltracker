// INV-TRACKER-001: bundle < 15 KB gzipped
// INV-TRACKER-002: zero runtime dependencies — esbuild bundle with no externals
const esbuild = require('esbuild');
const path = require('node:path');
const zlib = require('node:zlib');
const fs = require('node:fs');

const MAX_GZIP_BYTES = 15 * 1024; // 15 KB

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/index.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: '__FunilBundle',
    outfile: path.join(__dirname, 'dist/tracker.js'),
    platform: 'browser',
    target: ['es2017'],
    // INV-TRACKER-002: no runtime externals allowed
    external: [],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  if (result.errors.length > 0) {
    console.error('Build errors:', result.errors);
    process.exit(1);
  }

  // Verify gzip size — INV-TRACKER-001
  const bundleContent = fs.readFileSync(
    path.join(__dirname, 'dist/tracker.js'),
  );
  const gzipped = zlib.gzipSync(bundleContent);
  const gzipBytes = gzipped.length;

  console.log(
    `Bundle size: ${bundleContent.length} bytes (${(bundleContent.length / 1024).toFixed(2)} KB raw)`,
  );
  console.log(
    `Gzipped size: ${gzipBytes} bytes (${(gzipBytes / 1024).toFixed(2)} KB)`,
  );

  if (gzipBytes > MAX_GZIP_BYTES) {
    console.error(
      `ERROR: Bundle exceeds 15 KB gzipped limit (${gzipBytes} bytes). INV-TRACKER-001 violated.`,
    );
    process.exit(1);
  }

  console.log('Build successful. INV-TRACKER-001 satisfied.');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
