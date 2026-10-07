// Explicit columns only; the private reporting snapshot is never exposed via REST.
export const ANALYTICS_QUERIES = Object.freeze({
  config: "SELECT name, timezone, currency, settings, logo_url FROM sar_bms.analytics_config WHERE customer_id = 'vanguard'",
  metricDefs: "SELECT id, key, canonical_key, display_name, display_order, metric_type, data_type, aggregation, is_computed, formula, is_active FROM sar_bms.analytics_metric_definitions WHERE customer_id = 'vanguard' AND is_active ORDER BY display_order, id",
  categories: "SELECT id, key, display_name, display_order, color_bg_from, color_bg_to, color_border, color_text, color_text_dark, show_rpa, show_margin FROM sar_bms.analytics_product_categories WHERE customer_id = 'vanguard' AND is_active ORDER BY display_order, id",
  categoryMetrics: "SELECT category_id, metric_key, role FROM sar_bms.analytics_product_category_metrics WHERE category_id IN (SELECT id FROM sar_bms.analytics_product_categories WHERE customer_id = 'vanguard') ORDER BY id",
  locations: "SELECT id, name, code, settings FROM sar_bms.locations WHERE customer_id = 'vanguard' ORDER BY name, id",
  events: "SELECT id, customer_id, location_id, event_date, event_type, day_of_week, attendance, notes, metadata, created_at, updated_at FROM sar_bms.analytics_events WHERE customer_id = 'vanguard' ORDER BY event_date DESC, id",
  metricRows: "SELECT event_id, metric_id, value FROM sar_bms.analytics_event_data WHERE event_id IN (SELECT id FROM sar_bms.analytics_events WHERE customer_id = 'vanguard') ORDER BY id",
  runners: "SELECT id, name, is_active, staff_id FROM sar_bms.flash_runners WHERE customer_id = 'vanguard' AND is_active ORDER BY name, id",
  runnerEvents: "SELECT id, runner_id, event_id, location_id, event_date, event_type, is_flash_desk, tickets_checked_out, tickets_sold, tickets_returned, tickets_unsold, cash_returned, credit_cards, revenue, restock_count FROM sar_bms.flash_runner_events WHERE customer_id = 'vanguard' AND runner_id IN (SELECT id FROM sar_bms.flash_runners WHERE customer_id = 'vanguard' AND is_active) ORDER BY event_date DESC, id",
  promotions: "SELECT id, code, name, description, promo_type, discount_type, discount_value, valid_from, valid_to, max_uses, current_uses, is_active FROM sar_bms.promotions WHERE customer_id = 'vanguard' ORDER BY id",
  monthlySummary: "SELECT location_id, month, event_count, total_sales, net_sales, total_attendance FROM sar_bms.analytics_monthly_summary WHERE customer_id = 'vanguard' ORDER BY location_id, month",
  notifications: "SELECT id, event_type, severity, title, body, entity_type, entity_id, created_at FROM sar_bms.notifications WHERE customer_id = 'vanguard' AND user_id IS NULL ORDER BY created_at DESC, id LIMIT 500",
});

export async function readAnalytics(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query("SELECT verified_at FROM sar_bms.import_manifest WHERE customer_id = 'vanguard' AND status = 'verified' ORDER BY verified_at DESC LIMIT 1");
    if (!rows[0]?.verified_at) throw Error('No verified snapshot');
    const data = { snapshotAt: rows[0].verified_at };
    for (const [key, sql] of Object.entries(ANALYTICS_QUERIES)) data[key] = (await client.query(sql)).rows;
    await client.query('COMMIT');
    return data;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
