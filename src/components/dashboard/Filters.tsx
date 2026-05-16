import * as React from "react";
import { format, subDays, startOfMonth } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface StoreOption {
  code: string;
  flag: string;
  name: string;
}

export function StoreSelect({
  value,
  onChange,
  options,
  label = "Store",
}: {
  value: string;
  onChange: (v: string) => void;
  options: StoreOption[];
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground hidden sm:inline">{label}:</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-[180px]">
          <SelectValue placeholder="Select store" />
        </SelectTrigger>
        <SelectContent>
          {options.map((s) => (
            <SelectItem key={s.code} value={s.code}>
              <span className="mr-2">{s.flag}</span>
              {s.name} ({s.code})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const PRESETS: { label: string; getValue: () => DateRange }[] = [
  { label: "Today", getValue: () => ({ from: new Date(), to: new Date() }) },
  { label: "Last 7 days", getValue: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: "Last 30 days", getValue: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  { label: "This month", getValue: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
  { label: "Last 90 days", getValue: () => ({ from: subDays(new Date(), 89), to: new Date() }) },
];

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (v: DateRange) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const display =
    value.from && value.to
      ? `${format(value.from, "MMM d")} – ${format(value.to, "MMM d, yyyy")}`
      : "Pick a range";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-9 justify-start text-left font-normal", !value && "text-muted-foreground")}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {display}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 flex" align="end">
        <div className="flex flex-col border-r p-2 space-y-1 min-w-[140px]">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="text-left text-sm rounded px-2 py-1 hover:bg-accent"
              onClick={() => {
                onChange(p.getValue());
                setOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Calendar
          mode="range"
          defaultMonth={value.from}
          selected={value}
          onSelect={(range) => {
            if (range?.from && range?.to) {
              onChange(range);
              setOpen(false);
            } else if (range) {
              onChange(range);
            }
          }}
          numberOfMonths={2}
          className={cn("p-3 pointer-events-auto")}
        />
      </PopoverContent>
    </Popover>
  );
}

export function toIsoDate(d: Date | undefined): string {
  if (!d) return new Date().toISOString().split("T")[0];
  // Use local date to avoid TZ shift
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function defaultRange(): DateRange {
  // Last 90 days — wide enough that data sources with sparse recent activity
  // (e.g. Jortt monthly invoices) still show something on first visit.
  return { from: subDays(new Date(), 89), to: new Date() };
}
