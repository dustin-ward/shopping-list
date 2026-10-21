import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ReceiptUnknowns from '../../src/lib/components/receipts/ReceiptUnknowns.svelte';
import type {
  UnknownLineGroup,
  UnknownLinesOverview,
} from '../../src/lib/shared/schemas';

/**
 * The unknown-line grouped browser as the reviewer meets it: wordings with
 * their line counts and unidentified spend, the total the view exists for, and
 * the two-tap bind that keeps a whole phrase from moving by accident.
 */

function readable(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/gu, '').replace(/ svelte-\w+/gu, '');
}

function group(overrides: Partial<UnknownLineGroup> = {}): UnknownLineGroup {
  return {
    normalizedText: 'mystery item',
    printedText: 'MYSTERY ITEM',
    lineCount: 3,
    receiptCount: 2,
    spendMinor: 749,
    ...overrides,
  };
}

function overview(
  overrides: Partial<UnknownLinesOverview> = {},
): UnknownLinesOverview {
  return {
    currency: 'USD',
    groups: [group()],
    lineCount: 3,
    spendMinor: 749,
    ...overrides,
  };
}

const noop = () => {};

type UnknownProps = {
  writable?: boolean;
  pending?: Record<string, string>;
  busyGroup?: string | null;
  error?: string;
  notice?: string;
  catalogItems?: { id: string; name: string }[];
};

function renderUnknowns(
  body: UnknownLinesOverview,
  {
    writable = true,
    pending = {},
    busyGroup = null,
    error = '',
    notice = '',
    catalogItems = [],
  }: UnknownProps = {},
): string {
  return readable(
    render(ReceiptUnknowns, {
      props: {
        overview: body,
        writable,
        pending,
        busyGroup,
        error,
        notice,
        catalogItems,
        onBind: noop,
        onSelect: noop,
        onCancel: noop,
      },
    }).body,
  );
}

describe('ReceiptUnknowns — the unidentified-spending view', () => {
  it('shows each wording with its line count and spend', () => {
    const body = renderUnknowns(
      overview({
        groups: [
          group(),
          group({
            normalizedText: 'other thing',
            printedText: 'OTHER THING',
            lineCount: 1,
            receiptCount: 1,
            spendMinor: 250,
          }),
        ],
        lineCount: 4,
        spendMinor: 999,
      }),
    );

    expect(body).toContain('MYSTERY ITEM');
    expect(body).toContain('3 lines');
    expect(body).toContain('across 2 receipts');
    expect(body).toMatch(/7\.49/u);
    expect(body).toContain('OTHER THING');
    expect(body).toContain('1 line');
  });

  it('totals the unidentified spending at the top', () => {
    const body = renderUnknowns(overview());

    expect(body).toContain('class="unknown-total"');
    expect(body).toMatch(/3 lines across 1 wording [^<]*7\.49 unidentified\./u);
  });

  it('says there is nothing to recategorize when no wording is left', () => {
    const body = renderUnknowns(
      overview({ groups: [], lineCount: 0, spendMinor: 0 }),
    );

    expect(body).toContain('No unidentified spending');
    expect(body.match(/No unidentified spending/gu)).toHaveLength(1);
    expect(body).not.toContain('unknown-group');
  });

  it('names a group with no printed text without inventing a wording', () => {
    const body = renderUnknowns(
      overview({
        groups: [group({ normalizedText: '', printedText: '' })],
      }),
      {
        catalogItems: [
          { id: '00000000-0000-4000-8000-0000000000aa', name: 'Milk' },
        ],
        pending: { '': '00000000-0000-4000-8000-0000000000aa' },
      },
    );

    expect(body).toContain('(no printed text)');
    expect(body).toContain(
      'The lines have no printed wording, so matching learns nothing.',
    );
    expect(body).not.toContain('Matching will learn');
  });

  it('does not say “across 2 receipts” for a single receipt', () => {
    const body = renderUnknowns(
      overview({ groups: [group({ receiptCount: 1 })] }),
    );

    expect(body).not.toContain('across 1 receipt');
  });
});

describe('ReceiptUnknowns — binding a whole wording', () => {
  it('offers a search per group and no binding control when read-only', () => {
    const writable = renderUnknowns(overview());
    expect(writable).toContain('Find item for MYSTERY ITEM');

    const readOnly = renderUnknowns(overview(), { writable: false });
    expect(readOnly).not.toContain('Find item for MYSTERY ITEM');
    expect(readOnly).toContain('MYSTERY ITEM');
  });

  it('asks before moving every line, and says what matching learns', () => {
    const body = renderUnknowns(overview(), {
      catalogItems: [
        { id: '00000000-0000-4000-8000-0000000000aa', name: 'Milk' },
      ],
      pending: { 'mystery item': '00000000-0000-4000-8000-0000000000aa' },
    });

    expect(body).toContain(
      'Bind 3 lines to Milk? Matching will learn "MYSTERY ITEM" for Milk.',
    );
    expect(body).toContain('Bind 3 lines');
    expect(body).toContain('Cancel');
    // The search is replaced by the confirm, so the same group cannot be
    // chosen twice while the question stands.
    expect(body).not.toContain('Find item for MYSTERY ITEM');
  });

  it('disables the confirm while the bind is in flight', () => {
    const body = renderUnknowns(overview(), {
      catalogItems: [
        { id: '00000000-0000-4000-8000-0000000000aa', name: 'Milk' },
      ],
      pending: { 'mystery item': '00000000-0000-4000-8000-0000000000aa' },
      busyGroup: 'mystery item',
    });

    expect(body).toMatch(/disabled[^>]*>Bind 3 lines/u);
  });

  it('reports a refusal and a finished bind in the surface itself', () => {
    const failed = renderUnknowns(overview(), {
      error: 'That item is no longer in this list.',
    });
    expect(failed).toContain('That item is no longer in this list.');
    expect(failed).toContain('role="alert"');

    const done = renderUnknowns(overview(), {
      notice: 'Bound 3 lines to Milk.',
    });
    expect(done).toContain('Bound 3 lines to Milk.');
    expect(done).toContain('role="status"');
  });
});
