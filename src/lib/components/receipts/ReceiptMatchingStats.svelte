<script lang="ts">
  import {
    MATCHING_STATS_EMPTY,
    matchingRankLabel,
    matchingReconciliation,
    matchingSharePercent,
    matchingSourceLabel,
    matchingSourceShare,
    matchingStatsHeadline,
    suggestedRankSummary,
    unrankedSuggestedNote,
  } from '../../client/receipt-matching-stats';
  import {
    RECEIPT_BOUND_VIA_VALUES,
    type MatchingStats,
  } from '../../shared/schemas';

  // Suggestion telemetry (ticket 18; plan §13 "R2 — matching maturity"): the
  // read-only evidence base for later scoring or embedding work. The share of
  // committed item lines by how they found an item, and the ranks reviewers
  // accepted when they took a suggestion. The no-binding residual is shown
  // beside the four `bound_via` buckets so the view reconciles with the
  // committed lines it describes; a line marked unknown or skipped committed as
  // an observation, not a binding. Nothing here writes, so nothing here needs a
  // writable gate.
  let { stats }: { stats: MatchingStats } = $props();
</script>

<section class="matching-stats" aria-label="Matching stats">
  <p class="stats-intro">
    How committed item lines found their items. Read-only evidence for later
    matching work — the counts are exact; the shares are rounded.
  </p>

  {#if stats.committedReceiptCount === 0}
    <p class="stats-empty">{MATCHING_STATS_EMPTY}</p>
  {:else}
    <p class="stats-headline">{matchingStatsHeadline(stats)}</p>

    <h3 class="stats-section-heading">Line provenance</h3>
    <ul class="stats-sources">
      {#each RECEIPT_BOUND_VIA_VALUES as source (source)}
        {@const share = matchingSourceShare(stats, source)}
        <li class="stats-source" data-source={source}>
          <span class="stats-source-label">{matchingSourceLabel(source)}</span>
          <span class="stats-source-count">{share.count}</span>
          <span class="stats-source-share">{share.percent}%</span>
          <span class="stats-bar" aria-hidden="true">
            <span class="stats-bar-fill" style:width={`${share.percent}%`}
            ></span>
          </span>
        </li>
      {/each}
      {#if stats.noBindingLineCount > 0}
        {@const noBindingShare = matchingSharePercent(
          stats.noBindingLineCount,
          stats.lineCount,
        )}
        <li class="stats-source stats-no-binding" data-source="no-binding">
          <span class="stats-source-label">Unknown or skipped</span>
          <span class="stats-source-count">{stats.noBindingLineCount}</span>
          <span class="stats-source-share">{noBindingShare}%</span>
          <span class="stats-bar" aria-hidden="true">
            <span class="stats-bar-fill" style:width={`${noBindingShare}%`}
            ></span>
          </span>
        </li>
      {/if}
    </ul>
    <p class="stats-reconciliation">{matchingReconciliation(stats)}</p>

    <h3 class="stats-section-heading">Accepted suggestions by rank</h3>
    <p class="stats-rank-summary">{suggestedRankSummary(stats)}</p>
    {#if stats.suggested.ranks.length}
      <ul class="stats-ranks">
        {#each stats.suggested.ranks as rank (rank.rank)}
          {@const percent = matchingSharePercent(
            rank.lineCount,
            stats.suggested.lineCount,
          )}
          <li class="stats-rank" data-rank={rank.rank}>
            <span class="stats-rank-label">{matchingRankLabel(rank.rank)}</span>
            <span class="stats-rank-count">{rank.lineCount}</span>
            <span class="stats-rank-share">{percent}%</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if unrankedSuggestedNote(stats)}
      <p class="stats-unranked">{unrankedSuggestedNote(stats)}</p>
    {/if}
  {/if}
</section>

<style>
  .matching-stats {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .stats-intro {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .stats-headline {
    margin: 0;
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-inset);
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
  }

  .stats-empty {
    margin: 0;
    padding: 0.85rem 0.75rem;
    border: 1px dashed var(--line);
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .stats-section-heading {
    margin: 0.15rem 0 0;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .stats-sources,
  .stats-ranks {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .stats-source {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: baseline;
    gap: 0.55rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  .stats-source-label {
    overflow-wrap: anywhere;
    font-size: 0.85rem;
  }

  .stats-source-count,
  .stats-rank-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .stats-source-share,
  .stats-rank-share {
    min-width: 2.6rem;
    color: var(--text-muted);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .stats-bar {
    grid-column: 1 / -1;
    height: 0.3rem;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-inset);
  }

  .stats-bar-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }

  .stats-no-binding .stats-bar-fill {
    background: var(--line-bright);
  }

  .stats-reconciliation {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }

  .stats-rank-summary {
    margin: 0;
    font-size: 0.85rem;
  }

  .stats-rank {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: baseline;
    gap: 0.55rem;
    padding: 0.35rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  .stats-rank-label {
    font-size: 0.85rem;
  }

  .stats-unranked {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.78rem;
  }
</style>
