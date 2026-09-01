import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { widgetEvents, widgetEventType } from '../../src/schema/widget-events.js';

/**
 * Shape assertions for `widget_events` (P0-29).
 */

const config = getTableConfig(widgetEvents);
const columns = new Map(config.columns.map((column) => [column.name, column]));

describe('widget_events schema', () => {
  it('declares the seven funnel events from §Data Model', () => {
    // The set every §2.4 panel is computed from. Adding one is ALTER TYPE ...
    // ADD VALUE; the panels are written against these names.
    expect(widgetEventType.enumValues).toEqual([
      'WIDGET_OPEN',
      'MESSAGE_SENT',
      'RECOMMENDATION_SHOWN',
      'PRODUCT_DETAIL_VIEW',
      'ADD_TO_CART',
      'CART_OPEN',
      'ZERO_RESULTS',
    ]);
  });

  it('lets an event exist before any conversation does', () => {
    // WIDGET_OPEN is the first thing that happens and precedes a conversation.
    expect(columns.get('conversation_id')?.notNull).toBe(false);
  });

  it('never loses an event to a deleted conversation or product', () => {
    /*
     * `set null`, not `cascade`, on both.
     *
     * The retention purge (P7-07) deletes old conversations, and products get
     * archived and deleted routinely. With cascade, every historical conversion
     * rate changes retroactively as data ages out — analytics that silently
     * shrink are analytics nobody can reason about.
     */
    const byTarget = new Map(
      config.foreignKeys.map((fk) => [getTableConfig(fk.reference().foreignTable).name, fk]),
    );

    expect(byTarget.get('conversations')?.onDelete).toBe('set null');
    expect(byTarget.get('products')?.onDelete).toBe('set null');
    // The tenant is the exception: deleting a tenant does delete its data.
    expect(byTarget.get('tenants')?.onDelete).toBe('cascade');
  });

  it('keeps session_id even though conversation_id can go null', () => {
    // What makes a funnel reconstructable after the conversation is purged.
    expect(columns.get('session_id')?.notNull).toBe(true);
  });

  it('stores metadata as jsonb', () => {
    // Queried, not just retrieved: json keeps the raw text and cannot be
    // indexed usefully.
    expect(columns.get('metadata')?.getSQLType()).toBe('jsonb');
  });

  it('indexes the question every analytics panel asks', () => {
    expect(config.indexes.map((i) => i.config.name)).toContain(
      'widget_events_tenant_type_created_idx',
    );
  });
});
