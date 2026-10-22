<script lang="ts">
  // The R4 offer (plan §6): a parse the first pass struggled with, in review,
  // with the optional helper configured. The component only renders the state;
  // the editor owns whether the offer applies and what each tap does. The
  // replacement is a two-tap act because it discards any line decisions since
  // the last save — the photo and the raw OCR text are kept, and the confirm
  // says exactly that.
  let {
    reasons,
    confirming = false,
    busy = false,
    applying = false,
    onArm,
    onCancel,
    onConfirm,
  }: {
    reasons: string[];
    confirming?: boolean;
    busy?: boolean;
    applying?: boolean;
    onArm: () => void;
    onCancel: () => void;
    onConfirm: () => void;
  } = $props();
</script>

<section class="helper-reparse" aria-labelledby="helper-reparse-heading">
  <h3 id="helper-reparse-heading" class="helper-heading">
    This receipt was hard to read
  </h3>
  <ul class="helper-reasons">
    {#each reasons as reason}
      <li>{reason}</li>
    {/each}
  </ul>

  {#if confirming}
    <p class="helper-confirm" role="status">
      Re-parse with the helper? The parsed lines below are replaced with the
      helper's reading. The photo and the raw OCR text are kept.
    </p>
    <div class="helper-actions">
      <button
        type="button"
        class="confirm-reparse-button"
        disabled={busy}
        onclick={onConfirm}
      >
        {applying ? 'Re-parsing…' : 'Replace the lines'}
      </button>
      <button
        type="button"
        class="cancel-reparse-button"
        disabled={busy}
        onclick={onCancel}
      >
        Cancel
      </button>
    </div>
  {:else}
    <button
      type="button"
      class="reparse-button"
      disabled={busy}
      onclick={onArm}
    >
      Re-parse with helper
    </button>
  {/if}
</section>

<style>
  .helper-reparse {
    margin: 0 0 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--line-bright);
    border-left: 3px solid var(--accent);
    border-radius: 12px;
    background: var(--surface-inset);
  }

  .helper-heading {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }

  .helper-reasons {
    margin: 0 0 0.7rem;
    padding-left: 1.1rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .helper-confirm {
    margin: 0 0 0.7rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .helper-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .reparse-button,
  .confirm-reparse-button,
  .cancel-reparse-button {
    min-height: 2.4rem;
    padding: 0.5rem 0.8rem;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--text);
    background: transparent;
    font-family: var(--font-display);
    font-size: 0.82rem;
    font-weight: 650;
    letter-spacing: 0.015em;
    text-transform: uppercase;
  }

  .confirm-reparse-button {
    border-color: var(--accent);
    color: var(--accent);
  }

  .reparse-button:disabled,
  .confirm-reparse-button:disabled,
  .cancel-reparse-button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }
</style>
