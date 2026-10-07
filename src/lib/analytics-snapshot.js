/** Preserve integer cents and the existing screen contract. */
export function mapSnapshot(raw, since = null) {
  const events = raw.events.filter(e => !since || e.event_date >= since);
  const ids = new Set(events.map(e => e.id));
  const metrics = {};
  for (const r of raw.metricRows) {
    if (ids.has(r.event_id)) (metrics[r.event_id] ||= {})[r.metric_id] = r.value;
  }
  const links = raw.categoryMetrics;
  return {
    config: raw.config[0] ?? null, metricDefs: raw.metricDefs, locations: raw.locations,
    categories: raw.categories.map(c => ({ ...c,
      revenue_keys: links.filter(l => l.category_id === c.id && l.role === 'revenue').map(l => l.metric_key),
      payout_keys: links.filter(l => l.category_id === c.id && l.role === 'payout').map(l => l.metric_key),
    })),
    events, metrics, runners: raw.runners, runnerEvents: raw.runnerEvents, snapshotAt: raw.snapshotAt,
  };
}
