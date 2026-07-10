import * as Popover from "@radix-ui/react-popover";
import {
  DayPicker,
  type ChevronProps,
  type DateRange as CalendarDateRange,
  type SelectProps,
} from "@daypicker/react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

import "@daypicker/react/style.css";
import "./date-range-picker.css";

import { Button } from "./button";
import {
  type DateRangeValue,
  formatDateRangeLabel,
  formatIsoCalendarDate,
  parseIsoCalendarDate,
} from "./date-range";
import { cn } from "../../lib/cn";

interface DateRangePickerProps {
  label?: string;
  onChange: (value: DateRangeValue) => void;
  value: DateRangeValue;
}

const emptyDateRange: DateRangeValue = { from: "", to: "" };
const calendarStartMonth = new Date(2007, 0, 1);
const spokenDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function DateRangePicker({
  label = "Date range",
  onChange,
  value,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftRange, setDraftRange] = useState<CalendarDateRange | undefined>(
    () => calendarRangeFromValue(value),
  );
  const labelId = useId();
  const valueId = useId();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const selectedRange = useMemo(() => calendarRangeFromValue(value), [value]);
  const currentYear = new Date().getFullYear();
  const calendarEndMonth = useMemo(
    () => new Date(currentYear, 11, 1),
    [currentYear],
  );
  const calendarEndDate = useMemo(
    () => new Date(currentYear, 11, 31),
    [currentYear],
  );
  const triggerLabel = formatDateRangeLabel(value);
  const draftStatus = formatCalendarRangeStatus(draftRange);
  const initialMonth = draftRange?.from ?? selectedRange?.from ?? new Date();
  const canApply =
    draftRange === undefined ||
    (draftRange.from !== undefined && draftRange.to !== undefined);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraftRange(selectedRange);
    }
    setOpen(nextOpen);
  };

  const handleApply = () => {
    onChange(dateRangeValueFromCalendarRange(draftRange));
    setOpen(false);
  };

  return (
    <div className="min-w-0">
      <span className="text-caption text-text-secondary" id={labelId}>
        {label}
      </span>
      <div className="mt-1 flex min-w-0 gap-1">
        <Popover.Root modal onOpenChange={handleOpenChange} open={open}>
          <Popover.Trigger asChild>
            <Button
              aria-labelledby={`${labelId} ${valueId}`}
              className="min-w-0 flex-1 justify-start bg-surface-sunken px-2 font-[var(--font-weight-regular)]"
              data-testid="date-range-trigger"
              type="button"
              variant="secondary"
            >
              <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate text-left" id={valueId}>
                {triggerLabel}
              </span>
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
            </Button>
          </Popover.Trigger>

          <Popover.Portal>
            <Popover.Content
              align="end"
              aria-describedby={dialogDescriptionId}
              aria-labelledby={dialogTitleId}
              className="golemine-date-popover z-50 max-w-[calc(100vw_-_var(--space-32))] rounded-lg border border-border bg-surface-raised p-4 text-text shadow-2 data-[side=bottom]:mt-2 data-[side=left]:mr-2 data-[side=right]:ml-2 data-[side=top]:mb-2"
            >
              <div className="mb-3">
                <h2 className="text-heading" id={dialogTitleId}>
                  Choose a date range
                </h2>
                <p className="mt-1 text-caption text-text-secondary" id={dialogDescriptionId}>
                  Select a start date and an end date. Select the same day twice for a single date.
                </p>
              </div>

              <DayPicker
                autoFocus
                captionLayout="dropdown"
                className="golemine-date-calendar"
                components={{ Chevron: CalendarChevron, Select: CalendarSelect }}
                defaultMonth={initialMonth}
                disabled={{
                  after: calendarEndDate,
                  before: calendarStartMonth,
                }}
                endMonth={calendarEndMonth}
                fixedWeeks
                footer={draftStatus}
                mode="range"
                navLayout="after"
                numberOfMonths={2}
                onSelect={setDraftRange}
                pagedNavigation
                resetOnSelect
                reverseYears
                selected={draftRange}
                showOutsideDays
                startMonth={calendarStartMonth}
              />

              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <Button
                  disabled={draftRange === undefined}
                  onClick={() => {
                    setDraftRange(undefined);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear selection
                </Button>
                <div className="flex items-center gap-2">
                  <Popover.Close asChild>
                    <Button size="sm" type="button" variant="secondary">
                      Cancel
                    </Button>
                  </Popover.Close>
                  <Button
                    disabled={!canApply}
                    onClick={handleApply}
                    size="sm"
                    type="button"
                    variant="primary"
                  >
                    Apply dates
                  </Button>
                </div>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        {hasDateRangeValue(value) ? (
          <Button
            className="shrink-0 px-2"
            onClick={() => {
              onChange(emptyDateRange);
            }}
            type="button"
            variant="ghost"
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function calendarRangeFromValue(value: DateRangeValue): CalendarDateRange | undefined {
  const from = parseIsoCalendarDate(value.from);
  const to = parseIsoCalendarDate(value.to);

  if (from === undefined) {
    return to === undefined ? undefined : { from: to, to };
  }

  return { from, to };
}

function dateRangeValueFromCalendarRange(
  range: CalendarDateRange | undefined,
): DateRangeValue {
  if (range?.from === undefined || range.to === undefined) {
    return emptyDateRange;
  }

  return {
    from: formatIsoCalendarDate(range.from),
    to: formatIsoCalendarDate(range.to),
  };
}

function formatCalendarRangeStatus(range: CalendarDateRange | undefined): string {
  if (range?.from === undefined) {
    return "Select a start date.";
  }
  if (range.to === undefined) {
    return `Start date: ${spokenDateFormatter.format(range.from)}. Select an end date.`;
  }
  if (isSameCalendarDate(range.from, range.to)) {
    return `Selected: ${spokenDateFormatter.format(range.from)}.`;
  }

  return `Selected: ${spokenDateFormatter.format(range.from)} through ${spokenDateFormatter.format(range.to)}.`;
}

function hasDateRangeValue(value: DateRangeValue): boolean {
  return value.from.length > 0 || value.to.length > 0;
}

function isSameCalendarDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function CalendarChevron({ className, orientation }: ChevronProps) {
  const Icon =
    orientation === "right"
      ? ChevronRight
      : orientation === "up"
        ? ChevronUp
        : orientation === "down"
          ? ChevronDown
          : ChevronLeft;

  return <Icon aria-hidden="true" className={cn("size-4", className)} />;
}

function CalendarSelect(props: SelectProps) {
  return <select {...props} data-date-picker-dropdown="" />;
}
