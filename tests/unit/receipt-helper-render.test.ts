import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptHelperReparse from '../../src/lib/components/receipts/ReceiptHelperReparse.svelte';
import ReceiptReviewEditor from '../../src/lib/components/receipts/ReceiptReviewEditor.svelte';
import type {
  ReceiptDetail,
  ReceiptParseQuality,
} from '../../src/lib/shared/schemas';

/**
 * The fallback offer as the reviewer sees it: why the parse looks bad, one
 * button to ask for help, and — before anything is replaced — a confirm that
 * says what is kept.
 */

const reasons = ['no price column was found', 'no subtotal or total was found'];

function readable(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/ svelte-\w+/gu, '')
    .replace(/\s+/gu, ' ');
}

function renderOffer(props: Record<string, unknown> = {}): string {
  return readable(
    render(ReceiptHelperReparse, {
      props: {
        reasons,
        onArm: () => {},
        onCancel: () => {},
        onConfirm: () => {},
        ...props,
      },
    }).body,
  );
}

describe('ReceiptHelperReparse', () => {
  it('names the reasons and offers one tap to ask for help', () => {
    const body = renderOffer();

    expect(body).toContain('This receipt was hard to read');
    expect(body).toContain('no price column was found');
    expect(body).toContain('no subtotal or total was found');
    expect(body).toContain('Re-parse with helper');
    expect(body).not.toContain('Replace the lines');
  });

  it('asks twice, and says the photo and raw OCR text are kept', () => {
    const body = renderOffer({ confirming: true });

    expect(body).toContain('Replace the lines');
    expect(body).toContain('Cancel');
    expect(body).toContain(
      "The parsed lines below are replaced with the helper's reading.",
    );
    expect(body).toContain('The photo and the raw OCR text are kept.');
  });

  it('shows the helper working and refuses a second tap meanwhile', () => {
    const body = renderOffer({ confirming: true, busy: true, applying: true });

    expect(body).toContain('Re-parsing…');
    expect(body).toMatch(/class="confirm-reparse-button"[^>]*disabled/u);
  });
});

/** A reviewable receipt carrying nothing but the quality assessment. */
function detail(quality: ReceiptParseQuality | null): ReceiptDetail {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    status: 'review',
    createdAt: '2026-10-17T12:00:00.000Z',
    capturedAt: null,
    processedAt: null,
    parseVersion: 1,
    attempts: 1,
    ocrWarnings: '[]',
    parseQuality: quality,
    updatedAt: '2026-10-17T12:05:00.000Z',
    committedAt: null,
    currency: 'USD',
    subtotalMinor: null,
    taxMinor: null,
    totalMinor: null,
    storeGroupId: null,
    imageAvailable: false,
    hasUnknowns: false,
    lastError: null,
    ocrText: 'WASHED OUT',
    lines: [],
  };
}

function renderEditor(
  quality: ReceiptParseQuality | null,
  helperEnabled: boolean,
): string {
  return readable(
    render(ReceiptReviewEditor, {
      props: {
        detail: detail(quality),
        writable: true,
        helperEnabled,
        onSaved: () => {},
      },
    }).body,
  );
}

const lowQuality: ReceiptParseQuality = {
  lowConfidence: true,
  helperApplied: false,
  reasons: ['no price column was found'],
};

describe('ReceiptReviewEditor — the helper offer', () => {
  it('offers a re-parse for a low-confidence receipt when a helper is configured', () => {
    const body = renderEditor(lowQuality, true);

    expect(body).toContain('This receipt was hard to read');
    expect(body).toContain('no price column was found');
    expect(body).toContain('Re-parse with helper');
  });

  it('leaves the review screen unchanged when no helper is configured', () => {
    const body = renderEditor(lowQuality, false);

    expect(body).not.toContain('This receipt was hard to read');
    expect(body).not.toContain('Re-parse with helper');
  });

  it('does not offer the helper on a confident parse', () => {
    expect(
      renderEditor(
        { lowConfidence: false, helperApplied: false, reasons: [] },
        true,
      ),
    ).not.toContain('Re-parse with helper');
  });

  it('does not offer the helper again on its own output', () => {
    expect(
      renderEditor({ ...lowQuality, helperApplied: true }, true),
    ).not.toContain('Re-parse with helper');
  });
});
