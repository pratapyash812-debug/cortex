import type { BaseFilter, BaseFilters, BasePrefs, BaseProperty, BaseRow, PropValue } from '../api';
import { display, isEmpty } from './PropertyInput';

export const NO_VALUE = '';
export const TITLE: BaseProperty = { key: 'title', type: 'text' };

/** What a column shows for a row: a formula or rollup result, a relation's note names, or the property itself. */
export function getValue(row: BaseRow, key: string): PropValue {
  if (key === 'title') return row.title;
  if (key === 'folder') return row.folder;
  const links = row.links?.[key];
  if (links) return links.map(l => l.label);
  if (row.computed && key in row.computed) return row.computed[key];
  return row.props[key];
}

function matches(row: BaseRow, f: BaseFilter): boolean {
  const v = getValue(row, f.key);
  const needle = f.value.trim().toLowerCase();
  switch (f.op) {
    case 'empty': return isEmpty(v);
    case 'notempty': return !isEmpty(v);
    case 'checked': return v === true;
    case 'unchecked': return v !== true;
    case 'equals': return Array.isArray(v) ? v.some(x => String(x).toLowerCase() === needle) : display(v).toLowerCase() === needle;
    case 'contains': return display(v).toLowerCase().includes(needle);
  }
}

/** All filters (mode "and") or any of them (mode "or"). No filters keeps every row. */
export function matchesFilters(row: BaseRow, filters?: BaseFilters): boolean {
  const items = filters?.items ?? [];
  if (!items.length) return true;
  return filters?.mode === 'or' ? items.some(f => matches(row, f)) : items.every(f => matches(row, f));
}

/** Ascending order by what the values are: numbers by size, everything else by text with numbers inside it in order. */
export function compareValues(x: PropValue, y: PropValue): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  return display(x).localeCompare(display(y), undefined, { numeric: true, sensitivity: 'base' });
}

export interface Slice { label: string; count: number }
export const OTHER = 'Other';
const MAX_SLICES = 12;

function chartLabels(v: PropValue, type: string): string[] {
  if (isEmpty(v)) return ['(none)'];
  if (type === 'checkbox' || typeof v === 'boolean') return [v === true ? 'Yes' : 'No'];
  if (Array.isArray(v)) return v.map(String);
  if (type === 'date') return [display(v).slice(0, 7)]; // dates are counted per month
  return [display(v)];
}

/** Notes counted by a property, largest first; a note with several values (a list or relation) counts once under each. */
export function countBy(rows: BaseRow[], key: string, type: string): Slice[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const label of new Set(chartLabels(getValue(r, key), type))) counts.set(label, (counts.get(label) ?? 0) + 1);
  const all = [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (all.length <= MAX_SLICES) return all;
  const rest = all.slice(MAX_SLICES - 1);
  return [...all.slice(0, MAX_SLICES - 1), { label: OTHER, count: rest.reduce((n, s) => n + s.count, 0) }];
}

// ---- timeline -------------------------------------------------------------------------------------------

export const DAY_MS = 864e5;
export const NO_GROUP = '(none)';

/** Whole days since 1970-01-01 for a date or date-time value ("2026-10-26", "2026-10-26 09:30"); null when it is neither. */
export function dayNumber(v: PropValue): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(display(v).trim());
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : Math.floor(t / DAY_MS);
}

export const dayToIso = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** A note's bar: it covers the days from `start` to `end`, both included. */
export interface TimelineBar { row: BaseRow; start: number; end: number; /** The end date was missing or before the start. */ noEnd: boolean }
export interface TimelineGroup { label: string; bars: TimelineBar[] }
export interface Timeline { groups: TimelineGroup[]; first: number; last: number; undated: number; bars: number }

/**
 * Notes as bars from a start date property to an end date property, in groups by an optional property.
 * A note without a start date is counted but not drawn. Without a usable end date (none, or earlier than the start)
 * the bar is the start day alone. A note with several values in the grouping property appears in each group.
 */
export function buildTimeline(rows: BaseRow[], startKey: string, endKey: string, groupKey: string): Timeline {
  const byGroup = new Map<string, TimelineBar[]>();
  let undated = 0, first = Infinity, last = -Infinity, bars = 0;
  for (const row of rows) {
    const start = dayNumber(getValue(row, startKey));
    if (start === null) { undated++; continue; }
    const rawEnd = endKey ? dayNumber(getValue(row, endKey)) : null;
    const noEnd = rawEnd === null || rawEnd < start;
    const bar: TimelineBar = { row, start, end: noEnd ? start : rawEnd, noEnd };
    first = Math.min(first, bar.start);
    last = Math.max(last, bar.end);
    bars++;
    const v = groupKey ? getValue(row, groupKey) : null;
    const labels = !groupKey ? [''] : isEmpty(v) ? [NO_GROUP] : Array.isArray(v) ? [...new Set(v.map(String))] : [display(v)];
    for (const label of labels) byGroup.set(label, [...(byGroup.get(label) ?? []), bar]);
  }
  const groups = [...byGroup].map(([label, list]) => ({ label, bars: list.sort((a, b) => a.start - b.start || a.end - b.end || a.row.title.localeCompare(b.row.title)) }))
    .sort((a, b) => (a.label === NO_GROUP ? 1 : b.label === NO_GROUP ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true })));
  return { groups, first: bars ? first : 0, last: bars ? last : 0, undated, bars };
}


// ---- which properties a view draws -------------------------------------------------------------------------

const START_NAME = /start|begin|from|open/i, END_NAME = /end|due|finish|deadline|until|close|to$/i;

/** The properties a board, calendar, timeline or chart uses, and the properties each of them may choose from. */
export interface ViewSettings {
  groupBy: string | undefined; dateBy: string | undefined; chartBy: string; chartKind: 'bar' | 'donut';
  startBy: string | undefined; endBy: string; timelineBy: string;
  groupable: BaseProperty[]; dateProps: BaseProperty[]; chartable: BaseProperty[];
}

/** What each view draws: the property saved for it, else a likely one (a "status" to group by, a date named start or end, ...). */
export function viewSettings(properties: BaseProperty[], prefs: Pick<BasePrefs, 'groupBy' | 'dateBy' | 'chartBy' | 'chartKind' | 'startBy' | 'endBy' | 'timelineBy'>): ViewSettings {
  const groupable = properties.filter(p => p.type === 'text' || p.type === 'list');
  const dateProps = properties.filter(p => p.type === 'date');
  const chartable: BaseProperty[] = [{ key: 'folder', type: 'text' }, ...properties];
  const startBy = (dateProps.find(p => p.key === prefs.startBy) ?? dateProps.find(p => START_NAME.test(p.key)) ?? dateProps[0])?.key;
  return {
    groupable, dateProps, chartable, startBy,
    groupBy: groupable.find(p => p.key === prefs.groupBy)?.key ?? (groupable.find(p => p.key === 'status') ?? groupable[0])?.key,
    dateBy: dateProps.find(p => p.key === prefs.dateBy)?.key ?? dateProps[0]?.key,
    chartBy: (chartable.find(p => p.key === prefs.chartBy) ?? chartable.find(p => p.key === 'status') ?? chartable.find(p => p.type === 'text' || p.type === 'list' || p.type === 'relation') ?? chartable[0]).key,
    chartKind: prefs.chartKind ?? 'bar',
    // Timeline: the start and end dates are the properties saved for this view, else ones named like start/end, else the first dates.
    endBy: prefs.endBy === '' ? '' : (dateProps.find(p => p.key === prefs.endBy && p.key !== startBy) ?? dateProps.find(p => p.key !== startBy && END_NAME.test(p.key)) ?? dateProps.find(p => p.key !== startBy))?.key ?? '',
    timelineBy: groupable.find(p => p.key === prefs.timelineBy)?.key ?? '',
  };
}
