export interface DateRangeValue {
  from: string;
  to: string;
}

const visibleDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function parseIsoCalendarDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);

  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return undefined;
  }

  return date;
}

export function formatIsoCalendarDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function formatDateRangeLabel(value: DateRangeValue): string {
  const from = parseIsoCalendarDate(value.from);
  const to = parseIsoCalendarDate(value.to);

  if (from === undefined && to === undefined) {
    return "Any date";
  }
  if (from !== undefined && to === undefined) {
    return `From ${visibleDateFormatter.format(from)}`;
  }
  if (from === undefined && to !== undefined) {
    return `Through ${visibleDateFormatter.format(to)}`;
  }
  if (from !== undefined && to !== undefined && isSameCalendarDate(from, to)) {
    return visibleDateFormatter.format(from);
  }

  return `${visibleDateFormatter.format(from)} – ${visibleDateFormatter.format(to)}`;
}

function isSameCalendarDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
