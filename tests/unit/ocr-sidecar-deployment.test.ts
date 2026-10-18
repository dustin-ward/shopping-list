import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deployment contract for the OCR sidecar, checked against the files a
 * release ships rather than against a running engine: the image must stay
 * optional, hardened, published in lockstep, and offline at start-up.
 */

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

/** One compose service's block, from its 2-space key to the next one. */
function service(file: string, name: string): string {
  const lines = read(file).split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `${file} has no ${name} service`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z][\w-]*:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Every YAML block literal introduced by `tags: |`, as trimmed lines. */
function tagBlocks(source: string): string[][] {
  const lines = source.split('\n');
  const blocks: string[][] = [];
  lines.forEach((line, index) => {
    if (line.trim() !== 'tags: |') return;
    const indent = line.search(/\S/);
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue;
      if (lines[cursor].search(/\S/) <= indent) break;
      block.push(lines[cursor].trim());
    }
    blocks.push(block);
  });
  return blocks;
}

function expectHardened(sidecar: string): void {
  expect(sidecar).toMatch(/read_only: true/);
  expect(sidecar).toMatch(/mem_limit: 1g/);
  expect(sidecar).toMatch(/cap_drop:\n\s+- ALL/);
  expect(sidecar).toMatch(/no-new-privileges:true/);
  expect(sidecar).toMatch(/tmpfs:\n\s+- \/tmp/);
  expect(sidecar).toMatch(/\/healthz/);
}

function expectAppReceivesTheSidecar(file: string): void {
  const app = service(file, 'shopping-list');
  expect(app).toContain('RECEIPT_OCR_URL: ${RECEIPT_OCR_URL:-}');
  expect(app).toContain('RECEIPT_OCR_MODE: ${RECEIPT_OCR_MODE:-http}');
  expect(app).toContain(
    'RECEIPT_OCR_TIMEOUT_MS: ${RECEIPT_OCR_TIMEOUT_MS:-30000}',
  );
  expect(app).toContain('RECEIPT_OCR_TOKEN: ${RECEIPT_OCR_TOKEN:-}');
  // The shipped shape also carries the capture settings: money in a configured
  // currency, images inside the /data volume, and the retention escape hatch.
  expect(app).toContain('RECEIPT_CURRENCY: ${RECEIPT_CURRENCY:-USD}');
  expect(app).toContain('RECEIPT_STORAGE_DIR: /data/receipts');
  expect(app).toContain(
    'RECEIPT_IMAGE_RETENTION: ${RECEIPT_IMAGE_RETENTION:-keep}',
  );
}

describe('dev compose', () => {
  const sidecar = service('compose.yaml', 'receipt-ocr');

  it('is opt-in behind the ocr profile and builds from the repo', () => {
    expect(sidecar).toContain("profiles: ['ocr']");
    expect(sidecar).toContain('context: ./ocr-sidecar');
    expect(sidecar).toContain(
      'image: ${RECEIPT_OCR_IMAGE:-shopping-list-receipt-ocr:local}',
    );
  });

  it('publishes no port and caps the container', () => {
    expect(sidecar).not.toMatch(/^\s+ports:/m);
    expectHardened(sidecar);
  });

  it('shares the token and records settings with the app', () => {
    expectAppReceivesTheSidecar('compose.yaml');
    expect(sidecar).toContain('RECEIPT_OCR_TOKEN: ${RECEIPT_OCR_TOKEN:-}');
  });
});

describe('prod compose', () => {
  const sidecar = service('compose.prod.yaml', 'receipt-ocr');

  it('runs the published sidecar image', () => {
    expect(sidecar).toContain("profiles: ['ocr']");
    expect(sidecar).toContain(
      'image: ${RECEIPT_OCR_IMAGE:-ghcr.io/dustin-ward/shopping-list-receipt-ocr:latest}',
    );
    expect(sidecar).not.toContain('build:');
  });

  it('documents the sidecar image as a sibling of the app image', () => {
    const env = read('.env.prod.example');
    const image = (name: string) =>
      new RegExp(`^${name}=(\\S+)$`, 'm').exec(env)?.[1];
    const appImage = image('SHOPPING_LIST_IMAGE');
    const sidecarImage = image('RECEIPT_OCR_IMAGE');
    const tag = (value: string | undefined) => value?.split(':').pop();

    expect(sidecarImage).toContain('shopping-list-receipt-ocr');
    expect(tag(sidecarImage)).toBe(tag(appImage));
  });

  it('publishes no port and caps the container', () => {
    expect(sidecar).not.toMatch(/^\s+ports:/m);
    expectHardened(sidecar);
  });

  it('is paired with the app by RECEIPT_OCR_URL', () => {
    expectAppReceivesTheSidecar('compose.prod.yaml');
  });
});

describe('release workflow', () => {
  const workflow = read('.github/workflows/release.yml');

  it('publishes the app image and the sidecar image', () => {
    expect(workflow).toContain('images: ghcr.io/${{ github.repository }}');
    expect(workflow).toContain(
      'images: ghcr.io/${{ github.repository }}-receipt-ocr',
    );
    expect(workflow).toContain('context: ./ocr-sidecar');
    expect(workflow).toContain('file: ./ocr-sidecar/Dockerfile');
  });

  it('gives both images identical tags', () => {
    const blocks = tagBlocks(workflow);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(blocks[1]);
    // The app image is published only after the sidecar image succeeded, so a
    // release tag never names one image without the other.
    expect(workflow).toContain('needs: [verify, publish-receipt-ocr]');
    expect(blocks[0]).toContain('type=semver,pattern={{version}}');
    expect(blocks[0]).toContain(
      'type=raw,value=latest,enable=${{ !github.event.release.prerelease }}',
    );
  });
});

describe('sidecar image', () => {
  const dockerfile = read('ocr-sidecar/Dockerfile');
  const requirements = read('ocr-sidecar/requirements.txt');

  it('bakes the models at build time and has no start-up download', () => {
    expect(dockerfile).toMatch(/INDRA_OCR_MODEL_DIR=\/models/);
    expect(dockerfile).toMatch(/HF_HUB_OFFLINE=1/);
    expect(dockerfile).toMatch(/hf download/);
    expect(dockerfile).toMatch(/--revision/);
    expect(dockerfile).toMatch(/COPY --from=build \/models \/models/);
    // The command that serves requests is the HTTP app, never the downloader.
    expect(dockerfile).toMatch(/^CMD \["python", "app\.py"\]$/m);
  });

  it('pins the engine, runs unprivileged and healthchecks /healthz', () => {
    expect(requirements).toMatch(/^indra-ocr==\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toContain('/healthz');
  });
});
