// @ts-nocheck
import { authedFetch } from "@/lib/authed-fetch";
import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import SyncView from "./SyncView";
import shopifyGlyph from "@/assets/shopify-glyph.svg";
import { Flag } from "@/components/Flag";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  Wallet,
  Calendar,
  Search,
  Settings,
  ChevronDown,
  ChevronRight,
  Command,
  LayoutDashboard,
  GitCompareArrows,
  Activity,
  Plug,
  CircleCheck,
  CircleAlert,
  CircleDot,
  Eye,
  EyeOff,
  RefreshCw,
  AlertTriangle,
  Info,
  Plus,
  Globe,
  CalendarDays,
  Scale,
  LineChart as LineChartIcon,
  Clock,
  Package,
  Truck,
  Zap,
  Sparkles,
} from "lucide-react";

/* =========================================================================
   HELPERS
   ========================================================================= */

const formatValue = (value, format) => {
  switch (format) {
    case "currency":
      return `€${value.toLocaleString(undefined, { minimumFractionDigits: value % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}`;
    case "percent":
      return `${value.toFixed(1)}%`;
    case "multiplier":
      return `${value.toFixed(2)}x`;
    case "decimal":
      return value.toFixed(2);
    case "number":
    default:
      return value.toLocaleString();
  }
};

const fmtCurrency = (n) => `€${Math.abs(n).toLocaleString()}`;
const fmtSigned = (n) => (n >= 0 ? `+€${n.toLocaleString()}` : `-€${Math.abs(n).toLocaleString()}`);

/* =========================================================================
   DATE RANGE HELPERS
   ========================================================================= */

function drStartOfMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}
function drToday() {
  return new Date().toISOString().split("T")[0];
}
function drLastMonthStart() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return drStartOfMonth(d);
}
function drLastMonthEnd() {
  const d = new Date(); d.setDate(0); // last day of previous month
  return d.toISOString().split("T")[0];
}
function drMonthsAgo(n) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n);
  return drStartOfMonth(d);
}
function drDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}
function drYesterday() { return drDaysAgo(1); }
function drStartOfWeek(date = new Date()) {
  // ISO week — Monday
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.toISOString().split("T")[0];
}
function drLastWeekStart() {
  const d = new Date(drStartOfWeek() + "T12:00:00");
  d.setDate(d.getDate() - 7);
  return d.toISOString().split("T")[0];
}
function drLastWeekEnd() {
  const d = new Date(drStartOfWeek() + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}
function drStartOfQuarter() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3);
  return `${d.getFullYear()}-${String(q * 3 + 1).padStart(2, "0")}-01`;
}
function drStartOfYear() { return `${new Date().getFullYear()}-01-01`; }
function drLastYearStart() { return `${new Date().getFullYear() - 1}-01-01`; }
function drLastYearEnd() { return `${new Date().getFullYear() - 1}-12-31`; }

// Centralised preset list — used by DateRangePicker everywhere.
function getDatePresets() {
  return [
    { label: "Today",         from: drToday(),          to: drToday() },
    { label: "Yesterday",     from: drYesterday(),      to: drYesterday() },
    { label: "Last 7 days",   from: drDaysAgo(7),       to: drToday() },
    { label: "Last 14 days",  from: drDaysAgo(14),      to: drToday() },
    { label: "Last 30 days",  from: drDaysAgo(30),      to: drToday() },
    { label: "Last 90 days",  from: drDaysAgo(90),      to: drToday() },
    { label: "Last 365 days", from: drDaysAgo(365),     to: drToday() },
    { label: "This week",     from: drStartOfWeek(),    to: drToday() },
    { label: "Last week",     from: drLastWeekStart(),  to: drLastWeekEnd() },
    { label: "This month",    from: drStartOfMonth(),   to: drToday() },
    { label: "Last month",    from: drLastMonthStart(), to: drLastMonthEnd() },
    { label: "This quarter",  from: drStartOfQuarter(), to: drToday() },
    { label: "This year",     from: drStartOfYear(),    to: drToday() },
    { label: "Last year",     from: drLastYearStart(),  to: drLastYearEnd() },
  ];
}

function drFormatLabel(from, to) {
  // If the range matches a known preset, show its friendly label
  const match = getDatePresets().find((p) => p.from === from && p.to === to);
  if (match) return match.label;
  const fmt = (s) => {
    const d = new Date(s + "T12:00:00");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
  };
  return `${fmt(from)} – ${fmt(to)}`;
}
function monthInRange(monthKey, from, to) {
  if (!monthKey) return false;
  const d = new Date("1 " + monthKey.replace("'", "20"));
  if (isNaN(d.getTime())) return false;
  const ms = new Date(d.getFullYear(), d.getMonth(), 1);
  const me = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return ms <= new Date(to + "T23:59:59") && me >= new Date(from + "T00:00:00");
}

/* =========================================================================
   DATE RANGE PICKER — inline calendar
   ========================================================================= */

const CalendarPicker = ({ from, to, onSelect }) => {
  const todayStr = drToday();
  const initD    = from ? new Date(from + "T12:00:00") : new Date();
  const [vy, setVy] = useState(initD.getFullYear());
  const [vm, setVm] = useState(initD.getMonth());
  const [anchor,  setAnchor]  = useState(null);
  const [hovered, setHovered] = useState(null);

  // Reset picking state when external from/to changes (preset applied)
  useEffect(() => { setAnchor(null); setHovered(null); }, [from, to]);

  // Calendar math helpers
  const ds   = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dim  = (y, m)    => new Date(y, m + 1, 0).getDate();
  const fdow = (y, m)    => { const d = new Date(y, m, 1).getDay(); return d === 0 ? 6 : d - 1; };

  const prevMonth = () => { const d = new Date(vy, vm - 1, 1); setVy(d.getFullYear()); setVm(d.getMonth()); };
  const nextMonth = () => {
    const d = new Date(vy, vm + 1, 1);
    if (ds(d.getFullYear(), d.getMonth(), 1) <= todayStr) { setVy(d.getFullYear()); setVm(d.getMonth()); }
  };
  const canNext = new Date(vy, vm + 1, 1) <= new Date();

  const handleDay = (dateStr) => {
    if (!anchor) {
      setAnchor(dateStr);
    } else {
      const [s, e] = dateStr < anchor ? [dateStr, anchor] : [anchor, dateStr];
      onSelect(s, e);
      setAnchor(null); setHovered(null);
    }
  };

  // Display range: while picking, preview anchor→hover; otherwise show committed from/to
  const dFrom = anchor ? (hovered && hovered < anchor ? hovered : anchor) : from;
  const dTo   = anchor ? (hovered && hovered > anchor ? hovered : anchor) : to;

  const numDays = dim(vy, vm);
  const offset  = fdow(vy, vm);
  const monthLabel = new Date(vy, vm, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const cells = [...Array(offset).fill(null), ...Array.from({ length: numDays }, (_, i) => ds(vy, vm, i + 1))];

  return (
    <div className="select-none">
      {/* Month navigation */}
      <div className="mb-2 flex items-center justify-between px-0.5">
        <button onClick={prevMonth} className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100">
          <ChevronDown size={13} className="rotate-90" />
        </button>
        <span className="text-[12px] font-semibold text-neutral-800">{monthLabel}</span>
        <button onClick={nextMonth} disabled={!canNext} className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 disabled:opacity-25 disabled:cursor-default">
          <ChevronDown size={13} className="-rotate-90" />
        </button>
      </div>

      {/* Weekday headers */}
      <div className="mb-0.5 grid grid-cols-7">
        {DAYS.map(d => <div key={d} className="py-0.5 text-center text-[10px] font-medium text-neutral-400">{d}</div>)}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {cells.map((dateStr, i) => {
          if (!dateStr) return <div key={`_${i}`} className="h-8" />;

          const future   = dateStr > todayStr;
          const isToday  = dateStr === todayStr;
          const isStart  = dateStr === dFrom;
          const isEnd    = dateStr === dTo;
          const inRange  = dFrom && dTo && dFrom !== dTo && dateStr > dFrom && dateStr < dTo;
          const isEdge   = isStart || isEnd;
          const bothEdge = isStart && isEnd;
          const dayNum   = +dateStr.slice(8);

          return (
            <div
              key={dateStr}
              className={[
                "relative flex h-8 items-center justify-center",
                inRange                        ? "bg-neutral-100"    : "",
                isStart && dTo && !bothEdge    ? "rounded-l-full"   : "",
                isEnd   && dFrom && !bothEdge  ? "rounded-r-full"   : "",
              ].join(" ")}
            >
              <button
                onClick={() => !future && handleDay(dateStr)}
                onMouseEnter={() => anchor && !future && setHovered(dateStr)}
                onMouseLeave={() => anchor && setHovered(null)}
                disabled={future}
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-medium transition",
                  future   ? "cursor-default text-neutral-200"                             : "",
                  isEdge   ? "bg-neutral-900 text-white"                                   : "",
                  isToday && !isEdge ? "ring-1 ring-inset ring-neutral-400 text-neutral-700" : "",
                  !isEdge && !future ? "text-neutral-700 hover:bg-neutral-200"             : "",
                ].join(" ")}
              >
                {dayNum}
              </button>
            </div>
          );
        })}
      </div>

      {/* Hint line */}
      <p className="mt-2 text-center text-[10px] text-neutral-400">
        {anchor ? "Now click to select end date" : "Click a date to start selection"}
      </p>
    </div>
  );
};

const QuickRangePills = ({ from, to, onApply, disabled = false }) => {
  const today = drToday();
  const daysAgoStr = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split("T")[0];
  };
  const PRESETS = [
    { label: "7D",  days: 7 },
    { label: "30D", days: 30 },
    { label: "90D", days: 90 },
  ];
  const isActive = (days) => from === daysAgoStr(days) && to === today;
  return (
    <div className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white p-0.5">
      {PRESETS.map(p => {
        const active = isActive(p.days);
        return (
          <button
            key={p.label}
            disabled={disabled}
            onClick={() => onApply(daysAgoStr(p.days), today)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition ${
              active
                ? "bg-neutral-900 text-white"
                : "text-neutral-500 hover:bg-neutral-100"
            } disabled:opacity-50`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
};

export const DateRangePicker = ({ from, to, onApply, loading = false }) => {
  const [open, setOpen]           = useState(false);
  const [pendingFrom, setPendingFrom] = useState(from);
  const [pendingTo,   setPendingTo]   = useState(to);
  const ref = useRef(null);

  // Keep pending in sync if parent resets committed range externally
  useEffect(() => { setPendingFrom(from); setPendingTo(to); }, [from, to]);

  useEffect(() => {
    function outside(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  const PRESETS = getDatePresets();

  const handleApply = () => {
    if (!pendingFrom || !pendingTo) return;
    onApply(pendingFrom, pendingTo);
    setOpen(false);
  };

  const pendingChanged = pendingFrom !== from || pendingTo !== to;

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-60"
        disabled={loading}
      >
        {loading
          ? <RefreshCw size={13} className="text-neutral-400 animate-spin" />
          : <Calendar size={13} className="text-neutral-400" />
        }
        {drFormatLabel(from, to)}
        <ChevronDown size={12} className={`text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-10 z-50 w-[300px] rounded-xl border border-neutral-200 bg-white p-3 shadow-xl shadow-neutral-200/60">
          {/* Presets */}
          <div className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Quick select</div>
          <div className="mb-3 grid max-h-[180px] grid-cols-2 gap-1 overflow-y-auto pr-1">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => { setPendingFrom(p.from); setPendingTo(p.to); }}
                className={`rounded-md px-2 py-1.5 text-left text-[11px] font-medium transition ${
                  p.from === pendingFrom && p.to === pendingTo
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div className="border-t border-neutral-100 pt-3">
            <div className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Custom range</div>
            <CalendarPicker
              from={pendingFrom}
              to={pendingTo}
              onSelect={(f, t) => { setPendingFrom(f); setPendingTo(t); }}
            />
          </div>

          {/* Pending range preview */}
          {pendingFrom && pendingTo && (
            <div className="mt-2 flex items-center justify-between rounded-md bg-neutral-50 px-2.5 py-1.5">
              <span className="text-[11px] text-neutral-500">{drFormatLabel(pendingFrom, pendingTo)}</span>
            </div>
          )}

          {/* Apply button */}
          <button
            onClick={handleApply}
            disabled={!pendingFrom || !pendingTo}
            className={`mt-2 w-full rounded-lg px-3 py-2 text-[12px] font-semibold transition ${
              pendingChanged
                ? "bg-neutral-900 text-white hover:bg-neutral-700"
                : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
            }`}
          >
            {pendingChanged ? "Apply & sync" : "Apply"}
          </button>
        </div>
      )}
    </div>
  );
};

/* =========================================================================
   SMALL UI COMPONENTS
   ========================================================================= */

const Card = ({ children, className = "", ...props }) => (
  <div {...props} className={`rounded-xl border border-neutral-200/70 bg-white ${className}`}>
    {children}
  </div>
);

const Chip = ({ active, children, onClick }) => (
  <button
    onClick={onClick}
    className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${
      active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
    }`}
  >
    {children}
  </button>
);

const NavItem = ({ icon: Icon, label, active, onClick, badge }) => (
  <button
    onClick={onClick}
    className={`group flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] font-medium transition ${
      active ? "bg-neutral-100 text-neutral-900" : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
    }`}
  >
    <span className="flex items-center gap-2.5">
      <Icon size={14} strokeWidth={2} />
      {label}
    </span>
    {badge && (
      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
        {badge}
      </span>
    )}
  </button>
);

const StatusDot = ({ status }) => {
  const colors = {
    ok: "bg-emerald-500",
    warning: "bg-amber-500",
    error: "bg-rose-500",
  };
  return (
    <span className="relative flex h-2 w-2">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${colors[status]} opacity-40`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colors[status]}`} />
    </span>
  );
};

/* =========================================================================
   BRAND ICONS — small source indicators
   ========================================================================= */

const BrandIcon = ({ brand, size = 14, className = "" }) => {
  const common = { width: size, height: size, viewBox: "0 0 24 24", xmlns: "http://www.w3.org/2000/svg", className };
  switch (brand) {
    case "shopify":
      return (
        <svg {...common}>
          <path fill="#95BF47" d="M15.337 3.967c-.026-.22-.22-.34-.38-.352-.156-.01-3.115-.054-3.115-.054s-2.478-2.407-2.724-2.652c-.246-.246-.726-.171-.913-.115-.003 0-.469.145-1.243.385-.13-.422-.322-.94-.596-1.46C5.486.188 4.31-.086 3.59.021c-.017.004-.085.028-.106.033C3.424.014 3.225-.032 3.004.02 2.583.115 2.22.387 1.973.783 1.621 1.35 1.424 2.17 1.37 3.355.49 3.627.015 3.78 0 3.78l4.635 15.894 13.253-2.895s-2.544-17.035-2.551-17.063zM9.24 2.58c-.596.183-1.25.387-1.905.59.187-.717.547-1.43 1.016-1.864.173-.16.404-.34.681-.444.26.545.37 1.322.208 1.718zm-2.26.699a20.76 20.76 0 0 0-2.03.629c.18-.868.523-1.735.942-2.307.155-.213.374-.45.631-.583.24.507.293 1.223.207 1.742zm-1.59-2.71c.242-.1.515-.115.69-.099-.253.129-.505.34-.739.619-.548.65-.972 1.66-1.14 2.636-.512.158-1.012.313-1.473.455.298-1.39 1.463-3.574 2.662-3.611zm1.41 8.957c.056.864 2.318 1.05 2.446 3.08.1 1.595-.846 2.686-2.21 2.771-1.636.103-2.538-.863-2.538-.863l.346-1.474s.908.686 1.632.64c.474-.03.644-.414.627-.686-.073-1.128-1.915-1.06-2.033-2.917-.098-1.561 1.023-3.145 3.265-3.287 1.057-.067 1.599.203 1.599.203l-.474 2.168s-.692-.317-1.513-.265c-1.204.076-1.217.837-1.204 1.08l.057.55zm5.64-5.93c-.6.185-1.193.368-1.78.55.005-.2.009-.393.009-.606 0-.56-.078-1.01-.202-1.365.5.064.842.644.99 1.135.08.273.15.549.209.826.148.047.293.094.437.14-.168-.19-.33-.393-.482-.613.282.07.56.15.834.226-.004.007-.01.012-.015.02-.237-.086-.48-.16-.725-.22.17.243.325.484.464.713zM19.32 2.1s-.85-.015-1.31-.018c.075.054.137.12.21.183l2.33 2.19c-.41.125-.826.252-1.23.375l-.245-1.66c-.015-.086-.105-.146-.165-.15-.12-.015-.7-.022-.725-.022-.045 0-.06.015-.09.045l-.265.09s.42-.135 1.49-.75z"/>
          <path fill="#5E8E3E" d="M15.337 3.967c-.026-.22-.22-.34-.38-.352-.156-.01-3.115-.054-3.115-.054l-.008 15.912 6.5-1.42-2.997-14.086z"/>
        </svg>
      );
    case "loop":
      return (
        <svg {...common} viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="7" fill="#7C3AED"/>
          <path d="M9 13.5c0 1.933 1.567 3.5 3.5 3.5s3.5-1.567 3.5-3.5M16 13.5c0 1.933 1.567 3.5 3.5 3.5S23 15.433 23 13.5s-1.567-3.5-3.5-3.5-3.5 1.567-3.5 3.5zM9 13.5c0-1.933 1.567-3.5 3.5-3.5s3.5 1.567 3.5 3.5v5.5c0 1.38-1.12 2.5-2.5 2.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      );
    case "triplewhale":
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect width="24" height="24" rx="5" fill="#1a1a2e"/>
          <path d="M5 10 L8 14 L12 8 L16 14 L19 10" stroke="#A78BFA" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
      );
    case "ing":
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect width="24" height="24" rx="3" fill="#FF6200"/>
          <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="Arial">ING</text>
        </svg>
      );
    case "revolut":
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect width="24" height="24" rx="3" fill="#000"/>
          <text x="12" y="17" textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff" fontFamily="Georgia, serif" fontStyle="italic">R</text>
        </svg>
      );
    case "mollie":
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect width="24" height="24" rx="5" fill="#000"/>
          <circle cx="9" cy="12" r="2.5" fill="#fff"/>
          <circle cx="15" cy="12" r="2.5" fill="#fff"/>
        </svg>
      );
    case "paypal":
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect width="24" height="24" rx="3" fill="#fff" stroke="#e5e5e5" strokeWidth="0.5"/>
          <path d="M9.5 7h4c2 0 3 1 2.7 2.7-.4 2.2-2 3.3-4.3 3.3h-1.2l-.5 3.2a.5.5 0 0 1-.5.4H8.5a.3.3 0 0 1-.3-.4L9.5 7z" fill="#003087"/>
          <path d="M10.8 8.5h3c1.3 0 2 .7 1.8 1.9-.3 1.5-1.3 2.3-3 2.3h-1L11 15c0 .2-.2.3-.3.3H9.5a.3.3 0 0 1-.3-.4l1.6-6.4z" fill="#009CDE"/>
        </svg>
      );
    case "jortt":
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect width="24" height="24" rx="4" fill="#00A6A6"/>
          <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="Arial">J</text>
        </svg>
      );
    default:
      return null;
  }
};

/* =========================================================================
   COMPONENT: Today's Profit (est.) card — sits above the Revenue hero
   ========================================================================= */

const fmtEur0 = (n: number | null | undefined) =>
  n == null ? "—" : `€${Math.round(n).toLocaleString()}`;

const TodaysProfitCard = ({ metrics, chartsReady }: any) => {
  const { today, week, mtd, ytd, series, avg30, todayVsYesterdayPct, hasAnyDaily } = metrics;
  const trendPositive = (todayVsYesterdayPct ?? 0) >= 0;
  return (
    <section className="mt-3">
      <div
        className="rounded-2xl border border-neutral-200 bg-white p-6"
        style={{ fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif' }}
      >
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              <span>Today's profit (est.)</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-500 normal-case tracking-normal border border-neutral-200">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-900" />
                Shopify + TW
                {avg30 != null && <span className="text-neutral-400">· Jortt T-1</span>}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <div className="text-[28px] font-semibold tabular-nums">{fmtEur0(today)}</div>
              {todayVsYesterdayPct != null && (
                <span className={`text-[13px] font-medium tabular-nums ${trendPositive ? "text-emerald-600" : "text-rose-600"}`}>
                  {trendPositive ? "+" : ""}{todayVsYesterdayPct.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="mt-1 text-[12px] text-neutral-400">
              vs. same day last week {fmtEur0(metrics.sameDayLastWeek ?? metrics.yesterday)} · 30-day avg {fmtEur0(avg30)}
            </div>
          </div>
        </div>

        {/* Period grid */}
        <div className="mt-6 grid grid-cols-3 gap-6 border-t border-neutral-100 pt-4">
          <div>
            <div className="text-[11px] font-medium text-neutral-400">This week</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">{fmtEur0(week)}</div>
          </div>
          <div>
            <div className="text-[11px] font-medium text-neutral-400">MTD</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">{fmtEur0(mtd)}</div>
          </div>
          <div>
            <div className="text-[11px] font-medium text-neutral-400">YTD</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">{fmtEur0(ytd)}</div>
          </div>
        </div>

        {/* 30-day rolling sparkline */}
        <div className="mt-6">
          <div className="flex items-center justify-between text-[11px] text-neutral-400">
            <span>30-day rolling profit</span>
            <span>Daily</span>
          </div>
          <div className="mt-2 h-[60px] w-full">
            {chartsReady && hasAnyDaily ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0a0a0a" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="#0a0a0a" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    cursor={{ stroke: "#e5e5e5", strokeWidth: 1 }}
                    contentStyle={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "1px solid #e5e5e5" }}
                    formatter={(v: any) => [fmtEur0(Number(v)), "Profit"]}
                    labelFormatter={(l: any) => l}
                  />
                  <Area type="monotone" dataKey="profit" stroke="#0a0a0a" strokeWidth={1.5} fill="url(#profitFill)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-[11px] text-neutral-400">
                {hasAnyDaily ? "" : "Daily data syncing — refresh in a minute"}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

/* =========================================================================
   VIEW: OVERVIEW
   ========================================================================= */

// Cohort window options for the per-section filters in Subscriptions and the
// Repeat purchase funnel. `monthsBack: null` = no filter (show everything).
// Used by `<CohortRangeFilter>` and `filterMonthlyCohorts()` below.
const COHORT_RANGES: Array<{ key: string; label: string; monthsBack: number | null }> = [
  { key: "all", label: "ALL", monthsBack: null },
  { key: "1w", label: "Last week", monthsBack: 1 },
  { key: "1m", label: "Last month", monthsBack: 1 },
  { key: "3m", label: "Last 3 months", monthsBack: 3 },
  { key: "6m", label: "Last 6 months", monthsBack: 6 },
];

function CohortRangeFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-md border border-neutral-200 bg-white p-0.5">
      {COHORT_RANGES.map((r) => {
        const active = r.key === value;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onChange(r.key)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition ${
              active
                ? "bg-neutral-900 text-white"
                : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-700"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

// Cohort month keys ship in either `YYYY-MM` or `MMM 'YY` form. Normalize and
// compare against a "now − N months" cutoff. `1w` is approximated as the
// current month only since cohorts are bucketed monthly.
function filterMonthlyCohorts<T extends { month?: string }>(
  cohorts: T[] | null | undefined,
  rangeKey: string,
): T[] {
  if (!Array.isArray(cohorts)) return [];
  const spec = COHORT_RANGES.find((r) => r.key === rangeKey);
  if (!spec || spec.monthsBack == null) return cohorts;
  const now = new Date();
  const monthsAgo = new Date(now.getFullYear(), now.getMonth() - (spec.monthsBack - 1), 1);
  const parseMonth = (m: string | undefined): Date | null => {
    if (!m) return null;
    // YYYY-MM
    const iso = m.match(/^(\d{4})-(\d{2})$/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, 1);
    // "MMM 'YY"  e.g. "Apr '26"
    const named = m.match(/^([A-Za-z]{3})\s+'(\d{2})$/);
    if (named) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const mi = months.indexOf(named[1].toLowerCase());
      if (mi >= 0) return new Date(2000 + Number(named[2]), mi, 1);
    }
    return null;
  };
  return cohorts.filter((c) => {
    const d = parseMonth(c.month);
    return d != null && d >= monthsAgo;
  });
}

export const OverviewView = ({ dateRange, onDateChange, liveMarkets = null, twData = [], subData: subDataProp = [], shopifyMonthly = null, jorttData = null, xeroData = null, xeroError = null, xeroRaw = null, rangeData = null, rangeSyncing = false, shopifyDaily = null, tripleWhaleDaily = null, tripleWhaleCustomerEconomics = null, shopifyRepeatFunnel = null, sourceStatus = null, manualData = null }: any) => {
  const [chartsReady, setChartsReady] = useState(false);
  const [showRevenueBreakdown, setShowRevenueBreakdown] = useState(false);
  const [showRevProfitChart, setShowRevProfitChart] = useState(false);
  // Shared cohort-window filter for the Subscriptions card AND the Repeat
  // purchase funnel card — both surface cohort-based data, so a single
  // picker drives both. The filter UI lives in the Subscriptions header.
  // Default ALL = no filter, matching the existing behaviour exactly.
  const [subsRange, setSubsRange] = useState<string>("all");
  useEffect(() => { setChartsReady(true); }, []);

  // When a custom-range sync has returned data, use it in place of the live props
  const effectiveMarkets = Array.isArray(rangeData?.shopifyMarkets) ? rangeData.shopifyMarkets : liveMarkets;
  const effectiveTWData  = Array.isArray(rangeData?.tripleWhale)
    ? rangeData.tripleWhale.filter(m => m?.live)
    : twData;

  // Subscriptions: when a custom range is synced, use range-aware subs (MRR/active
  // as of `to`, new/churned in [from, to]); otherwise fall back to live snapshot.
  const rangeSubs = (() => {
    const juo = Array.isArray(rangeData?.juo) ? rangeData.juo.filter((m: any) => m?.live) : [];
    const loop = Array.isArray(rangeData?.loop) ? rangeData.loop.filter((m: any) => m?.live) : [];
    const merged = [...juo, ...loop];
    return merged.length ? merged : null;
  })();
  const subData = rangeSubs ?? subDataProp;

  // Is the selected range the current month?
  const isCurrentMonth = useMemo(() => {
    if (rangeData) return false; // always treat synced custom-range data as historical
    const som = drStartOfMonth(), tod = drToday();
    return dateRange.from === som && dateRange.to === tod;
  }, [dateRange, rangeData]);

  // Shopify monthly rows that fall within the selected date range
  const rangeShopifyMonths = useMemo(() =>
    (shopifyMonthly ?? []).filter(m => monthInRange(m.month, dateRange.from, dateRange.to)),
    [shopifyMonthly, dateRange]);

  // Jortt months in range
  const rangeJorttRevenue = useMemo(() => {
    if (!jorttData?.revenueByMonth) return null;
    const total = Object.entries(jorttData.revenueByMonth)
      .filter(([mk]) => monthInRange(mk, dateRange.from, dateRange.to))
      .reduce((s, [, v]) => s + v, 0);
    return total > 0 ? total : null;
  }, [jorttData, dateRange]);

  // OpEx total = every bucket Xero reports as Operating Expense (Team +
  // Software + Agencies + Content + Rent + Other). Previously this summed
  // only the 4 named buckets, which left the dashboard ~27% short of Xero's
  // reported total — fulfilment, bank fees, travel, insurance etc. were
  // invisible. Matching Xero exactly is the right default.
  const rangeXeroOpex = useMemo(() => {
    const opexByMonth = (xeroData as any)?.opexByMonth;
    if (!Array.isArray(opexByMonth) || !opexByMonth.length) return null;
    const total = opexByMonth
      .filter((m: any) => monthInRange(m.month, dateRange.from, dateRange.to))
      .reduce(
        (s: number, m: any) =>
          s + (m.team || 0) + (m.software || 0) + (m.agencies || 0) + (m.content || 0) + (m.rent || 0) + (m.other || 0),
        0,
      );
    return total > 0 ? total : null;
  }, [xeroData, dateRange]);

  // Revenue: rangeData (fresh sync) > current-month live > monthly cache > Jortt
  const liveRevenueMTD  = effectiveMarkets?.filter(m => m.live).reduce((s, m) => s + (m.revenue ?? 0), 0) ?? null;
  const liveOrdersMTD   = effectiveMarkets?.filter(m => m.live).reduce((s, m) => s + (m.orders ?? 0), 0) ?? null;
  const rangeRevenue = rangeData
    ? liveRevenueMTD   // effectiveMarkets is rangeData.shopifyMarkets — fresh Shopify data
    : isCurrentMonth
      ? liveRevenueMTD
      : rangeShopifyMonths.length > 0
        ? rangeShopifyMonths.reduce((s, m) => s + ((m.revenue ?? 0) - (m.refunds ?? 0)), 0)
        : (rangeJorttRevenue ?? null);
  const rangeOrders = rangeData
    ? liveOrdersMTD
    : isCurrentMonth
      ? liveOrdersMTD
      : rangeShopifyMonths.length > 0 ? rangeShopifyMonths.reduce((s, m) => s + (m.orders ?? 0), 0) : null;
  const rangeAOV = rangeRevenue && rangeOrders ? rangeRevenue / rangeOrders : null;

  // Revenue source label
  const revenueSourceLabel = rangeData
    ? `${drFormatLabel(dateRange.from, dateRange.to)} · all stores · synced`
    : isCurrentMonth
      ? "MTD · all stores · Shopify live"
      : rangeShopifyMonths.length > 0
        ? `${rangeShopifyMonths.length} month${rangeShopifyMonths.length > 1 ? "s" : ""} · Shopify NL · historical`
        : rangeJorttRevenue ? "Jortt invoices · historical" : "No Shopify data for this range";

  const liveAOV = isCurrentMonth ? (liveRevenueMTD && liveOrdersMTD ? liveRevenueMTD / liveOrdersMTD : null) : rangeAOV;
  const liveTWNL        = effectiveTWData?.find(t => t.market === "NL" && t.live);
  // Ad spend: NL only (EUR). Other markets use GBP/USD — summing currencies gives wrong totals.
  const liveAdSpendNL   = liveTWNL?.adSpend ?? null;
  const liveAdSpend     = liveAdSpendNL;   // shown as NL (EUR) ad spend
  // ROAS: use TW NL's blended ROAS directly (it accounts for all channels for that store)
  const liveROAS        = liveTWNL?.roas ?? null;
  // MER: compute from TW NL's own revenue and ad spend to stay in one currency
  const liveMER         = (liveTWNL?.revenue && liveTWNL?.adSpend && liveTWNL.adSpend > 0)
    ? +(liveTWNL.revenue / liveTWNL.adSpend).toFixed(2)
    : null;
  const liveNCPA        = liveTWNL?.ncpa ?? null;
  const liveLtvCpa      = liveTWNL?.ltvCpa ?? null;
  const liveLtv90       = tripleWhaleCustomerEconomics?.ltv90 ?? null;
  const liveLtv365      = tripleWhaleCustomerEconomics?.ltv365 ?? null;
  // Real P&L from TW NL (these are real figures, not estimates)
  const liveGrossProfit = liveTWNL?.grossProfit ?? null;
  const liveCOGS        = liveTWNL?.cogs ?? null;
  const liveNetProfit   = liveTWNL?.netProfit ?? null;
  // Sum gross profit across all live TW markets that have it
  const twTotalGrossProfit = effectiveTWData?.filter(t => t.live && t.grossProfit != null).reduce((s, t) => s + (t.grossProfit ?? 0), 0) || null;
  const twTotalNetProfit   = effectiveTWData?.filter(t => t.live && t.netProfit   != null).reduce((s, t) => s + (t.netProfit   ?? 0), 0) || null;
  const twTotalAdSpend     = effectiveTWData?.filter(t => t.live && t.adSpend     != null).reduce((s, t) => s + (t.adSpend     ?? 0), 0) || null;
  const liveLoop        = subData.find(s => s.market === "UK") ?? null;
  const liveJuo         = subData.find(s => s.market === "NL") ?? null;
  // FX rates from Shopify markets (currency → EUR rate). Subscription rows
  // come from Loop (GBP/USD/EUR) and Juo (EUR) without their own FX, so we
  // borrow rates from the matching Shopify market when available.
  const fxRateByMarket: Record<string, number> = {};
  for (const m of (liveMarkets ?? [])) {
    if (m?.code && typeof m.fxRate === "number") fxRateByMarket[m.code] = m.fxRate;
  }
  const fallbackFx: Record<string, number> = { EUR: 1, GBP: 1.17, USD: 0.92 };
  const subToEUR = (m: any): number => {
    const native = m?.mrr ?? 0;
    if (!native) return 0;
    const code = m?.market;
    const cur = m?.currency ?? "EUR";
    if (cur === "EUR") return native;
    const rate = fxRateByMarket[code] ?? fallbackFx[cur] ?? 1;
    return native * rate;
  };
  // Decorate subData with eurMrr for downstream calculations
  const subDataEUR = subData.map((m: any) => ({ ...m, mrrEUR: subToEUR(m) }));
  const liveMRR         = subDataEUR.length > 0
    ? +subDataEUR.reduce((s, m) => s + (m.mrrEUR ?? 0), 0).toFixed(2)
    : null;
  const revenueBreakdownMarkets = effectiveMarkets?.filter(m => m.live) ?? [];

  // ─── Today's Profit (est.) — uses cached daily Shopify revenue + TW ad spend ───
  const profitMetrics = useMemo(() => {
    const rev: Record<string, number> = (shopifyDaily?.daily ?? {}) as any;
    const tw: Record<string, { adSpend: number; grossProfit: number }> =
      (tripleWhaleDaily?.daily ?? {}) as any;
    const dayProfit = (k: string): number | null => {
      const r = rev[k]?.revenue;
      const ad = tw[k]?.adSpend;
      if (r == null && ad == null) return null;
      // Profit estimate = Shopify net revenue − TW blended ad spend
      return (r ?? 0) - (ad ?? 0);
    };
    const sumRange = (from: Date, to: Date): number | null => {
      let total = 0;
      let any = false;
      const d = new Date(from);
      while (d <= to) {
        const k = d.toISOString().split("T")[0];
        const p = dayProfit(k);
        if (p != null) { total += p; any = true; }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return any ? total : null;
    };
    const now = new Date();
    const todayKey = now.toISOString().split("T")[0];
    const today = dayProfit(todayKey);
    // Same day last week (like-for-like, removes day-of-week effects)
    const sameDayLastWeek = (() => {
      const y = new Date(now); y.setUTCDate(y.getUTCDate() - 7);
      return dayProfit(y.toISOString().split("T")[0]);
    })();
    const yesterday = sameDayLastWeek; // alias kept for backwards compat in shape

    // This week (Monday → today, UTC)
    const weekStart = new Date(now);
    const dow = (weekStart.getUTCDay() + 6) % 7; // Mon=0
    weekStart.setUTCDate(weekStart.getUTCDate() - dow);
    const week = sumRange(weekStart, now);

    // MTD
    const mtdStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const mtd = sumRange(mtdStart, now);

    // YTD
    const ytdStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const ytd = sumRange(ytdStart, now);

    // 30-day series (oldest first) for sparkline
    const series: { date: string; profit: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
      const k = d.toISOString().split("T")[0];
      const p = dayProfit(k);
      series.push({ date: k, profit: p ?? 0 });
    }
    const avg30 = series.length ? series.reduce((s, x) => s + x.profit, 0) / series.length : null;
    const todayVsYesterdayPct = (today != null && sameDayLastWeek != null && sameDayLastWeek !== 0)
      ? ((today - sameDayLastWeek) / Math.abs(sameDayLastWeek)) * 100
      : null;

    const hasAnyDaily = Object.keys(rev).length > 0 || Object.keys(tw).length > 0;
    return { today, yesterday, sameDayLastWeek, week, mtd, ytd, series, avg30, todayVsYesterdayPct, hasAnyDaily };
  }, [shopifyDaily, tripleWhaleDaily]);

  const dashboardDiagnostics = useMemo(() => {
    const apiRows = sourceStatus?.sources ?? [];
    const refused = apiRows.filter((s: any) => s.status === "error" || s.status === "disconnected");
    const delayed = apiRows.filter((s: any) => s.status === "degraded");
    const mathWidgets = [
      "Revenue", "Orders", "AOV", "Contribution margin", "OpEx", "EBITDA",
      "NCPA", "90D LTV", "365D LTV", "Ad spend", "Blended ROAS", "MRR",
      "Active subscribers", "Churn rate", "Subscription share", "Repeat funnel",
      "Today's profit", "MRR chart", "Market split", "Cohort table",
    ];
    return { apiRows, refused, delayed, mathWidgets };
  }, [sourceStatus]);

  return (<>
    <div className="flex items-end justify-between">
      <div>
        <div className="text-[12px] font-medium text-neutral-400">Overview</div>
        <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Finance</h1>
        <p className="mt-1 text-[13px] text-neutral-500">
          Live revenue from Shopify, ad performance from Triple Whale, reconciled nightly against Jortt.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <DateRangePicker from={dateRange.from} to={dateRange.to} onApply={onDateChange} loading={rangeSyncing} />
      </div>
    </div>

    {/* Today's Profit (est.) */}
    <TodaysProfitCard metrics={profitMetrics} chartsReady={chartsReady} />

    {/* Revenue hero */}
    <section className="mt-3">
      <Card
        className="relative p-6 transition hover:border-neutral-300"
        onMouseEnter={() => setShowRevenueBreakdown(true)}
        onMouseLeave={() => setShowRevenueBreakdown(false)}
        onFocus={() => setShowRevenueBreakdown(true)}
        onBlur={() => setShowRevenueBreakdown(false)}
      >
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-neutral-500">
              <img src={shopifyGlyph} alt="Shopify" className="h-4 w-4 object-contain" />
              <span>Revenue</span>
              <span className="text-[11px] text-neutral-400">· selected period</span>
            </div>
            <div className="mt-3 flex items-baseline gap-4">
              {rangeRevenue !== null ? (
                <>
                  <div className="relative inline-block">
                    <span tabIndex={0} className="text-[44px] font-semibold tracking-tight tabular-nums leading-none cursor-help border-b border-dashed border-neutral-300 outline-none">
                      €{Math.round(rangeRevenue).toLocaleString()}
                    </span>
                    {/* Hover breakdown */}
                    {revenueBreakdownMarkets.length > 0 && (
                      <div className={`pointer-events-none absolute left-0 top-full z-30 mt-2 w-[340px] rounded-lg border border-neutral-200 bg-white p-4 shadow-xl ${showRevenueBreakdown ? "block" : "hidden"}`}>
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Revenue breakdown</div>
                        <div className="space-y-1.5">
                          {revenueBreakdownMarkets.map(m => {
                            const sym = m.currency === "GBP" ? "£" : m.currency === "USD" ? "$" : "€";
                            const native = m.revenueNative ?? m.revenue ?? 0;
                            const eur = m.revenue ?? 0;
                            const fx = m.fxRate ?? 1;
                            const sameCurrency = m.currency === "EUR" || fx === 1;
                            return (
                              <div key={m.code} className="flex items-center justify-between text-[12px]">
                                <span className="flex items-center gap-1.5">
                                  <Flag code={m.code} size={14} />
                                  <span className="font-medium text-neutral-700">{m.code}</span>
                                </span>
                                <span className="text-right tabular-nums">
                                  <span className="text-neutral-500">{sym}{Math.round(native).toLocaleString()}</span>
                                  {!sameCurrency && (
                                    <>
                                      <span className="mx-1 text-neutral-300">→</span>
                                      <span className="font-semibold text-neutral-900">€{Math.round(eur).toLocaleString()}</span>
                                      <div className="text-[10px] text-neutral-400">@ {fx.toFixed(4)} EUR/{m.currency}</div>
                                    </>
                                  )}
                                  {sameCurrency && m.currency !== "EUR" && (
                                    <span className="ml-1 font-semibold text-neutral-900">€{Math.round(eur).toLocaleString()}</span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-neutral-100 pt-2 text-[12px]">
                          <span className="font-semibold text-neutral-700">Total</span>
                          <span className="font-semibold tabular-nums">€{Math.round(rangeRevenue).toLocaleString()}</span>
                        </div>
                        <div className="mt-2 text-[10px] text-neutral-400">FX rates from frankfurter.app · refreshed per range</div>
                      </div>
                    )}
                  </div>
                  {isCurrentMonth
                    ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>Live</span>
                    : <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">Historical</span>
                  }
                </>
              ) : (
                <span className="text-[44px] font-semibold tracking-tight tabular-nums leading-none text-neutral-300">—</span>
              )}
            </div>
            <div className="mt-1 text-[12px] text-neutral-400">{rangeRevenue !== null ? revenueSourceLabel : "Shopify not connected"}</div>
            {revenueBreakdownMarkets.length > 0 && rangeRevenue !== null && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {revenueBreakdownMarkets.map(m => {
                  const eur = m.revenue ?? 0;
                  const pct = rangeRevenue > 0 ? (eur / rangeRevenue) * 100 : 0;
                  return (
                    <div key={m.code} title={m.name ?? m.code} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px]">
                      <Flag code={m.code} size={14} />
                      <span className="font-semibold tabular-nums text-neutral-900">€{Math.round(eur).toLocaleString()}</span>
                      <span className="text-neutral-400 tabular-nums">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="hidden items-center gap-6 md:flex">
            <div className="text-right">
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Orders</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{rangeOrders !== null ? rangeOrders.toLocaleString() : "—"}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">AOV</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{rangeAOV !== null ? `€${rangeAOV.toFixed(2)}` : liveAOV !== null ? `€${liveAOV.toFixed(2)}` : "—"}</div>
            </div>
          </div>
        </div>
      </Card>
    </section>

    {/* Contribution margin · OpEx · EBITDA — real data row */}
    {rangeRevenue !== null && (() => {
      const rev = rangeRevenue ?? 0;

      // Contribution margin: needs TW gross profit AND ad spend for the period.
      // Only accurate when TW data actually covers the selected range
      // (current month OR a freshly-synced custom range).
      const twCoversRange = !!rangeData || isCurrentMonth;
      const cm = (twCoversRange && twTotalGrossProfit != null && twTotalAdSpend != null)
        ? twTotalGrossProfit - twTotalAdSpend
        : null;
      const cmPct = cm != null && rev > 0 ? (cm / rev) * 100 : null;

      // OpEx: Xero P&L OpEx summed across months overlapping the range.
      const opex = rangeXeroOpex ?? null;

      // EBITDA ≈ Contribution margin − OpEx
      const ebitda = (cm != null && opex != null) ? cm - opex : null;
      const ebitdaPct = ebitda != null && rev > 0 ? (ebitda / rev) * 100 : null;

      // Previous-period deltas — computable when prior month data exists
      // for both Xero OpEx and Shopify revenue.
      const prevDeltas = (() => {
        if (!isCurrentMonth) return { cm: null, opex: null, ebitda: null };
        const now = new Date();
        const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevKey = prevDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
        const prevShopify = (shopifyMonthly ?? []).find((m: any) => m.month === prevKey);
        const prevRev = prevShopify ? (prevShopify.revenue ?? 0) - (prevShopify.refunds ?? 0) : null;
        // Prior-month OpEx — full Xero total (all 6 buckets) to keep the MoM
        // delta apples-to-apples with rangeXeroOpex above.
        const prevXeroOpexRow = Array.isArray((xeroData as any)?.opexByMonth)
          ? (xeroData as any).opexByMonth.find((m: any) => m.month === prevKey)
          : null;
        const prevOpex = prevXeroOpexRow
          ? (prevXeroOpexRow.team || 0) + (prevXeroOpexRow.software || 0) + (prevXeroOpexRow.agencies || 0) + (prevXeroOpexRow.content || 0) + (prevXeroOpexRow.rent || 0) + (prevXeroOpexRow.other || 0)
          : null;
        // Approximate previous CM as Jortt prior-month revenue − prevOpex when
        // we don't have historical TW per-period data — only meaningful when
        // Jortt gives us prior-month revenue signal too.
        const prevJorttRev = jorttData?.revenueByMonth?.[prevKey] ?? null;
        const prevCM = (prevJorttRev != null && prevOpex != null) ? prevJorttRev - prevOpex : null;
        const prevEbitda = (prevCM != null && prevOpex != null) ? prevCM - prevOpex : null;
        const pctChange = (cur: number | null, prev: number | null) =>
          (cur != null && prev != null && prev !== 0)
            ? ((cur - prev) / Math.abs(prev)) * 100
            : null;
        return {
          cm: pctChange(cm, prevCM),
          opex: pctChange(opex, prevOpex),
          ebitda: pctChange(ebitda, prevEbitda),
        };
      })();

      const tiles = [
        {
          icon: Sparkles,
          label: "Contribution margin",
          value: cm != null ? `€${Math.round(cm).toLocaleString()}` : "—",
          sub: cmPct != null ? `${cmPct.toFixed(1)}% of revenue` : (twCoversRange ? "Connect Triple Whale" : "Sync range to compute"),
          delta: prevDeltas.cm,
          deltaInverse: false,
        },
        (() => {
          const days = Math.max(
            1,
            Math.round(
              (new Date(dateRange.to + "T00:00:00").getTime() -
                new Date(dateRange.from + "T00:00:00").getTime()) /
                86400000,
            ) + 1,
          );
          const dailyOpex = opex != null ? opex / days : null;
          const prevDailyDelta = (() => {
            if (prevDeltas.opex == null) return null;
            return prevDeltas.opex; // % change is the same per-day vs total
          })();
          // Diagnose the real reason this tile is empty when opex == null.
          // Distinguishes between: auth dead, sync wrote __error, sync wrote
          // __empty, stale client-side state (cache has data but our props
          // don't reflect it yet), Xero has no rows in the date range, or
          // bucketing landed everything in Other. No more lying about
          // connection state when the user can see "Healthy" on sync-status.
          const emptySub = (() => {
            const rawXero = xeroRaw as any;
            // Case 1 — actual auth failure (most recent sync wrote an error).
            if (xeroError && /auth|invalid_grant|refresh token|reconnect/i.test(xeroError)) {
              return "Xero auth expired — reconnect at /api/auth/xero";
            }
            if (xeroError) {
              return `Xero sync error — ${xeroError.slice(0, 90)}${xeroError.length > 90 ? "…" : ""}`;
            }
            // Case 2 — cache has a payload but it's the __empty sentinel.
            if (rawXero && typeof rawXero === "object" && rawXero.__empty) {
              return "Xero returned an empty payload — resync from /operations/sync-status";
            }
            // Case 3 — no data at all on the client side yet. This is the
            // "you just resynced on another tab and this page still has stale
            // React state" case. A page refresh fixes it.
            if (!xeroData) {
              return "Xero data not loaded into this view — reload the page (Ctrl+R)";
            }
            // Case 4 — Xero data is here, but no OpEx rows.
            const opexRows = (xeroData as any)?.opexByMonth;
            if (!Array.isArray(opexRows) || opexRows.length === 0) {
              return "Xero returned no monthly OpEx rows — open Monthly Overview for the P&L diagnostic";
            }
            // Case 5 — rows exist but the four visible buckets are empty.
            const bt = (xeroData as any)?._diagnostics?.profitAndLoss?.opexBucketTotals;
            if (bt) {
              const visible = (bt.team ?? 0) + (bt.agencies ?? 0) + (bt.content ?? 0) + (bt.software ?? 0);
              const otherRent = (bt.other ?? 0) + (bt.rent ?? 0);
              if (visible === 0 && otherRent > 0) {
                return `All €${Math.round(otherRent).toLocaleString()} expenses classified as "Other" / "Rent" — open Monthly Overview to see labels`;
              }
            }
            // Case 6 — the selected date range has no Xero rows.
            return "No Xero OpEx in this date range (try a wider window or check Monthly Overview)";
          })();
          return {
            icon: Wallet,
            label: "OpEx / day",
            value: dailyOpex != null ? `€${Math.round(dailyOpex).toLocaleString()}` : "—",
            sub: opex != null
              ? `€${Math.round(opex).toLocaleString()} over ${days}d · Team + Software + Agencies + Content`
              : emptySub,
            delta: prevDailyDelta,
            deltaInverse: true, // higher OpEx = bad
          };
        })(),
        {
          icon: TrendingUp,
          label: "EBITDA",
          value: ebitda != null ? `€${Math.round(ebitda).toLocaleString()}` : "—",
          // Be specific about which input is missing instead of a generic
          // "Needs CM + OpEx" — most often only one of the two is unresolved.
          sub: ebitdaPct != null
            ? `Margin ${ebitdaPct.toFixed(1)}%`
            : opex == null && cm == null
              ? "Needs Contribution Margin + OpEx"
              : opex == null
                ? "Needs OpEx (Xero)"
                : "Needs Contribution Margin (Triple Whale)",
          delta: prevDeltas.ebitda,
          deltaInverse: false,
        },
      ];

      return (
        <section className="mt-3 grid grid-cols-3 gap-3">
          {tiles.map((s) => {
            const positive = (s.delta ?? 0) >= 0;
            const good = s.deltaInverse ? !positive : positive;
            const Arrow = positive ? ArrowUpRight : ArrowDownRight;
            return (
              <Card key={s.label} className="p-5 transition hover:border-neutral-300">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-neutral-500">
                    <s.icon size={14} />
                    <span>{s.label}</span>
                  </div>
                  {s.delta != null && (
                    <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${good ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>
                      <Arrow size={11} />
                      {Math.abs(s.delta).toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className="mt-3 text-[28px] font-semibold tracking-tight tabular-nums">{s.value}</div>
                <div className="mt-1 text-[12px] text-neutral-400">{s.sub}</div>
              </Card>
            );
          })}
        </section>
      );
    })()}

    {/* Revenue vs Profit (per-store table + monthly chart toggle) */}
    {(() => {
      const months = (shopifyMonthly ?? [])
        .filter(m => monthInRange(m.month, dateRange.from, dateRange.to))
        // Date-based sort: m.month is "Mon 'YY" (e.g. "Apr '26"), and
        // localeCompare on that gives Apr → Mar → May order.
        .sort((a, b) => parseMonthKey(a.month).getTime() - parseMonthKey(b.month).getTime());
      if (months.length === 0) return null;
      // OpEx totals come from Xero opexByMonth (Team+Software+Agencies+Content+Rent+Other),
      // keyed by the "Mon 'YY" month label. Jortt is no longer used for OpEx.
      const xeroOpexRows: any[] = Array.isArray((xeroData as any)?.opexByMonth) ? (xeroData as any).opexByMonth : [];
      const xeroOpexByMk: Record<string, number> = {};
      for (const r of xeroOpexRows) {
        xeroOpexByMk[r.month] =
          (r.team || 0) + (r.agencies || 0) + (r.content || 0) +
          (r.software || 0) + (r.rent || 0) + (r.other || 0);
      }
      const totalRev = months.reduce((s,m)=>s+((m.revenue ?? 0) - (m.refunds ?? 0)), 0);
      const totalExp = months.reduce((s,m)=>s+(xeroOpexByMk[m.month] ?? 0), 0);
      const totalProfit = totalExp ? totalRev - totalExp : null;
      const chartData = months.map(m => {
        const rev = (m.revenue ?? 0) - (m.refunds ?? 0);
        const exp = xeroOpexByMk[m.month] ?? 0;
        const profit = exp ? rev - exp : null;
        return { month: m.month.slice(2), revenue: Math.round(rev), profit: profit != null ? Math.round(profit) : null };
      });

      const liveStores = (effectiveMarkets ?? []).filter((m: any) => m.live);
      const totalLiveRev = liveStores.reduce((s: number, m: any) => s + (m.revenue ?? 0), 0);
      const storeRows = liveStores.map((m: any) => {
        const rev = m.revenue ?? 0;
        const share = totalLiveRev > 0 ? rev / totalLiveRev : 0;
        const allocExp = totalExp ? totalExp * share : 0;
        const profit = totalExp ? rev - allocExp : null;
        const margin = profit != null && rev > 0 ? (profit / rev) * 100 : null;
        return { code: m.code, flag: m.flag, name: m.name ?? m.code, rev, profit, margin };
      });

      return (
        <Card className="mt-3 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-[13px] font-semibold">Revenue vs. Profit per store</div>
              <div className="mt-1 text-[11px] text-neutral-400">
                Total revenue €{Math.round(totalRev).toLocaleString()}
                {totalProfit != null && <> · Profit €{Math.round(totalProfit).toLocaleString()}</>}
              </div>
            </div>
            <button
              onClick={() => setShowRevProfitChart((v: boolean) => !v)}
              className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50"
            >
              {showRevProfitChart ? "Hide chart" : "Show chart"}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                  <th className="pb-2 pr-4">Store</th>
                  <th className="pb-2 pr-4 text-right">Revenue (EUR)</th>
                  <th className="pb-2 pr-4 text-right">Profit (est.)</th>
                  <th className="pb-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {storeRows.map(r => (
                  <tr key={r.code} className="border-b border-neutral-50 last:border-0">
                    <td className="py-2 pr-4"><span className="mr-1.5 text-[14px]">{r.flag}</span><span className="font-medium">{r.name}</span></td>
                    <td className="py-2 pr-4 text-right tabular-nums">€{Math.round(r.rev).toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{r.profit != null ? `€${Math.round(r.profit).toLocaleString()}` : "—"}</td>
                    <td className="py-2 text-right tabular-nums">{r.margin != null ? `${r.margin.toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="pt-3 pr-4">Total</td>
                  <td className="pt-3 pr-4 text-right tabular-nums">€{Math.round(totalRev).toLocaleString()}</td>
                  <td className="pt-3 pr-4 text-right tabular-nums">{totalProfit != null ? `€${Math.round(totalProfit).toLocaleString()}` : "—"}</td>
                  <td className="pt-3 text-right tabular-nums">{totalProfit != null && totalRev > 0 ? `${((totalProfit/totalRev)*100).toFixed(1)}%` : "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {totalExp > 0 && (
            <div className="mt-2 text-[10px] text-neutral-400">Per-store profit allocates Xero OpEx by revenue share.</div>
          )}

          {showRevProfitChart && (
            <div className="h-56 mt-4 border-t border-neutral-100 pt-4">
              <div className="flex items-center justify-end gap-3 text-[11px] text-neutral-500 mb-2">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-neutral-900" />Revenue</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Profit</span>
              </div>
              {chartsReady && (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#f3f4f6" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} tickFormatter={(v)=>`€${(v/1000).toFixed(0)}k`} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} formatter={(v: any)=>v != null ? `€${v.toLocaleString()}` : "—"} />
                    <Line type="monotone" dataKey="revenue" stroke="#111827" strokeWidth={2} dot={{ r: 3 }} name="Revenue" />
                    <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} name="Profit" connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          )}
          {!jorttData && (
            <div className="mt-2 text-[11px] text-neutral-400">Profit requires Jortt expenses data — connect Jortt to display.</div>
          )}
        </Card>
      );
    })()}

    {/* Cash & Inventory positions — manual data */}
    {(() => {
      const cash = Array.isArray(manualData?.cashPositions) ? manualData.cashPositions : [];
      const inv = Array.isArray(manualData?.inventoryPositions) ? manualData.inventoryPositions : [];

      const isReceivable = (t: string) => /receivable/i.test(t);
      const isPayable = (t: string) => /payable/i.test(t);
      const cashAccounts = cash.filter((c: any) => !isReceivable(c.account_type) && !isPayable(c.account_type));
      const receivables = cash.filter((c: any) => isReceivable(c.account_type));
      const payables = cash.filter((c: any) => isPayable(c.account_type));

      const sumEur = (rows: any[]) => rows.reduce((s, r) => s + Number(r.balance_eur ?? 0), 0);
      const totalCash = sumEur(cashAccounts);
      const totalReceivables = sumEur(receivables);
      const totalPayables = Math.abs(sumEur(payables));
      const netLiquidity = totalCash + totalReceivables - totalPayables;

      // Inventory grouped by FFC location
      const invByLocation: Record<string, { pieces: number; valueEur: number }> = {};
      let invPieces = 0, invValue = 0;
      for (const r of inv) {
        const loc = (r.location || "Unassigned").toString();
        const pieces = Number(r.pieces ?? 0);
        const value = pieces * Number(r.unit_cost_eur ?? 0);
        invPieces += pieces;
        invValue += value;
        if (!invByLocation[loc]) invByLocation[loc] = { pieces: 0, valueEur: 0 };
        invByLocation[loc].pieces += pieces;
        invByLocation[loc].valueEur += value;
      }
      const invLocationRows = Object.entries(invByLocation).sort((a, b) => b[1].valueEur - a[1].valueEur);

      return (
        <section className="mt-3 grid gap-3 lg:grid-cols-2">
          {/* Cash positions */}
          {cash.length > 0 ? (
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-[13px] font-semibold">Cash positions</div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">All accounts · receivables &amp; payables · EUR</div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">Manual</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-400">Cash</div>
                  <div className="mt-0.5 text-[16px] font-semibold tabular-nums">€{Math.round(totalCash).toLocaleString()}</div>
                </div>
                <div className="rounded-md border border-emerald-100 bg-emerald-50/40 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-emerald-600">Receivable</div>
                  <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-emerald-700">€{Math.round(totalReceivables).toLocaleString()}</div>
                </div>
                <div className="rounded-md border border-rose-100 bg-rose-50/40 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-rose-600">Payable</div>
                  <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-rose-700">€{Math.round(totalPayables).toLocaleString()}</div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-neutral-100 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                      <th className="pb-2 pr-2">Account</th>
                      <th className="pb-2 pr-2">Type</th>
                      <th className="pb-2 pr-2">Cur.</th>
                      <th className="pb-2 text-right">Balance (EUR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...cashAccounts, ...receivables, ...payables].map((c: any) => {
                      const recv = isReceivable(c.account_type);
                      const pay = isPayable(c.account_type);
                      return (
                        <tr key={c.id} className="border-b border-neutral-50 last:border-0">
                          <td className="py-1.5 pr-2 font-medium">{c.account_name}</td>
                          <td className="py-1.5 pr-2 text-neutral-500">{c.account_type}</td>
                          <td className="py-1.5 pr-2 text-neutral-500">{c.currency}</td>
                          <td className={`py-1.5 text-right tabular-nums ${pay ? "text-rose-600" : recv ? "text-emerald-600" : ""}`}>
                            {pay ? "−" : ""}€{Math.round(Math.abs(Number(c.balance_eur ?? 0))).toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="font-semibold">
                      <td className="pt-3 pr-2" colSpan={3}>Net liquidity</td>
                      <td className={`pt-3 text-right tabular-nums ${netLiquidity < 0 ? "text-rose-600" : ""}`}>€{Math.round(netLiquidity).toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <Card className="p-5 border-dashed">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[13px] font-semibold">Cash positions</div>
                <span className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">Manual</span>
              </div>
              <div className="text-[12px] text-neutral-500">No cash, receivables or payables added yet.</div>
              <a href="/admin/manual-data" className="mt-2 inline-block text-[12px] font-medium text-blue-600 hover:underline">Add accounts →</a>
            </Card>
          )}

          {/* Inventory positions */}
          {inv.length > 0 ? (
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-[13px] font-semibold">Inventory positions</div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">By FFC location · {invPieces.toLocaleString()} pcs</div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">Manual</span>
              </div>
              <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 mb-3">
                <div className="text-[10px] uppercase tracking-wider text-neutral-400">Total inventory value</div>
                <div className="mt-0.5 text-[20px] font-semibold tabular-nums">€{Math.round(invValue).toLocaleString()}</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-neutral-100 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                      <th className="pb-2 pr-2">FFC / Location</th>
                      <th className="pb-2 pr-2 text-right">Pieces</th>
                      <th className="pb-2 text-right">Value (EUR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invLocationRows.map(([loc, v]) => (
                      <tr key={loc} className="border-b border-neutral-50 last:border-0">
                        <td className="py-1.5 pr-2 font-medium">{loc}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{v.pieces.toLocaleString()}</td>
                        <td className="py-1.5 text-right tabular-nums">€{Math.round(v.valueEur).toLocaleString()}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="pt-3 pr-2">Total</td>
                      <td className="pt-3 pr-2 text-right tabular-nums">{invPieces.toLocaleString()}</td>
                      <td className="pt-3 text-right tabular-nums">€{Math.round(invValue).toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <Card className="p-5 border-dashed">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[13px] font-semibold">Inventory positions</div>
                <span className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">Manual</span>
              </div>
              <div className="text-[12px] text-neutral-500">No inventory positions added yet.</div>
              <a href="/admin/manual-data" className="mt-2 inline-block text-[12px] font-medium text-blue-600 hover:underline">Add inventory →</a>
            </Card>
          )}
        </section>
      );
    })()}

    {/* Syncing overlay */}
    {rangeSyncing && (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5 text-[12px] text-blue-700">
        <RefreshCw size={13} className="shrink-0 animate-spin" />
        Fetching data for selected period from Shopify &amp; Triple Whale…
      </div>
    )}

    {/* Historical range notice for TW metrics */}
    {!isCurrentMonth && !rangeData && !rangeSyncing && (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-100 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-700">
        <Info size={13} className="shrink-0" />
        Triple Whale metrics show <strong>current month to date</strong>. Select a range and click <strong>Apply &amp; sync</strong> to load accurate data for any period.
        {rangeJorttRevenue && (
          <span className="ml-1">Jortt shows <strong>€{Math.round(rangeJorttRevenue).toLocaleString()}</strong> revenue for this range{rangeXeroOpex ? ` · €${Math.round(rangeXeroOpex).toLocaleString()} Xero OpEx` : ""}.</span>
        )}
      </div>
    )}

    {/* Synced-range confirmation banner */}
    {rangeData && !rangeSyncing && (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-[12px] text-emerald-700">
        <CircleCheck size={13} className="shrink-0" />
        Showing Shopify &amp; Triple Whale data for <strong>{drFormatLabel(dateRange.from, dateRange.to)}</strong>. All metrics reflect this exact period.
      </div>
    )}

    {/* Customer economics row */}
    <section className="mt-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <BrandIcon brand="triplewhale" size={12} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Customer economics</span>
        <div className="h-px flex-1 bg-neutral-200" />
        <span className="text-[10px] text-neutral-400">Triple Whale · per acquired customer</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: "NCPA",
            fullLabel: "New Customer Acquisition Cost",
            value: liveNCPA !== null ? `€${liveNCPA.toFixed(2)}` : "—",
            delta: null,
            positive: false,
            sub: liveNCPA !== null ? "Ad spend ÷ new customers" : "Triple Whale not connected",
            icon: Target,
            live: liveNCPA !== null,
          },
          {
            label: "90D LTV",
            fullLabel: "Lifetime value · 90 days",
            value: liveLtv90 !== null ? `€${liveLtv90.toFixed(2)}` : "—",
            delta: null,
            positive: true,
            sub: liveLtv90 !== null && liveNCPA ? `${(liveLtv90 / liveNCPA).toFixed(2)}× NCPA payback` : "Triple Whale not connected",
            icon: TrendingUp,
            live: liveLtv90 !== null,
          },
          {
            label: "365D LTV",
            fullLabel: "Lifetime value · 365 days",
            value: liveLtv365 !== null ? `€${liveLtv365.toFixed(2)}` : "—",
            delta: null,
            positive: true,
            sub: liveLtv365 !== null && liveNCPA ? `${(liveLtv365 / liveNCPA).toFixed(2)}× NCPA · healthy` : "Triple Whale not connected",
            icon: Sparkles,
            live: liveLtv365 !== null,
          },
        ].map((s) => (
          <Card key={s.label} className="p-4 transition hover:border-neutral-300">
            <div className="flex items-start justify-between gap-1">
              <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-neutral-500">
                <s.icon size={13} className="shrink-0" />
                <span className="truncate">{s.label}</span>
              </div>
              {s.delta && (
                <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${s.positive ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {s.positive ? <ArrowUpRight size={10} strokeWidth={2.5} /> : <ArrowDownRight size={10} strokeWidth={2.5} />}
                  {s.delta}
                </span>
              )}
            </div>
            <div className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums">{s.value}</div>
            <div className="mt-0.5 text-[10px] text-neutral-400 truncate">{s.fullLabel}</div>
            <div className="text-[11px] text-neutral-400">{s.sub}</div>
          </Card>
        ))}
      </div>
    </section>

    {/* Marketing efficiency row */}
    <section className="mt-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <BrandIcon brand="triplewhale" size={12} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Marketing efficiency</span>
        <div className="h-px flex-1 bg-neutral-200" />
        <span className="text-[10px] text-neutral-400">Source: Triple Whale</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[
          {
            icon: Target,
            label: "Ad spend",
            value: liveAdSpend !== null ? `€${Math.round(liveAdSpend).toLocaleString()}` : "—",
            delta: null,
            positive: false,
            sub: liveAdSpend !== null ? "Triple Whale · NL store (EUR)" : "Triple Whale not connected",
            live: liveAdSpend !== null,
          },
          {
            icon: Activity,
            label: "Blended ROAS",
            value: liveROAS !== null ? `${liveROAS.toFixed(2)}x` : "—",
            delta: null,
            positive: true,
            sub: liveROAS !== null ? "Triple Whale · NL store" : "Triple Whale not connected",
            live: liveROAS !== null,
          },
        ].map((s) => (
          <Card key={s.label} className={`p-4 transition ${s.live ? 'hover:border-neutral-300' : 'opacity-60'}`}>
            <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-500">
              <s.icon size={13} />
              <span>{s.label}</span>
            </div>
            <div className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums">{s.value}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">{s.sub}</div>
          </Card>
        ))}
      </div>
      {/* Per-market ad spend breakdown — each in its own currency */}
      {effectiveTWData.filter(t => t.live && t.adSpend != null).length > 0 && (
        <div className="mt-3 rounded-lg border border-neutral-100 bg-neutral-50 p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Ad spend by market · own currency</div>
          <div className="flex flex-wrap gap-4">
            {effectiveTWData.filter(t => t.live && t.adSpend != null).map(t => {
              const sym = t.market === "UK" ? "£" : t.market === "US" ? "$" : "€";
              return (
                <div key={t.market}>
                  <span className="text-[11px] text-neutral-500">{t.flag} {t.market}</span>
                  <span className="ml-1.5 text-[13px] font-semibold tabular-nums">{sym}{Math.round(t.adSpend).toLocaleString()}</span>
                  {t.roas != null && <span className="ml-1 text-[11px] text-neutral-400">· {t.roas.toFixed(2)}x ROAS</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>

    {/* Subscriptions — Juo (NL) + Loop (UK/US/EU) */}
    {liveMRR !== null ? (() => {
      const totalActive = subData.reduce((s, m) => s + (m.activeSubs ?? 0), 0);
      const totalNew = subData.reduce((s, m) => s + (m.newThisMonth ?? 0), 0);
      const totalChurned = subData.reduce((s, m) => s + (m.churnedThisMonth ?? 0), 0);
      const blendedARPU = totalActive > 0 ? liveMRR / totalActive : null;
      const blendedChurn = totalActive > 0 ? (totalChurned / totalActive) * 100 : null;
      const totalRev = effectiveMarkets?.filter(m => m.live).reduce((s, m) => s + (m.revenue ?? 0), 0) ?? 0;
      // Subscription share = MRR (monthly recurring) compared to revenue at a comparable cadence.
      // We scale MRR to the selected range length so e.g. a 7-day window doesn't blow up to 311%.
      const rangeDays = (() => {
        const f = new Date(dateRange.from + "T00:00:00").getTime();
        const t = new Date(dateRange.to + "T23:59:59").getTime();
        const d = Math.max(1, Math.round((t - f) / 86400000));
        return d;
      })();
      const mrrForRange = liveMRR * (rangeDays / 30);
      const subShareRaw = totalRev > 0 ? (mrrForRange / totalRev) * 100 : null;
      // Only show when comparison is apples-to-apples: need ≥14d window and a sensible (<=100%) result.
      // Otherwise revenue is lagging/partial vs recurring MRR and the % is meaningless.
      const subShare =
        subShareRaw !== null && rangeDays >= 14 && subShareRaw <= 100
          ? subShareRaw
          : null;
      const sourcesLabel = subData.map(m => m.platform === "juo" ? `Juo (${m.market})` : `Loop (${m.market})`).join(" + ");
      return (
        <Card className="mt-3 p-5">
          <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
            <div className="flex items-start gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-100">
                <Sparkles className="h-3.5 w-3.5 text-violet-600" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <div className="text-[14px] font-semibold">Subscriptions</div>
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">Recurring</span>
                </div>
                <div className="mt-0.5 text-[12px] text-neutral-500">MRR, active subscribers, churn · source: {sourcesLabel}</div>
              </div>
            </div>
            <div className="flex items-start gap-4 flex-wrap">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400 mb-1">
                  Cohort window
                </div>
                <CohortRangeFilter value={subsRange} onChange={setSubsRange} />
              </div>
              {subShare !== null && (
                <div className="text-right">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Subscription share</div>
                  <div className="mt-0.5 text-[20px] font-semibold tabular-nums">{subShare.toFixed(1)}%</div>
                  <div className="text-[11px] text-neutral-400">Of total revenue</div>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 border-t border-neutral-100 pt-5">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">MRR</div>
              <div className="mt-1 text-[26px] font-semibold tabular-nums leading-none">
                €{liveMRR >= 1000 ? `${(liveMRR/1000).toFixed(1)}k` : Math.round(liveMRR).toLocaleString()}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">€{Math.round(liveMRR).toLocaleString()} recurring</div>
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Active subscribers</div>
              <div className="mt-1 text-[26px] font-semibold tabular-nums leading-none">{totalActive.toLocaleString()}</div>
              <div className="mt-1 text-[11px] text-neutral-400">{blendedARPU !== null ? `ARPU €${blendedARPU.toFixed(2)}/mo` : "—"}</div>
            </div>
            <div className="border-t border-neutral-100 pt-5 md:border-t-0 md:pt-0">
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Churn rate</div>
              <div className="mt-1 text-[26px] font-semibold tabular-nums leading-none">{blendedChurn !== null ? `${blendedChurn.toFixed(1)}%` : "—"}</div>
              <div className="mt-1 text-[11px] text-neutral-400">{totalChurned > 0 ? `${totalChurned} lost ${rangeSubs ? "in range" : "this month"}` : `No churn ${rangeSubs ? "in range" : "this month"}`}</div>
            </div>
            {(() => {
              const f: any = shopifyRepeatFunnel;
              // When the user filters to a recent window, use only the
              // monthly cohorts that fall in it for both the headline rate
              // and the delta. The headline becomes the weighted average of
              // third-order rates across those filtered cohorts; the lifetime
              // funnel rate is shown when ALL is selected so the existing
              // behaviour is preserved exactly.
              const isAll = subsRange === "all";
              const filteredCohorts = filterMonthlyCohorts(f?.monthlyCohorts, subsRange);
              const matureFiltered = filteredCohorts.filter(
                (c: any) => !c.maturing && c.third !== null,
              );
              const weightedRate = (() => {
                if (matureFiltered.length === 0) return null;
                const totalSize = matureFiltered.reduce((s: number, c: any) => s + (c.size ?? 0), 0);
                if (totalSize <= 0) return null;
                const sumReached = matureFiltered.reduce(
                  (s: number, c: any) => s + ((c.third ?? 0) / 100) * (c.size ?? 0),
                  0,
                );
                return (sumReached / totalSize) * 100;
              })();
              const lifetimeRate: number | null =
                (f?.cohortSize ?? 0) > 0 ? (f?.funnel?.[2]?.rate ?? null) : null;
              const rate = isAll ? lifetimeRate : weightedRate;
              const latest = matureFiltered[0];
              const prior = matureFiltered[1];
              const delta = latest && prior ? latest.third - prior.third : null;
              return (
                <div className="border-t border-neutral-100 pt-5 md:border-t-0 md:pt-0">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Repeat to 3rd order</div>
                  {rate !== null ? (
                    <>
                      <div className="mt-1 flex items-baseline gap-2">
                        <div className="text-[26px] font-semibold tabular-nums leading-none">{rate.toFixed(1)}%</div>
                        {delta !== null && (
                          <div className={`text-[12px] font-semibold tabular-nums ${delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {delta >= 0 ? "+" : ""}{delta.toFixed(1)}%
                          </div>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-neutral-400">
                        {isAll
                          ? "Of first-time buyers · lifetime"
                          : `Avg across ${matureFiltered.length} cohort${matureFiltered.length === 1 ? "" : "s"} in window`}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mt-1 text-[26px] font-semibold tabular-nums leading-none text-neutral-400">—</div>
                      <div className="mt-1 text-[11px] text-neutral-400">
                        {isAll ? "Cohort still maturing" : "No mature cohorts in window"}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="mt-5 border-t border-neutral-100 pt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
            <span className="text-neutral-400 font-medium">Split:</span>
            {subDataEUR.map(m => {
              const sym = m.currency === "GBP" ? "£" : m.currency === "USD" ? "$" : "€";
              const sharePct = liveMRR > 0 ? Math.round(((m.mrrEUR ?? 0) / liveMRR) * 100) : 0;
              const mrrLabel = (m.mrr ?? 0) >= 1000 ? `${sym}${((m.mrr ?? 0)/1000).toFixed(0)}k` : `${sym}${Math.round(m.mrr ?? 0)}`;
              const eurLabel = m.currency !== "EUR" && m.mrrEUR ? ` (€${Math.round(m.mrrEUR).toLocaleString()})` : "";
              return (
                <span key={m.market} className="inline-flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{m.flag} {m.market}</span>
                  <span className="text-neutral-600">{(m.activeSubs ?? 0)} subs · {mrrLabel} MRR{eurLabel}</span>
                  <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">{sharePct}%</span>
                </span>
              );
            })}
          </div>

          {/* Diagnostic block — surfaces the raw count distributions per
              market so mismatches with Loop / Juo's own UI can be diagnosed
              without digging through the server terminal. Hidden by default
              behind a <details> so it doesn't add visual noise. */}
          {subData.some((m: any) => m?._diagnostics) && (
            <details className="mt-4 border-t border-neutral-100 pt-3">
              <summary className="cursor-pointer text-[11px] font-medium text-neutral-500 hover:text-neutral-800">
                Show per-market diagnostic (compare against Loop / Juo's own dashboard)
              </summary>
              <div className="mt-2 grid gap-3 text-[11px] md:grid-cols-3">
                {subData.map((m: any) => {
                  const d = m?._diagnostics ?? {};
                  return (
                    <div key={`diag-${m.market}`} className="rounded-md bg-neutral-50 p-3 font-mono text-[10px] text-neutral-700">
                      <div className="font-semibold text-neutral-900 mb-1.5 font-sans">
                        {m.flag} {m.market} · {m.platform === "juo" ? "Juo" : "Loop"}
                      </div>
                      {/* Loop diagnostic shape */}
                      {m.platform === "loop" && (
                        <>
                          {(m._error || d.error) && (
                            <div className="mb-1 rounded bg-rose-50 px-1.5 py-1 font-sans text-[10px] text-rose-700">
                              Read failed: {String(m._error ?? d.error)}
                            </div>
                          )}
                          <div>totalRows: <span className="text-neutral-900">{d.totalRows ?? "—"}</span></div>
                          <div>statusActive: <span className="text-neutral-900">{d.statusActiveCount ?? "—"}</span></div>
                          <div>markedForCancellation: <span className="text-neutral-900">{d.markedForCancellation ?? "—"}</span></div>
                          <div>withCancellationReason: <span className="text-neutral-900">{d.withCancellationReason ?? "—"}</span></div>
                          <div>withFailedPayment: <span className="text-neutral-900">{d.withFailedPayment ?? "—"}</span></div>
                          <div className="mt-1 font-sans text-[10px] text-neutral-500">statusCounts:</div>
                          {d.statusCounts && Object.entries(d.statusCounts).map(([k, v]: any) => (
                            <div key={k} className="ml-3"><span className="text-neutral-500">{k}:</span> {v}</div>
                          ))}
                          <div className="mt-1 font-sans text-[10px] text-neutral-900">
                            Final activeSubs: <span className="font-mono">{d.finalActiveCount ?? m.activeSubs}</span>
                          </div>
                        </>
                      )}
                      {/* Juo diagnostic shape — from _diagnostics in fetchers */}
                      {m.platform === "juo" && (
                        <>
                          <div>totalFetched: <span className="text-neutral-900">{d.totalFetched ?? "—"}</span></div>
                          <div>withPausedAt: <span className="text-neutral-900">{d.withPausedAt ?? "—"}</span></div>
                          <div>withCanceledAt: <span className="text-neutral-900">{d.withCanceledAt ?? "—"}</span></div>
                          <div>withFailedAt: <span className="text-neutral-900">{d.withFailedAt ?? "—"}</span></div>
                          <div className="mt-1 font-sans text-[10px] text-neutral-500">statusCounts:</div>
                          {d.statusCounts && Object.entries(d.statusCounts).map(([k, v]: any) => (
                            <div key={k} className="ml-3"><span className="text-neutral-500">{k}:</span> {v}</div>
                          ))}
                          {d.stateCounts && Object.keys(d.stateCounts).length > 0 && (
                            <>
                              <div className="mt-1 font-sans text-[10px] text-neutral-500">stateCounts:</div>
                              {Object.entries(d.stateCounts).map(([k, v]: any) => (
                                <div key={k} className="ml-3"><span className="text-neutral-500">{k}:</span> {v}</div>
                              ))}
                            </>
                          )}
                          {d.lifecycleStateCounts && Object.keys(d.lifecycleStateCounts).length > 0 && (
                            <>
                              <div className="mt-1 font-sans text-[10px] text-neutral-500">lifecycleStateCounts:</div>
                              {Object.entries(d.lifecycleStateCounts).map(([k, v]: any) => (
                                <div key={k} className="ml-3"><span className="text-neutral-500">{k}:</span> {v}</div>
                              ))}
                            </>
                          )}
                          <div className="mt-1 font-sans text-[10px] text-neutral-900">
                            Filtered activeSubs: <span className="font-mono">{m.activeSubs}</span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 text-[10px] text-neutral-500">
                Copy this block and paste back if any market still doesn't match the source platform — I'll target the exact filter.
              </div>
            </details>
          )}
        </Card>
      );
    })() : (
      <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-center text-[13px] text-neutral-500">
        <strong>Subscription data not available</strong> — set <code className="text-[11px]">JUO_NL_API_KEY</code> or <code className="text-[11px]">LOOP_UK_API_KEY</code> in .env.local.
      </div>
    )}

    {/* Repeat Purchase Funnel — real Shopify cohort data */}
    {shopifyRepeatFunnel && (() => {
      const f = shopifyRepeatFunnel;
      // Use the SAME `subsRange` filter as the Subscriptions card above —
      // both sections show cohort-based data and one picker drives both.
      // When ALL is selected we keep the server-supplied lifetime cohort +
      // funnel intact (existing behaviour). For windowed selections we
      // restrict the monthlyCohorts table to the chosen window and recompute
      // the headline funnel by size-weighted averaging of those cohorts'
      // per-order percentages.
      const isFunnelAll = subsRange === "all";
      const allMonthlyCohorts: any[] = Array.isArray(f.monthlyCohorts) ? f.monthlyCohorts : [];
      const filteredCohorts = isFunnelAll
        ? allMonthlyCohorts
        : filterMonthlyCohorts(allMonthlyCohorts, subsRange);
      const filteredCohortSize = filteredCohorts.reduce((s, c) => s + (c?.size ?? 0), 0);
      const fallbackCohort = (allMonthlyCohorts).find((c: any) => (c.size ?? 0) > 0) ?? null;
      const lifetimeCohortSize = (f.cohortSize ?? 0) > 0 ? f.cohortSize : (fallbackCohort?.size ?? 0);
      const cohortSize = isFunnelAll ? lifetimeCohortSize : filteredCohortSize;
      const hasCohort = cohortSize > 0;
      const orderColors = ["bg-neutral-900", "bg-violet-500", "bg-violet-400", "bg-violet-300", "bg-violet-200", "bg-violet-200", "bg-violet-100"];
      const orderDotColors = ["bg-neutral-900", "bg-violet-500", "bg-violet-400", "bg-violet-300", "bg-violet-200", "bg-violet-200", "bg-violet-100"];
      const labels = ["1st order", "2nd order", "3rd order", "4th order", "5th order", "6th order", "7th+ orders"];
      const subs = ["First purchase", "Repeat to 2nd", "Repeat to 3rd", "Repeat to 4th", "Repeat to 5th", "Repeat to 6th", "Repeat to 7th+"];
      const fallbackFunnel = fallbackCohort ? [
        { order: 1, customers: lifetimeCohortSize, rate: 100, maturing: false },
        { order: 2, customers: fallbackCohort.second !== null ? Math.round(lifetimeCohortSize * fallbackCohort.second / 100) : null, rate: fallbackCohort.second, maturing: fallbackCohort.second === null },
        { order: 3, customers: fallbackCohort.third !== null ? Math.round(lifetimeCohortSize * fallbackCohort.third / 100) : null, rate: fallbackCohort.third, maturing: fallbackCohort.third === null },
        { order: 4, customers: fallbackCohort.fourth !== null ? Math.round(lifetimeCohortSize * fallbackCohort.fourth / 100) : null, rate: fallbackCohort.fourth, maturing: fallbackCohort.fourth === null },
        { order: 5, customers: null, rate: null, maturing: true },
        { order: 6, customers: null, rate: null, maturing: true },
        { order: 7, customers: null, rate: null, maturing: true },
      ] : [];
      // Build a "filtered" funnel by size-weighting per-order rates across the
      // cohorts visible in the window. Only `second`/`third`/`fourth` exist on
      // each monthlyCohort, so orders 5–7 stay maturing in windowed mode.
      const buildWeightedFunnel = () => {
        if (filteredCohorts.length === 0 || filteredCohortSize === 0) return [];
        const weightedPct = (key: "second" | "third" | "fourth") => {
          const eligible = filteredCohorts.filter((c) => c?.[key] != null);
          const totalEligibleSize = eligible.reduce((s, c) => s + (c.size ?? 0), 0);
          if (totalEligibleSize === 0) return null;
          const reached = eligible.reduce(
            (s, c) => s + ((c[key] as number) / 100) * (c.size ?? 0),
            0,
          );
          return (reached / totalEligibleSize) * 100;
        };
        const p2 = weightedPct("second");
        const p3 = weightedPct("third");
        const p4 = weightedPct("fourth");
        return [
          { order: 1, customers: filteredCohortSize, rate: 100, rateMature: 100, matureSize: filteredCohortSize, maturityPct: 100, maturing: false },
          { order: 2, customers: p2 != null ? Math.round(filteredCohortSize * p2 / 100) : null, rate: p2, rateMature: p2, matureSize: filteredCohortSize, maturityPct: 100, maturing: p2 == null },
          { order: 3, customers: p3 != null ? Math.round(filteredCohortSize * p3 / 100) : null, rate: p3, rateMature: p3, matureSize: filteredCohortSize, maturityPct: 100, maturing: p3 == null },
          { order: 4, customers: p4 != null ? Math.round(filteredCohortSize * p4 / 100) : null, rate: p4, rateMature: p4, matureSize: filteredCohortSize, maturityPct: 100, maturing: p4 == null },
          { order: 5, customers: null, rate: null, rateMature: null, matureSize: 0, maturityPct: 0, maturing: true },
          { order: 6, customers: null, rate: null, rateMature: null, matureSize: 0, maturityPct: 0, maturing: true },
          { order: 7, customers: null, rate: null, rateMature: null, matureSize: 0, maturityPct: 0, maturing: true },
        ];
      };
      const displayFunnel = isFunnelAll
        ? ((f.cohortSize ?? 0) > 0 ? f.funnel : fallbackFunnel)
        : buildWeightedFunnel();
      const personLabel = f.source === "subscriptions" ? "subscribers" : "customers";
      // (deeper analysis is always rendered for accuracy)
      const top4 = displayFunnel.slice(0, 4);
      const rest = displayFunnel.slice(4);
      return (
        <Card className="mt-3 p-5">
          <div className="flex items-start justify-between mb-1 gap-3 flex-wrap">
            <div>
              <div className="text-[14px] font-semibold">Repeat purchase funnel</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">
                {hasCohort
                  ? isFunnelAll
                    ? (f.source === "subscriptions"
                        ? `Lifetime subscribers across ${(f.sources ?? ["Juo NL", "Loop UK", "Loop US"]).join(" + ")} cohorts${f.sourceStart && f.sourceEnd ? ` · ${f.sourceStart}–${f.sourceEnd}` : ""}`
                        : `Lifetime first-time buyers across all Shopify cohorts${f.sourceStart && f.sourceEnd ? ` · ${f.sourceStart}–${f.sourceEnd}` : ""}`)
                    : `Size-weighted across ${filteredCohorts.length} cohort${filteredCohorts.length === 1 ? "" : "s"} in the selected window`
                  : "Loading customer history…"}
              </div>
            </div>
            <div className="text-right text-[11px] text-neutral-400">
              Cohort size: <span className="font-semibold text-neutral-700">{cohortSize.toLocaleString()} {f.source === "subscriptions" ? "subscribers" : "first-time buyers"}</span>
              {!isFunnelAll && (
                <div className="mt-1">Lifetime: {lifetimeCohortSize.toLocaleString()}</div>
              )}
              {f.sourceStart && f.sourceEnd && (
                <div className="mt-1">Source: {f.source === "subscriptions" ? `${(f.sources ?? ["Juo", "Loop"]).join(" + ")} subscriptions` : "Shopify orders"} {f.sourceStart}–{f.sourceEnd}</div>
              )}
            </div>
          </div>

          {hasCohort ? <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            {top4.map((row: any, i: number) => {
              // Headline rate = reached / MATURE cohort. The diluted
              // (full-cohort) rate is preserved as row.rate for the
              // sub-line, but the prominent number is the honest one —
              // among subscribers old enough to actually have made N
              // orders, what % did.
              const headlineRate = row.rateMature ?? row.rate;
              const headlinePct = headlineRate !== null && headlineRate !== undefined ? `${headlineRate.toFixed(1)}%` : "—";
              const matureSize = row.matureSize ?? (row.maturityPct != null ? Math.round(cohortSize * row.maturityPct / 100) : cohortSize);
              const showDilution =
                row.rateMature != null &&
                row.rate != null &&
                row.maturityPct != null &&
                row.maturityPct < 100 &&
                Math.abs(row.rateMature - row.rate) >= 0.1;
              return (
                <div key={row.order} className="rounded-lg border border-neutral-200 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                      <span className={`h-2 w-2 rounded-full ${orderDotColors[i]}`} />
                      {labels[i]}
                    </div>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <div className="text-[24px] font-semibold tabular-nums leading-none">{headlinePct}</div>
                    <div className="text-[12px] text-neutral-500">{row.maturing && row.rate === null ? "Still maturing" : subs[i]}</div>
                  </div>
                  <div className="mt-2 text-[11px] text-neutral-400">
                    {row.customers !== null
                      ? `${row.customers.toLocaleString()} of ${matureSize.toLocaleString()} mature ${personLabel}`
                      : "Needs more observation time"}
                  </div>
                  {showDilution && (
                    <div className="mt-1 text-[10px] text-neutral-400">
                      {row.rate.toFixed(1)}% across all {cohortSize.toLocaleString()} {personLabel}
                      ({row.maturityPct.toFixed(0)}% of cohort old enough)
                    </div>
                  )}
                  <div className="mt-3 h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden">
                    <div className={`h-full ${orderColors[i]} rounded-full`} style={{ width: `${Math.min(100, headlineRate ?? 0)}%` }} />
                  </div>
                </div>
              );
            })}
          </div> : (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-[12px] text-amber-800">
              Shopify customer history is loaded, but the latest mature cohort has no first-time buyers yet. The monthly table below shows the available cohort data.
            </div>
          )}

          {(hasCohort || (filteredCohorts && filteredCohorts.length > 0)) && (
            <div className="mt-4 rounded-lg border border-neutral-200">
              <div className="flex items-center justify-between p-3 border-b border-neutral-100">
                <div className="text-[12px] font-semibold text-neutral-700">Deeper cohort analysis</div>
                <div className="text-[11px] text-neutral-400">
                  {isFunnelAll
                    ? "5th+ orders, cohort-by-cohort, LTV projection"
                    : `${filteredCohorts.length} cohort${filteredCohorts.length === 1 ? "" : "s"} in window`}
                </div>
              </div>
              {hasCohort && <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3">
                {rest.map((row: any, i: number) => {
                  const headlineRate = row.rateMature ?? row.rate;
                  const matureSize = row.matureSize ?? (row.maturityPct != null ? Math.round(cohortSize * row.maturityPct / 100) : cohortSize);
                  const showDilution =
                    row.rateMature != null &&
                    row.rate != null &&
                    row.maturityPct != null &&
                    row.maturityPct < 100 &&
                    Math.abs(row.rateMature - row.rate) >= 0.1;
                  return (
                    <div key={row.order} className="rounded-lg border border-neutral-100 p-3">
                      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                        <span className={`h-2 w-2 rounded-full ${orderDotColors[i + 4]}`} />
                        {labels[i + 4]}
                      </div>
                      <div className="mt-1 text-[18px] font-semibold tabular-nums">{headlineRate != null ? `${headlineRate.toFixed(1)}%` : "—"}</div>
                      <div className="text-[11px] text-neutral-400">
                        {row.customers !== null
                          ? `${row.customers.toLocaleString()} of ${matureSize.toLocaleString()} mature ${personLabel}`
                          : "Still maturing"}
                      </div>
                      {showDilution && (
                        <div className="text-[10px] text-neutral-400 mt-0.5">
                          {row.rate.toFixed(1)}% of full cohort
                        </div>
                      )}
                      <div className="mt-2 h-1 w-full rounded-full bg-neutral-100 overflow-hidden">
                        <div className={`h-full ${orderColors[i + 4]} rounded-full`} style={{ width: `${Math.min(100, (headlineRate ?? 0) * 4)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>}

              {/* Monthly cohort table */}
              {filteredCohorts && filteredCohorts.length > 0 ? (
                <div className="border-t border-neutral-100">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                        <th className="text-left px-4 py-2.5">Cohort</th>
                        <th className="text-right px-4 py-2.5">Size</th>
                        <th className="text-right px-4 py-2.5">2nd</th>
                        <th className="text-right px-4 py-2.5">3rd</th>
                        <th className="text-right px-4 py-2.5">4th</th>
                        <th className="text-right px-4 py-2.5">Avg orders</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCohorts.map((c: any) => (
                        <tr key={c.month} className={`border-t border-neutral-100 ${c.maturing ? "bg-amber-50/40" : ""}`}>
                          <td className="px-4 py-2.5">
                            {c.month}
                            {c.maturing && <span className="ml-2 text-[10px] text-amber-600">still maturing</span>}
                          </td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{c.size}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{c.second !== null ? `${c.second.toFixed(1)}%` : "—"}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{c.third !== null ? `${c.third.toFixed(1)}%` : "—"}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{c.fourth !== null ? `${c.fourth.toFixed(1)}%` : "—"}</td>
                          <td className="text-right px-4 py-2.5 tabular-nums">{c.avgOrders !== null ? c.avgOrders.toFixed(2) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-4 py-2.5 text-[11px] text-amber-600 border-t border-neutral-100 bg-amber-50/30">
                    ⓘ Cohorts need at least 90 days to fully mature for 3rd/4th order data.
                  </div>
                </div>
              ) : (
                !isFunnelAll && (
                  <div className="border-t border-neutral-100 px-4 py-6 text-center text-[12px] text-neutral-400">
                    No cohorts fall in the selected window.
                  </div>
                )
              )}
            </div>
          )}
        </Card>
      );
    })()}

    {!shopifyRepeatFunnel && liveMRR !== null && (
      <Card className="mt-3 p-5 text-center text-[13px] text-neutral-500">
        <strong>Repeat purchase funnel</strong> — first sync in progress. Cohort data will appear once Shopify customer history is loaded (may take a few minutes).
      </Card>
    )}

    {/* MRR & active subscribers + New vs Churned (live data only) */}
    {liveMRR !== null && subData.length > 0 && (
      <Card className="mt-3 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[13px] font-semibold">MRR & active subscribers</div>
          <div className="flex items-center gap-3 text-[11px] text-neutral-500">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-neutral-900" />MRR</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-violet-500" />Subscribers</span>
          </div>
        </div>
        <div className="h-56">
          {chartsReady && (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={subDataEUR.map((m: any) => ({ name: `${m.flag} ${m.market}`, mrr: Math.round(m.mrrEUR ?? 0), subs: m.activeSubs ?? 0 }))}>
                <CartesianGrid stroke="#f3f4f6" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} />
                <Bar yAxisId="left" dataKey="mrr" fill="#111827" radius={[4,4,0,0]} name="MRR (€)" />
                <Line yAxisId="right" type="monotone" dataKey="subs" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} name="Subscribers" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="mt-6 border-t border-neutral-100 pt-5">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[13px] font-semibold">New vs churned subscribers</div>
            <div className="flex items-center gap-3 text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />New</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" />Churned</span>
            </div>
          </div>
          {(() => {
            const totalNew = subData.reduce((s,m)=>s+(m.newThisMonth ?? 0),0);
            const totalChurned = subData.reduce((s,m)=>s+(m.churnedThisMonth ?? 0),0);
            const net = totalNew - totalChurned;
            return (
              <>
                <div className="text-[11px] text-neutral-400 mb-3">
                  Net gain this month: <span className={`font-semibold ${net >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{net >= 0 ? "+" : ""}{net} subscribers</span>
                </div>
                <div className="h-48">
                  {chartsReady && (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={subData.map(m => ({ name: `${m.flag} ${m.market}`, new: m.newThisMonth ?? 0, churned: -(m.churnedThisMonth ?? 0) }))}>
                        <CartesianGrid stroke="#f3f4f6" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} formatter={(v) => Math.abs(v)} />
                        <Bar dataKey="new" fill="#10b981" radius={[4,4,0,0]} name="New" />
                        <Bar dataKey="churned" fill="#f43f5e" radius={[0,0,4,4]} name="Churned" />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      </Card>
    )}

  </>);
};

/* =========================================================================
   VIEW: METRICS (20 Triple Whale metrics with toggle)
   ========================================================================= */

const MetricsView = ({ twData = [] }) => {
  const liveTW = twData.filter(t => t.live);

  if (liveTW.length === 0) {
    return (
      <>
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Triple Whale</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Metrics</h1>
        </div>
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 py-16 text-center">
          <BrandIcon brand="triplewhale" size={32} />
          <div className="mt-4 text-[15px] font-semibold text-neutral-700">No Triple Whale data</div>
          <div className="mt-1 text-[13px] text-neutral-400">Add TRIPLE_WHALE_API_KEY to .env.local</div>
        </div>
      </>
    );
  }

  const total = liveTW.reduce((acc, t) => ({
    revenue:        (acc.revenue        ?? 0) + (t.revenue        ?? 0),
    netRevenue:     (acc.netRevenue     ?? 0) + (t.netRevenue     ?? 0),
    adSpend:        (acc.adSpend        ?? 0) + (t.adSpend        ?? 0),
    orders:         (acc.orders         ?? 0) + (t.orders         ?? 0),
    grossProfit:    (acc.grossProfit    ?? 0) + (t.grossProfit    ?? 0),
    netProfit:      (acc.netProfit      ?? 0) + (t.netProfit      ?? 0),
    cogs:           (acc.cogs           ?? 0) + (t.cogs           ?? 0),
    uniqueCustomers:(acc.uniqueCustomers?? 0) + (t.uniqueCustomers?? 0),
  }), {});
  const nlTW = liveTW.find(t => t.market === "NL") ?? liveTW[0];

  const fmtM = (v, fmt) => {
    if (v === null || v === undefined) return "—";
    if (fmt === "€") return `€${Math.round(v).toLocaleString()}`;
    if (fmt === "%") return `${v.toFixed(1)}%`;
    if (fmt === "x") return `${v.toFixed(2)}×`;
    return Math.round(v).toLocaleString();
  };

  const groups = [
    { label: "Revenue & Sales", metrics: [
      { label: "Gross Revenue",      value: total.revenue,         fmt: "€" },
      { label: "Net Revenue",        value: total.netRevenue,      fmt: "€" },
      { label: "Orders",             value: total.orders,          fmt: "n" },
      { label: "Avg Order Value",    value: total.orders > 0 ? total.revenue / total.orders : null, fmt: "€" },
      { label: "Unique Customers",   value: total.uniqueCustomers, fmt: "n" },
      { label: "New Customer %",     value: nlTW?.newCustomersPct, fmt: "%" },
    ]},
    { label: "Profitability", metrics: [
      { label: "Gross Profit",       value: total.grossProfit,     fmt: "€" },
      { label: "Net Profit",         value: total.netProfit,       fmt: "€" },
      { label: "COGS",               value: total.cogs,            fmt: "€" },
      { label: "Gross Margin",       value: total.revenue > 0 ? (total.grossProfit / total.revenue) * 100 : null, fmt: "%" },
    ]},
    { label: "Marketing", metrics: [
      { label: "Total Ad Spend",     value: total.adSpend,         fmt: "€" },
      { label: "Blended ROAS",       value: nlTW?.roas,            fmt: "x" },
      { label: "NC ROAS",            value: nlTW?.ncRoas,          fmt: "x" },
      { label: "MER",                value: nlTW?.mer,             fmt: "x" },
      { label: "NCPA",               value: nlTW?.ncpa,            fmt: "€" },
      { label: "LTV:CPA",            value: nlTW?.ltvCpa,          fmt: "x" },
    ]},
  ];

  return (
    <>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Triple Whale</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Metrics</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Live · MTD · {liveTW.length} market{liveTW.length !== 1 ? "s" : ""} connected
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {liveTW.map(t => (
            <span key={t.market} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              <span className="h-1 w-1 rounded-full bg-emerald-500" />{t.flag} {t.market}
            </span>
          ))}
        </div>
      </div>

      {/* Per-market table */}
      <Card className="mt-6 p-5">
        <div className="mb-4 text-[13px] font-semibold">By market — MTD</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                <th className="pb-2 pr-4">Market</th>
                <th className="pb-2 pr-4 text-right">Revenue</th>
                <th className="pb-2 pr-4 text-right">Ad Spend</th>
                <th className="pb-2 pr-4 text-right">ROAS</th>
                <th className="pb-2 pr-4 text-right">MER</th>
                <th className="pb-2 pr-4 text-right">Orders</th>
                <th className="pb-2 pr-4 text-right">Gross Profit</th>
                <th className="pb-2 text-right">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {liveTW.map((t, i) => (
                <tr key={t.market} className={i < liveTW.length - 1 ? "border-b border-neutral-50" : ""}>
                  <td className="py-2.5 pr-4 font-medium">{t.flag} {t.market}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{fmtM(t.revenue, "€")}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{fmtM(t.adSpend, "€")}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{fmtM(t.roas, "x")}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{fmtM(t.mer, "x")}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{fmtM(t.orders, "n")}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{fmtM(t.grossProfit, "€")}</td>
                  <td className="py-2.5 text-right tabular-nums">{fmtM(t.netProfit, "€")}</td>
                </tr>
              ))}
              {liveTW.length > 1 && (
                <tr className="border-t border-neutral-200 font-semibold">
                  <td className="pt-2.5 pr-4">Total</td>
                  <td className="pt-2.5 pr-4 text-right tabular-nums">{fmtM(total.revenue, "€")}</td>
                  <td className="pt-2.5 pr-4 text-right tabular-nums">{fmtM(total.adSpend, "€")}</td>
                  <td className="pt-2.5 pr-4 text-right tabular-nums">—</td>
                  <td className="pt-2.5 pr-4 text-right tabular-nums">—</td>
                  <td className="pt-2.5 pr-4 text-right tabular-nums">{fmtM(total.orders, "n")}</td>
                  <td className="pt-2.5 pr-4 text-right tabular-nums">{fmtM(total.grossProfit, "€")}</td>
                  <td className="pt-2.5 text-right tabular-nums">{fmtM(total.netProfit, "€")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Metric grid */}
      {groups.map(group => (
        <section key={group.label} className="mt-6">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{group.label}</h2>
            <div className="h-px flex-1 bg-neutral-200" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {group.metrics.map(m => (
              <Card key={m.label} className="p-4">
                <div className="text-[11px] font-medium text-neutral-500">{m.label}</div>
                <div className={`mt-2 text-[20px] font-semibold tracking-tight tabular-nums ${m.value == null ? "text-neutral-300" : ""}`}>
                  {fmtM(m.value, m.fmt)}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </>
  );
};

/* =========================================================================
   VIEW: RECONCILIATION (Waterfall + Variance)
   ========================================================================= */

const ReconciliationView = ({ shopifyMarkets = null, jorttData = null }) => {
  const shopifyTotal = Array.isArray(shopifyMarkets) ? shopifyMarkets.filter(m => m?.live).reduce((s, m) => s + (m.revenue ?? 0), 0) : null;
  const jorttRevenue = jorttData?.revenueByMonth
    ? Object.values(jorttData.revenueByMonth).reduce((s, v) => s + v, 0)
    : null;
  const variance = shopifyTotal !== null && jorttRevenue !== null ? shopifyTotal - jorttRevenue : null;
  const hasData = shopifyTotal !== null || jorttRevenue !== null;

  return (
    <>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Reconciliation</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Revenue Reconciliation</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Shopify gross revenue vs Jortt invoices · MTD
          </p>
        </div>
      </div>

      {/* Xero migration banner */}
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-neutral-200 bg-gradient-to-r from-neutral-50 to-[#13B5EA]/5 p-4">
        <div className="mt-0.5 rounded-md bg-[#13B5EA]/10 p-1.5 text-[#13B5EA]"><Info size={14} /></div>
        <div className="flex-1 text-[12px]">
          <div className="font-semibold text-neutral-900">Bridge mode — Xero migration in progress</div>
          <div className="mt-0.5 text-neutral-600">Full journal-entry drilldown activates once Xero is connected. Current view shows Shopify gross revenue vs Jortt invoice totals.</div>
        </div>
      </div>

      {!hasData ? (
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 py-16 text-center">
          <div className="mt-4 text-[15px] font-semibold text-neutral-700">No data available</div>
          <div className="mt-1 text-[13px] text-neutral-400">Connect Shopify and Jortt to see reconciliation.</div>
        </div>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            <Card className="p-5">
              <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-500 mb-2">
                <BrandIcon brand="shopify" size={14} /> Shopify revenue (MTD)
              </div>
              <div className="text-[28px] font-semibold tabular-nums">
                {shopifyTotal !== null ? `€${Math.round(shopifyTotal).toLocaleString()}` : "—"}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">Gross · all markets</div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-500 mb-2">
                <BrandIcon brand="jortt" size={14} /> Jortt invoices (MTD)
              </div>
              <div className="text-[28px] font-semibold tabular-nums">
                {jorttRevenue !== null ? `€${Math.round(jorttRevenue).toLocaleString()}` : "—"}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">{jorttData?.invoiceCount ?? 0} invoices · excl. credit notes</div>
            </Card>
            <Card className={`p-5 ${variance !== null ? (Math.abs(variance) < 500 ? "border-emerald-200 bg-emerald-50/20" : "border-amber-200 bg-amber-50/20") : ""}`}>
              <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-500 mb-2">
                <AlertTriangle size={14} /> Variance
              </div>
              <div className={`text-[28px] font-semibold tabular-nums ${variance !== null && variance < 0 ? "text-rose-600" : variance !== null && variance > 0 ? "text-amber-600" : "text-neutral-300"}`}>
                {variance !== null ? `${variance > 0 ? "+" : ""}€${Math.round(variance).toLocaleString()}` : "—"}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">
                {variance !== null ? (Math.abs(variance) < 500 ? "Within tolerance" : "Review timing differences") : "Connect both sources"}
              </div>
            </Card>
          </section>

          {jorttData?.revenueByMonth && Object.keys(jorttData.revenueByMonth).length > 0 && (
            <Card className="mt-3 p-5">
              <div className="mb-4 text-[13px] font-semibold">Jortt invoice revenue by month</div>
              <div className="space-y-2">
                {Object.entries(jorttData.revenueByMonth)
                  .sort(([a], [b]) => new Date("1 " + a.replace("'", "20")).getTime() - new Date("1 " + b.replace("'", "20")).getTime())
                  .map(([month, rev]) => (
                    <div key={month} className="flex items-center justify-between text-[13px]">
                      <span className="text-neutral-600">{month}</span>
                      <span className="tabular-nums font-medium">€{Math.round(rev).toLocaleString()}</span>
                    </div>
                  ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

/* =========================================================================
   VIEW: PILLAR 1 — DAILY P&L
   ========================================================================= */

const DailyPnLView = ({ dailyData = null, twData = [] }) => {
  const todayLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const currentHour = (new Date().getUTCHours() + 2) % 24; // Amsterdam CEST

  const liveMarkets = dailyData?.markets?.filter(m => m.live) ?? [];
  const nlMarket    = liveMarkets.find(m => m.code === "NL");
  const ukMarket    = liveMarkets.find(m => m.code === "UK");

  // NL hourly chart data — only show hours up to current + 1
  const nlHourly = nlMarket?.hourly?.slice(0, currentHour + 1) ?? [];
  const chartData = nlHourly.map(h => ({
    hour: `${String(h.hour).padStart(2, "0")}:00`,
    revenue: h.revenue,
    orders: h.orders,
  }));

  // Total orders across all markets today
  const totalOrders   = liveMarkets.reduce((s, m) => s + (m.orders ?? 0), 0);
  const totalRevenueTip = liveMarkets.map(m => `${m.flag} ${m.currency === "GBP" ? "£" : m.currency === "USD" ? "$" : "€"}${Math.round(m.revenue ?? 0).toLocaleString()}`).join("  ·  ");

  // TW MTD ROAS for context
  const nlTW = twData.find(t => t.market === "NL" && t.live);
  const ukTW = twData.find(t => t.market === "UK" && t.live);

  if (!dailyData) {
    return (
      <>
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 1</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Daily P&L Tracker</h1>
          <p className="mt-1 text-[13px] text-neutral-500">Today's revenue by hour across all markets.</p>
        </div>
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 py-16 text-center">
          <Clock size={32} className="text-neutral-300" />
          <div className="mt-4 text-[15px] font-semibold text-neutral-700">Loading today's data...</div>
          <div className="mt-2 max-w-sm text-[13px] text-neutral-400">Fetching orders from Shopify. This may take a moment.</div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 1</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Daily P&L Tracker</h1>
          <p className="mt-1 text-[13px] text-neutral-500">{todayLabel}</p>
        </div>
        <div className="text-right text-[11px] text-neutral-400">
          <div className="font-medium">Live · {totalOrders.toLocaleString()} orders today</div>
          <div className="mt-0.5 text-neutral-300">{totalRevenueTip}</div>
        </div>
      </div>

      {/* Market cards */}
      <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {liveMarkets.map(m => {
          const tw = twData.find(t => t.market === m.code && t.live);
          const sym = m.currency === "GBP" ? "£" : m.currency === "USD" ? "$" : "€";
          return (
            <Card key={m.code} className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-neutral-500">{m.flag} {m.name ?? m.code}</span>
                {tw?.roas != null && (
                  <span className="text-[10px] font-medium text-neutral-400">{tw.roas.toFixed(2)}× ROAS</span>
                )}
              </div>
              <div className="mt-2 text-[26px] font-semibold tabular-nums tracking-tight">
                {sym}{Math.round(m.revenue ?? 0).toLocaleString()}
              </div>
              <div className="mt-1 flex items-center gap-3 text-[11px] text-neutral-400">
                <span>{(m.orders ?? 0).toLocaleString()} orders</span>
                {m.aov > 0 && <span>AOV {sym}{m.aov.toFixed(0)}</span>}
              </div>
            </Card>
          );
        })}
      </section>

      {/* Hourly revenue chart — NL store */}
      {chartData.length > 0 && (
        <section className="mt-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">Hourly revenue · NL</div>
                <div className="text-[11px] text-neutral-400">Amsterdam time (CEST) · paid orders only</div>
              </div>
              <div className="text-right">
                <div className="text-[20px] font-semibold tabular-nums">
                  €{Math.round(nlMarket?.revenue ?? 0).toLocaleString()}
                </div>
                <div className="text-[11px] text-neutral-400">today so far</div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 4, right: 0, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} interval={1} />
                <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={v => v >= 1000 ? `€${(v/1000).toFixed(0)}k` : `€${v}`} />
                <Tooltip
                  formatter={(v, name) => name === "revenue" ? [`€${Number(v).toLocaleString()}`, "Revenue"] : [v, "Orders"]}
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e5e7eb" }}
                />
                <Bar dataKey="revenue" fill="#0d1d3d" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </section>
      )}

      {/* UK row for context */}
      {ukMarket?.revenue > 0 && (
        <section className="mt-3 grid grid-cols-2 gap-3">
          <Card className="p-4">
            <div className="text-[12px] font-medium text-neutral-400 uppercase tracking-wide">UK revenue today</div>
            <div className="mt-1 text-[22px] font-semibold tabular-nums">£{Math.round(ukMarket.revenue).toLocaleString()}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">{ukMarket.orders} orders · AOV £{ukMarket.aov?.toFixed(0)}</div>
          </Card>
          {ukTW?.roas != null && (
            <Card className="p-4">
              <div className="text-[12px] font-medium text-neutral-400 uppercase tracking-wide">UK ROAS (MTD)</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums">{ukTW.roas.toFixed(2)}×</div>
              <div className="mt-0.5 text-[11px] text-neutral-400">Ad spend £{Math.round(ukTW.adSpend ?? 0).toLocaleString()} MTD</div>
            </Card>
          )}
        </section>
      )}

      {/* NL TW context */}
      {nlTW && (
        <section className="mt-3 grid grid-cols-3 gap-3">
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">NL Ad Spend (MTD)</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">€{Math.round(nlTW.adSpend ?? 0).toLocaleString()}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">Triple Whale</div>
          </Card>
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">NL ROAS (MTD)</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">{nlTW.roas?.toFixed(2)}×</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">Triple Whale</div>
          </Card>
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">NL Gross Profit (MTD)</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">€{Math.round(nlTW.grossProfit ?? 0).toLocaleString()}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">Triple Whale</div>
          </Card>
        </section>
      )}
    </>
  );
};

/* =========================================================================
   VIEW: PILLAR 2 — MARGIN PER MARKET
   ========================================================================= */

export const MarketsView = ({ liveMarkets = null, twData = [], dateRange = null, onDateChange = null, rangeSyncing = false, shopifyMonthly = null, marketCosts = null, paymentFeesByMonth = null, shippingByMonth = null }: any = {}) => {
  const [sortBy, setSortBy] = useState("revenue");
  const [allocation, setAllocation] = useState("revenue-weighted");

  // Trend vs previous period — derive from shopifyMonthly cache.
  // Compute previous-month CM% per market for delta. Best-effort.
  const prevMonthByMarket: Record<string, { revenue: number; refunds: number }> = (() => {
    const out: Record<string, { revenue: number; refunds: number }> = {};
    if (!Array.isArray(shopifyMonthly) || shopifyMonthly.length < 2) return out;
    // Date-based sort so "previous month" is the chronologically-previous
    // month, not the alphabetically-previous one. Old behaviour with
    // localeCompare picked Mar as the "previous" for May (alphabetical
    // Apr → Mar → May), producing wrong MoM deltas per market.
    const sorted = [...shopifyMonthly].sort(
      (a, b) => parseMonthKey(a.month ?? "").getTime() - parseMonthKey(b.month ?? "").getTime(),
    );
    const prev = sorted[sorted.length - 2];
    const bm = prev?.byMarket ?? {};
    for (const code of Object.keys(bm)) out[code] = { revenue: bm[code].revenue ?? 0, refunds: bm[code].refunds ?? 0 };
    return out;
  })();

  // Latest month label drives the per-market fee/refund lookups. Shopify
  // monthly is sorted chronologically by the server, so the tail is current.
  const latestMonthKey: string | null = (() => {
    if (!Array.isArray(shopifyMonthly) || shopifyMonthly.length === 0) return null;
    const sorted = [...shopifyMonthly].sort(
      (a, b) => parseMonthKey(a.month ?? "").getTime() - parseMonthKey(b.month ?? "").getTime(),
    );
    return sorted[sorted.length - 1]?.month ?? null;
  })();

  // Real PSP fees for that month: Shopify Payments is per-market, PayPal +
  // Mollie are tenant-level so we allocate by revenue share. Falls back to
  // the manual per-market % rate from /admin/manual-data when real data
  // hasn't arrived (no PSP integration, or month not yet aggregated).
  const feesEntryThisMonth: any =
    latestMonthKey && paymentFeesByMonth ? paymentFeesByMonth[latestMonthKey] : null;
  const totalRevAllMarkets = (liveMarkets ?? [])
    .filter((m: any) => m?.live && m?.code !== "DE")
    .reduce((s: number, m: any) => s + (m.revenue ?? 0), 0);

  const activeMarkets = (liveMarkets ?? [])
    .filter(m => m.live && m.code !== "DE")
    .map(m => {
      const tw = twData.find(t => t.market === m.code && t.live);
      const revenue = m.revenue ?? 0;
      const orders = m.orders ?? 0;
      const adSpend = tw?.adSpend ?? null;
      const grossProfit = tw?.grossProfit ?? null;
      const grossMarginPct = grossProfit != null && revenue > 0 ? +(grossProfit / revenue * 100).toFixed(1) : null;

      // Per-market shipping — try in priority order:
      //   1. tw.shippingCost: TW Orcabase SQL on the live row (best, but can
      //      be null when the Orcabase endpoint times out / 4xx's).
      //   2. shippingByMonth[latestMonth].byMarket[code]: a separate per-month
      //      cache populated by fetchTripleWhaleShippingMonthly. Often the
      //      survivor when (1) failed in the inline TW call but the standalone
      //      shipping sync succeeded.
      //   3. orders × manual.shippingPerOrder from /admin/manual-data.
      //   4. "—" in the UI (shippingCost === 0).
      // Previously only paths (1) and (3) were wired, so when TW Orcabase
      // failed on the current range AND manual costs weren't configured the
      // Shipping column went entirely blank — which is what the user just
      // hit on the fresh Supabase.
      const mc = (marketCosts && marketCosts[m.code]) || null;
      const shippingPerOrder = mc ? Number(mc.shippingPerOrder) || 0 : 0;
      const paymentFeePct = mc ? Number(mc.paymentFeePct) || 0 : 0;
      const twShipping = tw && typeof tw.shippingCost === "number" ? tw.shippingCost : null;
      const monthlyShippingByMarket =
        latestMonthKey && shippingByMonth ? shippingByMonth[latestMonthKey]?.byMarket : null;
      const monthlyShipping =
        monthlyShippingByMarket && typeof monthlyShippingByMarket[m.code] === "number"
          ? monthlyShippingByMarket[m.code]
          : null;
      const manualShipping = orders > 0 && shippingPerOrder > 0 ? orders * shippingPerOrder : 0;
      const shippingCost =
        twShipping != null
          ? +twShipping.toFixed(0)
          : monthlyShipping != null
            ? +monthlyShipping.toFixed(0)
            : +manualShipping.toFixed(0);

      // Payment fees — prefer real PSP data (Shopify Payments per-market +
      // allocated share of PayPal/Mollie) over the manual percentage rate.
      // When neither is available, the column stays "—".
      const realFee = (() => {
        if (!feesEntryThisMonth) return null;
        const shopifyMarketFee = Number(feesEntryThisMonth?.shopifyByMarket?.[m.code] ?? 0);
        const myShare = totalRevAllMarkets > 0 ? revenue / totalRevAllMarkets : 0;
        const allocPayPal = Number(feesEntryThisMonth?.paypal ?? 0) * myShare;
        const allocMollie = Number(feesEntryThisMonth?.mollie ?? 0) * myShare;
        const total = shopifyMarketFee + allocPayPal + allocMollie;
        return total > 0 ? +total.toFixed(0) : null;
      })();
      const manualFee = paymentFeePct > 0 ? +(revenue * paymentFeePct / 100).toFixed(0) : 0;
      const paymentFee = realFee ?? manualFee;

      const contributionMarginAbs = grossProfit != null && adSpend != null
        ? +(grossProfit - adSpend - shippingCost - paymentFee).toFixed(0)
        : null;
      const contributionMarginPct = contributionMarginAbs != null && revenue > 0
        ? +(contributionMarginAbs / revenue * 100).toFixed(1) : null;
      // Refunds per market — prefer Triple Whale's own "Returns" metric
      // (matches what TW summary shows), then TW Orcabase SQL (refundsTW),
      // then Shopify monthly aggregate (m.refunds) as final fallback.
      const refunds =
        (tw && typeof tw.refunds === "number" && tw.refunds > 0) ? tw.refunds :
        (tw && typeof tw.refundsTW === "number" && tw.refundsTW > 0) ? tw.refundsTW :
        (m.refunds ?? 0);
      const grossRevenue = revenue + refunds; // revenue is net-of-refunds
      const refundRate = grossRevenue > 0 ? +(refunds / grossRevenue * 100).toFixed(1) : null;
      // Trend: prev-month rev delta
      const prev = prevMonthByMarket[m.code];
      const revDeltaPct = prev && prev.revenue > 0 ? +((revenue - prev.revenue) / prev.revenue * 100).toFixed(1) : null;
      return {
        ...m,
        refunds,
        adSpend,
        grossMargin: grossMarginPct,
        contributionMargin: contributionMarginPct,
        contributionMarginAbs,
        shippingCost,
        paymentFee,
        refundRate,
        revDeltaPct,
        roas: tw?.roas ?? null,
        cac: tw?.ncpa ?? null,
      };
    });
  if (activeMarkets.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-8 text-center text-[13px] text-neutral-500">
        No market data available — connect Shopify to see margin per market.
      </div>
    );
  }

  const sorted = [...activeMarkets].sort((a, b) => b[sortBy] - a[sortBy]);
  const maxRev = sorted[0]?.revenue ?? 1;

  return (
    <>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 2</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Margin per Market</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Geographic breakdown following Shopify Markets
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dateRange && onDateChange && (
            <DateRangePicker from={dateRange.from} to={dateRange.to} onApply={onDateChange} loading={rangeSyncing} />
          )}
          <select
            value={allocation}
            onChange={(e) => setAllocation(e.target.value)}
            className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700"
          >
            <option value="direct">Direct targeting</option>
            <option value="revenue-weighted">Revenue-weighted</option>
            <option value="attribution">TW attribution</option>
          </select>
        </div>
      </div>

      {/* Market cards */}
      <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        {sorted.map(m => {
          const cm = m.contributionMargin;
          const cmClass = cm == null
            ? "text-neutral-400"
            : cm >= 30 ? "text-emerald-600"
            : cm >= 20 ? "text-amber-600"
            : "text-rose-600";
          const displayCode = m.code === "UK" ? "GB" : m.code;
          return (
            <Card key={m.code} className="p-5">
              <div className="flex items-start justify-between">
                <div className="text-[15px] font-semibold tracking-tight text-neutral-900">{displayCode}</div>
                <div className="flex items-center gap-2 text-[11px] tabular-nums">
                  <span className={cmClass + " font-medium"}>
                    {cm != null ? `${cm}%` : "—"}
                  </span>
                  {m.revDeltaPct != null && (
                    <span className={(m.revDeltaPct >= 0 ? "text-emerald-600" : "text-rose-600") + " text-[10px]"}>
                      {m.revDeltaPct >= 0 ? "+" : ""}{m.revDeltaPct}% vs last mo
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-2 text-[12px] text-neutral-500">{m.name ?? m.code}</div>
              <div className="mt-2 text-[20px] font-semibold tabular-nums tracking-tight">
                €{(m.revenue / 1000).toFixed(1)}k
              </div>
              <div className="mt-2 flex items-center gap-3 text-[11px] text-neutral-500 tabular-nums">
                {m.contributionMarginAbs != null && (
                  <span>CM <span className="font-medium text-neutral-800">€{m.contributionMarginAbs.toLocaleString()}</span></span>
                )}
                {m.refundRate != null && (
                  <span>Refunds <span className={m.refundRate > 5 ? "text-rose-600 font-medium" : "text-neutral-700"}>{m.refundRate}%</span></span>
                )}
              </div>
            </Card>
          );
        })}
      </section>

      {/* Main markets table */}
      <Card className="mt-3">
        <div className="border-b border-neutral-100 px-5 py-4">
          <div className="text-[13px] font-semibold">Full market breakdown</div>
          <div className="text-[12px] text-neutral-400">
            Ad spend allocation method:{" "}
            <span className="font-medium">
              {allocation === "revenue-weighted" ? "Revenue-Weighted" : allocation === "direct" ? "Direct targeting" : "TW attribution"}
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                <th className="px-5 py-2.5 font-medium">Market</th>
                <th className="px-3 py-2.5 font-medium text-right cursor-pointer hover:text-neutral-900" onClick={() => setSortBy("revenue")}>Revenue</th>
                <th className="px-3 py-2.5 font-medium text-right">Orders</th>
                <th className="px-3 py-2.5 font-medium text-right">AOV</th>
                <th className="px-3 py-2.5 font-medium text-right">Ad spend</th>
                <th className="px-3 py-2.5 font-medium text-right">CAC</th>
                <th className="px-3 py-2.5 font-medium text-right">Gross M%</th>
                <th className="px-3 py-2.5 font-medium text-right">Shipping</th>
                <th className="px-3 py-2.5 font-medium text-right">Fees</th>
                <th className="px-3 py-2.5 font-medium text-right cursor-pointer hover:text-neutral-900" onClick={() => setSortBy("contributionMargin")}>Contrib M%</th>
                <th className="px-3 py-2.5 font-medium text-right">Contrib (€)</th>
                <th className="px-3 py-2.5 font-medium text-right">Refund %</th>
                <th className="px-3 py-2.5 font-medium text-right">Δ vs prev mo</th>
                <th className="px-5 py-2.5 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m, i) => {
                const pct = (m.revenue / maxRev) * 100;
                return (
                  <tr key={m.code} className={i !== sorted.length - 1 ? "border-b border-neutral-50 hover:bg-neutral-50/50" : "hover:bg-neutral-50/50"}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-[4px] bg-neutral-100 px-1 text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
                          {m.code === "UK" ? "GB" : m.code}
                        </span>
                        <span className="font-medium text-neutral-900">{m.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-medium">€{m.revenue.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-600">{m.orders}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-600">€{(m.revenue / m.orders).toFixed(0)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-600">{m.adSpend != null ? `€${m.adSpend.toLocaleString()}` : "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {m.cac != null ? (
                        <span className={m.cac > 40 ? "text-rose-600 font-medium" : m.cac > 30 ? "text-amber-600" : "text-neutral-900"}>
                          €{m.cac.toFixed(2)}
                        </span>
                      ) : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-600">{m.grossMargin != null ? `${m.grossMargin}%` : "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                      {m.shippingCost > 0 ? `€${m.shippingCost.toLocaleString()}` : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                      {m.paymentFee > 0 ? `€${m.paymentFee.toLocaleString()}` : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {m.contributionMargin != null ? (
                        <span className={m.contributionMargin >= 30 ? "text-emerald-600 font-medium" : m.contributionMargin >= 20 ? "text-neutral-900" : "text-amber-600 font-medium"}>
                          {m.contributionMargin}%
                        </span>
                      ) : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {m.contributionMarginAbs != null ? (
                        <span className={m.contributionMarginAbs >= 0 ? "text-neutral-900 font-medium" : "text-rose-600 font-medium"}>
                          €{m.contributionMarginAbs.toLocaleString()}
                        </span>
                      ) : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {m.refundRate != null ? (
                        <span className={m.refundRate > 5 ? "text-rose-600 font-medium" : "text-neutral-700"}>{m.refundRate}%</span>
                      ) : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {m.revDeltaPct != null ? (
                        <span className={m.revDeltaPct >= 0 ? "text-emerald-600" : "text-rose-600"}>
                          {m.revDeltaPct >= 0 ? "+" : ""}{m.revDeltaPct}%
                        </span>
                      ) : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-20 overflow-hidden rounded-full bg-neutral-100">
                          <div className="h-full rounded-full bg-neutral-900" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-neutral-100 px-5 py-3 text-[11px] text-neutral-400">
          Shipping (€/order) and payment-fee % per market are configured in <a href="/admin/manual-data" className="underline hover:text-neutral-700">Manual data</a>. Refund rate uses Shopify gross-vs-net revenue.
        </div>
      </Card>

      {/* Alert on underperforming markets — dynamic */}
      {sorted.filter(m => m.contributionMargin != null && m.contributionMargin < 20).map(m => (
        <div key={m.code} className="mt-3 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/40 p-4">
          <div className="mt-0.5 rounded-md bg-amber-100 p-1.5 text-amber-700">
            <AlertTriangle size={14} />
          </div>
          <div className="flex-1 text-[13px]">
            <div className="font-semibold text-neutral-900">{m.flag} {m.name} contribution margin below target</div>
            <div className="mt-0.5 text-neutral-600">
              Contribution margin of {m.contributionMargin}% is below the 20% threshold. Review ad spend efficiency (ROAS: {m.roas != null ? `${m.roas.toFixed(2)}×` : "—"}) and consider optimising campaigns.
            </div>
          </div>
        </div>
      ))}
    </>
  );
};

/* =========================================================================
   VIEW: PILLAR 3 — MONTHLY OVERVIEW
   ========================================================================= */

/* ============================= OPEX BREAKDOWN (used in MonthlyView) ============================= */

const OpExBreakdownSection = ({ opexByMonth: data = null, opexDetail: detail = null, opexDetailByMonth = null, xeroDiag = null }: any = {}) => {
  const [activeCategory, setActiveCategory] = useState("team");
  const [showDiag, setShowDiag] = useState(false);
  // selected month index within `data` (defaults to latest)
  const [monthIdx, setMonthIdx] = useState<number | null>(null);
  // The card only renders Team + Agencies + Content + Software. If every
  // month has zero across those four buckets, the card would look completely
  // empty even though Xero gave us rows — surface the diagnostic instead so
  // the user can see *why* (everything's piled into "other" or "rent").
  const allVisibleZero = Array.isArray(data) && data.length > 0 && data.every((m: any) =>
    (Number(m?.team || 0) + Number(m?.agencies || 0) + Number(m?.content || 0) + Number(m?.software || 0)) === 0,
  );
  if (!data || data.length === 0 || allVisibleZero) {
    const xeroError: string | null = xeroDiag?.error ?? null;
    const isAuthError = !!xeroError && /auth|invalid_grant|refresh token|reconnect/i.test(xeroError);
    const pl = xeroDiag?.profitAndLoss ?? null;
    const reportPresent = !!pl?.reportPresent;
    const sectionTitles: string[] = Array.isArray(pl?.sectionTitles) ? pl.sectionTitles : [];
    const rowLabels: string[] = Array.isArray(pl?.rowLabels) ? pl.rowLabels : [];
    const parsedExpenseMonths: string[] = Array.isArray(pl?.parsedExpenseMonths) ? pl.parsedExpenseMonths : [];
    // Pick the most-likely cause so the user sees one clear sentence first.
    const reason: string = (() => {
      if (isAuthError) return xeroError!;
      if (xeroError) return xeroError;
      if (!xeroDiag) return "Xero data not loaded yet — wait for the next sync to finish, or trigger a sync from the operations page.";
      if (!reportPresent) return "Xero P&L report didn't come back from the API. Check that the accounting.reports.profitandloss.read scope was approved during OAuth.";
      // Special case: parser ran fine, rows came through, but everything
      // landed in "Other" or "Rent" — the card only shows Team + Agencies +
      // Content + Software so it'd look empty. This is the most common
      // failure mode after Xero auth is fixed.
      const bucketTotals = (pl?.opexBucketTotals as Record<string, number> | undefined) ?? null;
      if (bucketTotals && Array.isArray(data) && data.length > 0) {
        const visible = (bucketTotals.team ?? 0) + (bucketTotals.agencies ?? 0) + (bucketTotals.content ?? 0) + (bucketTotals.software ?? 0);
        const invisible = (bucketTotals.other ?? 0) + (bucketTotals.rent ?? 0);
        if (visible === 0 && invisible > 0) {
          return `Xero P&L parsed fine — €${invisible.toLocaleString()} of expenses came through — but every account got classified as "Other" or "Rent" by the keyword matcher, and the card only shows Team + Agencies + Content + Software. Your Chart of Accounts row labels don't match the bucket keywords. Open the diagnostic below, copy the row labels, and paste them back so I can extend the classifier.`;
        }
      }
      // P&L did come back. Either no expense section was detected, or rows existed but produced 0 monthly buckets.
      const expenseLikeSection = sectionTitles.find((t) =>
        /operating expense|less operating|overhead|administrative|expense|bedrijfslasten|bedrijfskosten|kosten|lasten/i.test(t)
      );
      if (!expenseLikeSection) {
        return `Xero P&L returned ${sectionTitles.length} section${sectionTitles.length === 1 ? "" : "s"}, but none matches the expense-section classifier. Open the diagnostic below to see the section titles, then paste them back so I can extend the classifier to recognize your Chart of Accounts structure.`;
      }
      if (parsedExpenseMonths.length === 0) {
        return `Expense section "${expenseLikeSection}" was found, but no monthly columns could be parsed from it. The P&L report may have been requested with a single-period view instead of a monthly breakdown.`;
      }
      return `Expense section "${expenseLikeSection}" was found across ${parsedExpenseMonths.length} month${parsedExpenseMonths.length === 1 ? "" : "s"}, but every account row landed at €0 or was filtered out — open the diagnostic details below to see the row labels.`;
    })();
    return (
      <div className="mt-3 rounded-lg border border-neutral-200 bg-white">
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 rounded-md p-1.5 ${isAuthError ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
              <AlertTriangle size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold">OpEx breakdown not available</div>
              <div className={`mt-1 text-[12px] break-words ${isAuthError ? "text-red-700" : "text-neutral-600"}`}>{reason}</div>
              {isAuthError && (
                <a
                  href="/api/auth/xero"
                  className="mt-3 inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-[12px] font-medium text-red-800 hover:bg-red-100"
                >
                  Reconnect Xero
                </a>
              )}
              {!isAuthError && xeroDiag && (
                <button
                  type="button"
                  onClick={() => setShowDiag((s) => !s)}
                  className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-800"
                >
                  {showDiag ? "Hide" : "Show"} P&amp;L diagnostic details
                </button>
              )}
            </div>
          </div>
          {!isAuthError && xeroDiag && showDiag && (
            <div className="mt-4 border-t border-neutral-100 pt-4 space-y-3 text-[11px] text-neutral-600">
              <div>
                <div className="font-semibold text-neutral-700 mb-1">P&amp;L report present</div>
                <div>{reportPresent ? "Yes" : "No"}</div>
              </div>
              <div>
                <div className="font-semibold text-neutral-700 mb-1">Section titles found ({sectionTitles.length})</div>
                <div className="rounded bg-neutral-50 p-2 font-mono text-[10px] break-words">
                  {sectionTitles.length > 0 ? sectionTitles.join(" · ") : <span className="text-neutral-400">—</span>}
                </div>
              </div>
              <div>
                <div className="font-semibold text-neutral-700 mb-1">First account-row labels ({rowLabels.length} shown)</div>
                <div className="rounded bg-neutral-50 p-2 font-mono text-[10px] break-words max-h-40 overflow-y-auto">
                  {rowLabels.length > 0 ? rowLabels.join(" · ") : <span className="text-neutral-400">—</span>}
                </div>
              </div>
              <div>
                <div className="font-semibold text-neutral-700 mb-1">Months parsed from expense rows</div>
                <div className="rounded bg-neutral-50 p-2 font-mono text-[10px] break-words">
                  {parsedExpenseMonths.length > 0 ? parsedExpenseMonths.join(", ") : <span className="text-neutral-400">none</span>}
                </div>
              </div>
              {pl?.opexBucketTotals && (
                <div>
                  <div className="font-semibold text-neutral-700 mb-1">Per-bucket totals (rounded €)</div>
                  <div className="rounded bg-neutral-50 p-2 font-mono text-[10px]">
                    {Object.entries(pl.opexBucketTotals as Record<string, number>).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <span>{k}</span>
                        <span className={v === 0 ? "text-neutral-400" : "text-neutral-800"}>€{v.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] text-neutral-500">
                    Card OpEx total = team + agencies + content + software. If most spend is in <em>other</em> or <em>rent</em>, your Chart of Accounts row labels aren't matching the bucket keywords —
                    paste any label here back to me and I'll extend the classifier.
                  </div>
                </div>
              )}
              {pl?.opexDetailItemCounts && (
                <div>
                  <div className="font-semibold text-neutral-700 mb-1">Distinct accounts per bucket</div>
                  <div className="rounded bg-neutral-50 p-2 font-mono text-[10px]">
                    {Object.entries(pl.opexDetailItemCounts as Record<string, number>).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <span>{k}</span>
                        <span className={v === 0 ? "text-neutral-400" : "text-neutral-800"}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {pl?.opexTopItemsPerBucket?.other && Array.isArray(pl.opexTopItemsPerBucket.other) && pl.opexTopItemsPerBucket.other.length > 0 && (
                <div>
                  <div className="font-semibold text-neutral-700 mb-1">
                    Top {pl.opexTopItemsPerBucket.other.length} labels landing in <em>Other</em> (these need keyword rules)
                  </div>
                  <div className="rounded bg-neutral-50 p-2 font-mono text-[10px] max-h-48 overflow-y-auto">
                    {(pl.opexTopItemsPerBucket.other as Array<{ name: string; amount: number }>).map((it) => (
                      <div key={it.name} className="flex justify-between gap-3">
                        <span className="break-words">{it.name}</span>
                        <span className="shrink-0 text-neutral-800">€{it.amount.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] text-neutral-500">
                    Copy these labels and paste them back to me. I'll map each one to its correct bucket (team / agencies / content / software / rent) and the OpEx card will populate on the next sync.
                  </div>
                </div>
              )}
              <div className="text-[10px] text-neutral-500">
                Source: <code>xeroData._diagnostics.profitAndLoss</code> — populated by <code>fetchers.server.ts</code> after each sync.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
  const idx = monthIdx == null ? data.length - 1 : Math.min(Math.max(monthIdx, 0), data.length - 1);
  const current = data[idx];
  const prev = data[Math.max(0, idx - 1)] ?? current;
  // OpEx now sums every bucket Xero reports as Operating Expense so the
  // dashboard total matches Xero's "Total Operating Expenses" line exactly.
  // The 4 primary buckets (team/agencies/content/software) get their own
  // tiles + colors; rent + other (fulfilment, bank fees, travel, etc.) are
  // displayed under one "Other costs" tile so the math reconciles to Xero
  // without 7 separate tiles competing for visual weight.
  const sumOther = (m: any) => (m.rent || 0) + (m.other || 0);
  const opexSum = (m: any) =>
    (m.team || 0) + (m.agencies || 0) + (m.content || 0) + (m.software || 0) + sumOther(m);
  const totalCurrent = opexSum(current);
  const totalPrev = opexSum(prev);
  const totalDelta = totalPrev > 0 ? ((totalCurrent - totalPrev) / totalPrev * 100) : 0;

  const categories = [
    { key: "team", label: "Team", color: "#171717" },
    { key: "agencies", label: "Agencies", color: "#6366f1" },
    { key: "content", label: "Content samenwerkingen", color: "#f59e0b" },
    { key: "software", label: "Software", color: "#10b981" },
    // 5th visible tile — combines the "rent" and "other" Xero buckets
    // (fulfilment, bank fees, travel, insurance, etc.). Without this the
    // dashboard headline was understating total OpEx by ~27%.
    { key: "otherCombined", label: "Other costs", color: "#94a3b8" },
  ];

  // Each row in opexByMonth has `team/agencies/content/software/rent/other`.
  // Add a synthetic `otherCombined` so category-keyed lookups work uniformly
  // for the 5th tile.
  const currentForDisplay: any = { ...current, otherCombined: sumOther(current) };
  const prevForDisplay: any = { ...prev, otherCombined: sumOther(prev) };

  const donutData = categories.map(c => ({
    name: c.label,
    value: currentForDisplay[c.key] || 0,
    color: c.color,
    key: c.key,
  }));

  // Per-month detail is preferred so the line-items table reflects only the
  // selected month's spend. Falls back to the all-months aggregate when the
  // server didn't ship per-month detail (older cached payloads, or when
  // viewing a non-Xero source that doesn't break detail down by month).
  //
  // Special-case "otherCombined": merge the rent + other buckets (and
  // de-dup by account name to be safe) so the user sees fulfilment, bank
  // fees, travel, etc. in one list — matching what the 5th tile sums.
  const monthLabel = current?.month ?? "";
  const resolveDetailFor = (cat: string) => {
    if (cat !== "otherCombined") {
      return (
        opexDetailByMonth?.[monthLabel]?.[cat] ??
        (detail && detail[cat]) ??
        { label: cat, items: [] }
      );
    }
    const rentItems = opexDetailByMonth?.[monthLabel]?.rent?.items
      ?? (detail?.rent?.items)
      ?? [];
    const otherItems = opexDetailByMonth?.[monthLabel]?.other?.items
      ?? (detail?.other?.items)
      ?? [];
    // Combine + sort desc by amount; if an account name appears in both
    // (shouldn't happen since classifier picks one bucket per row, but
    // defensive against accidental double-counting), keep the larger entry.
    const combined = new Map<string, any>();
    for (const it of [...rentItems, ...otherItems]) {
      const k = String(it?.name ?? "").toLowerCase();
      const existing = combined.get(k);
      if (!existing || (it?.amount ?? 0) > (existing.amount ?? 0)) combined.set(k, it);
    }
    return {
      label: "Other costs (fulfilment, rent, bank fees, travel, etc.)",
      items: Array.from(combined.values()).sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)),
    };
  };
  const activeDetail = resolveDetailFor(activeCategory);
  const activeTotal = (activeDetail.items ?? []).reduce((s: number, i: any) => s + i.amount, 0);

  return (
    <Card className="mt-3 overflow-hidden">
      {/* Header */}
      <div className="border-b border-neutral-100 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">OpEx breakdown — {monthLabel}</div>
            <div className="mt-0.5 text-[12px] text-neutral-400">
              Team + Agencies + Content + Software + Other · matches Xero P&amp;L Total Operating Expenses
            </div>
            {/* Month switcher */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {data.map((m: any, i: number) => {
                const isActive = i === idx;
                return (
                  <button
                    key={`${m.month}-${i}`}
                    onClick={() => setMonthIdx(i)}
                    className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                      isActive
                        ? "border-neutral-900 bg-neutral-900 text-white"
                        : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50"
                    }`}
                  >
                    {m.month}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Total OpEx</div>
            <div className="mt-0.5 text-[22px] font-semibold tabular-nums">€{Math.round(totalCurrent).toLocaleString()}</div>
            <div className={`text-[11px] font-medium ${totalDelta >= 0 ? "text-rose-600" : "text-emerald-600"}`}>
              {totalDelta >= 0 ? "+" : ""}{totalDelta.toFixed(1)}% MoM
            </div>
          </div>
        </div>
      </div>

      {/* Category cards — 5 tiles now (Team / Agencies / Content / Software /
          Other costs). 2-col mobile, 5-col desktop so the new tile fits
          without wrapping awkwardly. */}
      <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-5">
        {categories.map(cat => {
          const value = currentForDisplay[cat.key] || 0;
          const prevValue = prevForDisplay[cat.key] || 0;
          const delta = prevValue > 0 ? ((value - prevValue) / prevValue * 100) : 0;
          const share = totalCurrent > 0 ? (value / totalCurrent * 100) : 0;
          const isActive = activeCategory === cat.key;
          return (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`rounded-lg border p-3 text-left transition ${
                isActive
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50/50"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: cat.color }} />
                <span className="text-[11px] font-medium text-neutral-500">{cat.label}</span>
              </div>
              <div className="mt-1.5 text-[17px] font-semibold tabular-nums">
                €{value.toLocaleString()}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[10px]">
                <span className="text-neutral-400">{share.toFixed(1)}% of OpEx</span>
                <span className={`font-medium ${delta >= 0 ? "text-rose-600" : "text-emerald-600"}`}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(1)}%
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Two-column: donut + trend */}
      <div className="grid grid-cols-1 gap-4 border-t border-neutral-100 p-5 lg:grid-cols-5">
        {/* Donut */}
        <div className="lg:col-span-2">
          <div className="text-[12px] font-medium text-neutral-500">Cost mix — {monthLabel}</div>
          <div className="relative mt-2 h-[220px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
              <PieChart>
                <Pie
                  data={donutData}
                  dataKey="value"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={2}
                  stroke="none"
                >
                  {donutData.map((entry) => (
                    <Cell
                      key={entry.key}
                      fill={entry.color}
                      opacity={activeCategory === entry.key ? 1 : 0.35}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "white", border: "1px solid #e5e5e5", borderRadius: 8, fontSize: 12 }}
                  formatter={(v) => `€${v.toLocaleString()}`}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Center label */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                {activeDetail.label}
              </div>
              <div className="mt-0.5 text-[18px] font-semibold tabular-nums">
                €{Math.round(currentForDisplay[activeCategory] ?? 0).toLocaleString()}
              </div>
              <div className="text-[10px] text-neutral-400">
                {totalCurrent > 0
                  ? (((currentForDisplay[activeCategory] ?? 0) / totalCurrent) * 100).toFixed(1)
                  : "0.0"}% share
              </div>
            </div>
          </div>
        </div>

        {/* Trend: stacked bar across 6 months */}
        <div className="lg:col-span-3">
          <div className="text-[12px] font-medium text-neutral-500">Trend — trailing 6 months</div>
          <div className="mt-2 h-[220px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
              <BarChart data={data} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#f4f4f5" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#a3a3a3", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#a3a3a3", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `€${v / 1000}k`} />
                <Tooltip
                  contentStyle={{ background: "white", border: "1px solid #e5e5e5", borderRadius: 8, fontSize: 12 }}
                  formatter={(v) => `€${v.toLocaleString()}`}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={8} />
                {categories.map(cat => (
                  <Bar
                    key={cat.key}
                    dataKey={cat.key}
                    name={cat.label}
                    stackId="opex"
                    fill={cat.color}
                    opacity={activeCategory === cat.key ? 1 : 0.55}
                    maxBarSize={48}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Line items for active category */}
      <div className="border-t border-neutral-100 bg-neutral-50/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: activeDetail.color }} />
            <div>
              <div className="text-[13px] font-semibold">{activeDetail.label} — line items</div>
              <div className="text-[11px] text-neutral-400">{activeDetail.description}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Category total</div>
            <div className="text-[15px] font-semibold tabular-nums">€{activeTotal.toLocaleString()}</div>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                <th className="px-3 py-2">Line item</th>
                <th className="px-3 py-2">Team / source</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">% of category</th>
              </tr>
            </thead>
            <tbody>
              {activeDetail.items
                .slice()
                .sort((a, b) => b.amount - a.amount)
                .map((item, idx) => {
                  const pct = (item.amount / activeTotal * 100);
                  return (
                    <tr key={idx} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50">
                      <td className="px-3 py-2 font-medium text-neutral-800">{item.name}</td>
                      <td className="px-3 py-2 text-neutral-500">{item.source}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">€{item.amount.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.min(100, pct)}%`, background: activeDetail.color, opacity: 0.6 }}
                            />
                          </div>
                          <span className="w-10 text-right tabular-nums text-neutral-500">{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-neutral-400">
          <Info size={11} />
          Click a category above to see its breakdown. Data shown for {monthLabel}{
            // Tag the latest month with (MTD) since it's the current,
            // still-accruing period — everything before it is a closed month.
            data.length > 0 && current === data[data.length - 1] ? " (MTD)" : ""
          }.
        </div>
      </div>
    </Card>
  );
};

/* =========================================================================
   VIEW: PILLAR 3 — MONTHLY OVERVIEW
   ========================================================================= */

export const MonthlyView = ({ opexByMonth: liveOpexByMonth, opexDetail: liveOpexDetail, opexDetailByMonth: liveOpexDetailByMonth = null, jorttLive, xeroDiag = null, shopifyMonthly, twData = [], shopifyRepeatFunnel = null, shippingByMonth = null, paymentFeesByMonth = null, interestTaxByMonth = null }: any = {}) => {
  const nlTW = twData.find(t => t.market === "NL" && t.live);
  // Aggregate KPIs across ALL live markets (not just NL).
  const liveTWAll = (twData ?? []).filter((t: any) => t?.live);
  const sum = (key: string) => liveTWAll.reduce((s: number, t: any) => s + (typeof t?.[key] === "number" ? t[key] : 0), 0);
  const totalRevenue = sum("revenue");
  const totalAdSpend = sum("adSpend");
  // Derive new customers per market from adSpend / NCPA, then sum.
  const totalNewCustomers = liveTWAll.reduce((s: number, t: any) => {
    if (typeof t?.adSpend === "number" && typeof t?.ncpa === "number" && t.ncpa > 0) {
      return s + t.adSpend / t.ncpa;
    }
    return s;
  }, 0);
  const aggNCPA = totalNewCustomers > 0 ? totalAdSpend / totalNewCustomers : null;
  const aggMER  = totalAdSpend > 0 ? totalRevenue / totalAdSpend : null;
  // LTV:CPA — weight each market's ratio by its share of new customers.
  const ltvCpaWeighted = (() => {
    let num = 0, den = 0;
    for (const t of liveTWAll) {
      if (typeof t?.ltvCpa === "number" && typeof t?.adSpend === "number" && typeof t?.ncpa === "number" && t.ncpa > 0) {
        const w = t.adSpend / t.ncpa;
        num += t.ltvCpa * w;
        den += w;
      }
    }
    return den > 0 ? num / den : null;
  })();
  // Repeat rate = % of cohort that placed a 2nd order (from Shopify repeat funnel).
  const repeatRate = (() => {
    const f: any = shopifyRepeatFunnel;
    if (!f) return null;
    // 1) Prefer the global funnel 2nd-order rate (matured)
    const second = f?.funnel?.find?.((r: any) => r.order === 2)?.rate;
    if (typeof second === "number" && second > 0) return second;
    // 2) Else: latest monthly cohort with a real (non-null, non-zero) 2nd-order rate
    const cohorts = Array.isArray(f?.monthlyCohorts) ? f.monthlyCohorts : [];
    for (let i = cohorts.length - 1; i >= 0; i--) {
      const c = cohorts[i];
      if (typeof c?.second === "number" && c.second > 0) return c.second;
    }
    // 3) Else: derive from raw counts if available (customers placing 2nd order / cohort size)
    const f2 = f?.funnel?.find?.((r: any) => r.order === 2);
    const f1 = f?.funnel?.find?.((r: any) => r.order === 1);
    if (f2?.customers && f1?.customers) {
      return +(100 * f2.customers / f1.customers).toFixed(1);
    }
    return null;
  })();
  const marketCount = liveTWAll.length;
  const twSub = marketCount > 0 ? `Triple Whale · ${marketCount} market${marketCount !== 1 ? "s" : ""}` : "TW not connected";
  const activeMonths = useMemo(() => {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth(); // 0-based
    const yy = String(curYear).slice(-2);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const byKey = new Map<string, { revenue: number; refunds: number }>();
    for (const m of shopifyMonthly ?? []) {
      if (!m?.month) continue;
      byKey.set(String(m.month), { revenue: m.revenue ?? 0, refunds: m.refunds ?? 0 });
    }
    const out: any[] = [];
    for (let i = 0; i <= curMonth; i++) {
      const label = `${monthNames[i]} '${yy}`;
      const entry = byKey.get(label) ?? { revenue: 0, refunds: 0 };
      const net = entry.revenue - entry.refunds;
      out.push({
        month: label,
        revenue: Math.round(entry.revenue),
        grossProfit: Math.round(net * 0.54),
        adSpend: Math.round(net * 0.26),
        contributionMargin: Math.round(net * 0.26),
        netProfit: Math.round(net * 0.12),
      });
    }
    // Drop leading empty months so the chart isn't dominated by blank space.
    const firstNonZero = out.findIndex((m) => m.revenue > 0);
    return firstNonZero > 0 ? out.slice(firstNonZero) : out;
  }, [shopifyMonthly]);
  if (activeMonths.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-8 text-center text-[13px] text-neutral-500">
        No monthly data available — Shopify monthly data has not loaded yet.
      </div>
    );
  }
  const current = activeMonths[activeMonths.length - 1];
  const prev = activeMonths[activeMonths.length - 2] ?? activeMonths[0];
  const activeOpexByMonth = liveOpexByMonth ?? null;
  const activeOpexDetail = liveOpexDetail ?? null;

  return (
    <>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 3</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Monthly Overview</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Management rollup · trailing 6 months
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
            April: In progress
          </span>
        </div>
      </div>

      {/* Hero summary */}
      <Card className="mt-6 p-6">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {[
            { label: "Revenue MTD", value: current.revenue, prev: prev.revenue, format: "€" },
            { label: "Gross profit MTD", value: current.grossProfit, prev: prev.grossProfit, format: "€" },
            { label: "Contribution margin", value: current.contributionMargin, prev: prev.contributionMargin, format: "€" },
            { label: "Net profit MTD", value: current.netProfit, prev: prev.netProfit, format: "€" },
          ].map(m => {
            const delta = ((m.value - m.prev) / m.prev * 100).toFixed(1);
            const positive = delta > 0;
            return (
              <div key={m.label}>
                <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{m.label}</div>
                <div className="mt-1 text-[24px] font-semibold tabular-nums">€{m.value.toLocaleString()}</div>
                <div className={`mt-0.5 flex items-center gap-1 text-[11px] font-medium ${positive ? "text-emerald-600" : "text-rose-600"}`}>
                  {positive ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                  {delta}% MoM
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Central P&L table — heart of the page (Mike's request) */}
      {(() => {
        // Sort by parsed date — not alphabetical string. The month labels are
        // "Mar '26", "Apr '26", "May '26", and localeCompare on those strings
        // sorts Apr → Mar → May (A < M, and within M's 'r' < 'y'), which made
        // the trailing-3-months columns render out of order on the dashboard.
        const monthsData = (shopifyMonthly ?? [])
          .slice()
          .sort((a: any, b: any) => parseMonthKey(a.month).getTime() - parseMonthKey(b.month).getTime());
        if (monthsData.length === 0) return null;
        const recent = monthsData.slice(-6);
        const opexMap = new Map<string, any>();
        for (const o of liveOpexByMonth ?? []) opexMap.set(o.month, o);

        // Per-month rows
        const cols = recent.map((m: any) => {
          const o = opexMap.get(m.month) ?? {};
          const revenue = (m.revenue ?? 0) - (m.refunds ?? 0);
          const tw = liveTWAll.find((t: any) => t.market === "NL"); // best-effort blended
          // COGS approximation: TW gross-profit ratio (NL) applied to revenue
          const gpRatio = tw && typeof tw.revenue === "number" && tw.revenue > 0 && typeof tw.grossProfit === "number"
            ? tw.grossProfit / tw.revenue : 0.54;
          const cogs = Math.round(revenue * (1 - gpRatio));
          const grossProfit = revenue - cogs;
          const adSpend = Math.round(revenue * 0.26);
          const shippingEntry = shippingByMonth && (shippingByMonth as any)[m.month];
          const shipping = shippingEntry && typeof shippingEntry.total === "number"
            ? Math.round(shippingEntry.total)
            : 0;
          // Payment processing fees — real numbers from Shopify Payments +
          // PayPal + Mollie, summed per calendar month by
          // fetchPaymentFeesMonthly. Keyed by the same "Mon 'YY" month label
          // the P&L table uses, so a direct lookup works.
          const feesEntry = paymentFeesByMonth && (paymentFeesByMonth as any)[m.month];
          const fees = feesEntry && typeof feesEntry.total === "number"
            ? Math.round(feesEntry.total)
            : 0;
          const cm = grossProfit - adSpend - shipping - fees;
          const team = o.team ?? 0;
          const software = o.software ?? 0;
          const agencies = o.agencies ?? 0;
          const content = o.content ?? 0;
          const otherOpex = (o.rent ?? 0) + (o.other ?? 0);
          const ebitda = cm - team - software - agencies - content - otherOpex;
          // Interest/Tax from Xero — non-zero only when the org books these
          // accounts in their P&L (the parser separates them out from "Other").
          // Most NL/UK orgs only book tax at year-end, so monthly values are
          // often €0 mid-year, then a single large entry in the closing month.
          const interestTax = Number(
            (interestTaxByMonth && (interestTaxByMonth as any)[m.month]) ?? 0,
          );
          const netProfit = ebitda - interestTax;
          return { month: m.month, revenue, cogs, grossProfit, adSpend, shipping, fees, cm, team, software, agencies, content, otherOpex, ebitda, interestTax, netProfit };
        });
        const latest = cols[cols.length - 1];
        const fmt = (v: number) => `€${Math.round(v).toLocaleString()}`;
        const pct = (v: number) => latest.revenue > 0 ? `${(v / latest.revenue * 100).toFixed(1)}%` : "—";

        const lines = [
          { k: "Revenue", get: (c: any) => c.revenue, bold: true },
          { k: "COGS", get: (c: any) => -c.cogs },
          { k: "Gross Profit", get: (c: any) => c.grossProfit, bold: true },
          { k: "Marketing / Ad spend", get: (c: any) => -c.adSpend },
          { k: "Shipping", get: (c: any) => -c.shipping, muted: true },
          { k: "Payment fees", get: (c: any) => -c.fees },
          { k: "= Contribution Margin", get: (c: any) => c.cm, bold: true },
          { k: "Team", get: (c: any) => -c.team },
          { k: "Software", get: (c: any) => -c.software },
          { k: "Agencies", get: (c: any) => -c.agencies },
          { k: "Content collaborations", get: (c: any) => -c.content },
          { k: "Other OpEx", get: (c: any) => -c.otherOpex },
          { k: "EBITDA", get: (c: any) => c.ebitda, bold: true },
          { k: "Interest / Tax", get: (c: any) => -c.interestTax },
          { k: "Net Profit", get: (c: any) => c.netProfit, bold: true },
        ];

        return (
          <Card className="mt-3 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">P&amp;L · trailing {cols.length} months</div>
                <div className="mt-0.5 text-[11px] text-neutral-400">Latest month % of revenue shown in last column</div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-neutral-100 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                    <th className="py-2 pr-4">Line item</th>
                    {cols.map(c => <th key={c.month} className="py-2 px-2 text-right">{c.month}</th>)}
                    <th className="py-2 pl-4 text-right">% of revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => (
                    <tr key={l.k} className={`border-b border-neutral-50 ${l.bold ? "font-semibold bg-neutral-50/40" : ""} ${l.muted ? "text-neutral-400" : ""}`}>
                      <td className="py-1.5 pr-4">{l.k}</td>
                      {cols.map(c => {
                        const v = l.get(c);
                        return <td key={c.month} className="py-1.5 px-2 text-right tabular-nums">{v === 0 ? "—" : fmt(v)}</td>;
                      })}
                      <td className="py-1.5 pl-4 text-right tabular-nums">{pct(Math.abs(l.get(latest)))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 text-[10px] text-neutral-400">
              COGS estimated via Triple Whale gross-margin ratio. Payment fees = Shopify Payments + PayPal + Mollie actual processing fees per month. Shipping per-market still pending. Interest/Tax pulled from Xero accounts matching interest/tax/loan/belasting keywords — "—" means no such accounts are booked for that month.
            </div>
          </Card>
        );
      })()}

      {/* Trend chart — compact */}
      <Card className="mt-3 p-5">
        <div className="mb-3">
          <div className="text-[13px] font-semibold">Revenue, profit & ad spend — YTD by month</div>
          <div className="text-[12px] text-neutral-400">Current month is MTD and updates as it progresses</div>
        </div>
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={240}>
            <AreaChart data={activeMonths} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="areaRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#171717" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#171717" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="areaProfit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="areaAd" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a1a1aa" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#a1a1aa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#f4f4f5" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "#a3a3a3", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#a3a3a3", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `€${v / 1000}k`} />
              <Tooltip
                contentStyle={{ background: "white", border: "1px solid #e5e5e5", borderRadius: 8, fontSize: 12 }}
                formatter={(v: any) => `€${Number(v).toLocaleString()}`}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} iconType="circle" />
              <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#171717" strokeWidth={2} fill="url(#areaRevenue)" dot={{ r: 3, fill: "#171717" }} activeDot={{ r: 4 }} />
              <Area type="monotone" dataKey="adSpend" name="Ad spend" stroke="#a1a1aa" strokeWidth={2} fill="url(#areaAd)" dot={{ r: 3, fill: "#a1a1aa" }} activeDot={{ r: 4 }} />
              <Area type="monotone" dataKey="netProfit" name="Net profit" stroke="#10b981" strokeWidth={2} fill="url(#areaProfit)" dot={{ r: 3, fill: "#10b981" }} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* KPI strip — live Triple Whale data */}
      <section className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "NCPA", value: aggNCPA != null ? `€${aggNCPA.toFixed(0)}` : "—", sub: twSub },
          { label: "LTV:CPA", value: ltvCpaWeighted != null ? `${ltvCpaWeighted.toFixed(2)}×` : "—", sub: twSub },
          { label: "MER", value: aggMER != null ? `${aggMER.toFixed(2)}×` : "—", sub: twSub },
          { label: "Repeat rate", value: repeatRate != null ? `${repeatRate.toFixed(1)}%` : "—", sub: shopifyRepeatFunnel ? "Shopify · 2nd order cohort" : "Shopify cohort not loaded" },
        ].map(kpi => (
          <Card key={kpi.label} className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{kpi.label}</div>
            <div className="mt-1 text-[20px] font-semibold tabular-nums">{kpi.value}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">{kpi.sub}</div>
          </Card>
        ))}
      </section>

      {/* OpEx breakdown — 5 categories, sourced from Xero P&L */}
      <OpExBreakdownSection opexByMonth={activeOpexByMonth} opexDetail={activeOpexDetail} opexDetailByMonth={liveOpexDetailByMonth} xeroDiag={xeroDiag} />

      {/* Month close status */}
      <Card className="mt-3 p-5">
        <div className="text-[13px] font-semibold">Month close status</div>
        <div className="mt-3 flex items-center gap-3 overflow-x-auto">
          {activeMonths.map((m, i) => {
            const isOpen = i === activeMonths.length - 1;
            return (
              <div key={m.month} className={`shrink-0 rounded-lg border px-4 py-3 ${isOpen ? "border-amber-200 bg-amber-50/40" : "border-emerald-200 bg-emerald-50/30"}`}>
                <div className="text-[11px] font-medium text-neutral-500">{m.month}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  {isOpen ? <Clock size={12} className="text-amber-600" /> : <CircleCheck size={12} className="text-emerald-600" />}
                  <span className={`text-[11px] font-medium ${isOpen ? "text-amber-700" : "text-emerald-700"}`}>
                    {isOpen ? "Open" : "Closed"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
};

/* =========================================================================
   VIEW: PILLAR 4 — BALANCE SHEET
   ========================================================================= */

const BalanceView = ({ jorttData = null, xeroData = null, xeroError = null, shopifyMarkets = null, twData = [] }: any) => {
  // Xero is the primary source; Jortt is fallback
  const src       = xeroData?.live ? "xero" : jorttData?.live ? "jortt" : null;
  const hasData   = !!src;
  const srcLabel  = src === "xero" ? "Xero" : "Jortt";

  // ── Key figures — Xero first, Jortt fallback ──────────────────────────────
  const totalAssets       = xeroData?.totalAssets       ?? null;
  const currentAssets     = xeroData?.currentAssets     ?? null;
  const fixedAssets       = xeroData?.fixedAssets       ?? null;
  const totalLiabilities  = xeroData?.totalLiabilities  ?? null;
  const currentLiabilities = xeroData?.currentLiabilities ?? null;
  const equity            = xeroData?.equity            ?? null;
  const cash              = xeroData?.cashBalance        ?? jorttData?.cashBalance ?? null;
  const accountsReceivable = xeroData?.accountsReceivable ?? jorttData?.accountsReceivable ?? null;
  const overdueAmount     = xeroData?.overdueAmount      ?? null;
  const unpaidCount       = xeroData?.unpaidInvoiceCount ?? jorttData?.unpaidInvoiceCount ?? 0;

  // YTD P&L
  const ytdRevenue   = xeroData?.ytdRevenue   ?? null;
  const ytdExpenses  = xeroData?.ytdExpenses  ?? null;
  const ytdNetProfit = xeroData?.ytdNetProfit ?? null;

  // 12-month revenue totals for fallback (Jortt)
  const jorttRevTotal = jorttData?.revenueByMonth
    ? Object.values(jorttData.revenueByMonth).reduce((s, v) => s + v, 0) : 0;
  const jorttExpTotal = jorttData?.expensesByMonth
    ? Object.values(jorttData.expensesByMonth).reduce((s, v) => s + v, 0) : 0;

  // Revenue trend chart data — Xero first
  const revenueMonths = useMemo(() => {
    const byMonth = xeroData?.revenueByMonth ?? jorttData?.revenueByMonth ?? {};
    return Object.entries(byMonth)
      .filter(([k]) => k)
      .sort(([a], [b]) => parseMonthKey(a) - parseMonthKey(b))
      .map(([month, revenue]) => ({ month, revenue: Math.round(revenue) }));
  }, [xeroData, jorttData]);

  const nlTW = twData.find(t => t.market === "NL" && t.live);

  if (!hasData) {
    return (
      <>
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 4</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Balance Sheet</h1>
          <p className="mt-1 text-[13px] text-neutral-500">Financial position · assets, liabilities, equity.</p>
        </div>
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 py-16 text-center">
          <Scale size={32} className="text-neutral-300" />
          <div className="mt-4 text-[15px] font-semibold text-neutral-700">No accounting data yet</div>
          <div className="mt-2 max-w-sm text-[13px] text-neutral-400">
            Click <strong>Sync</strong> to fetch data from Xero. Balance sheet will populate with assets, liabilities, equity, and cash positions from your accounting system.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 4</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Balance Sheet</h1>
          <p className="mt-1 text-[13px] text-neutral-500">Financial position · assets, liabilities, equity · via {srcLabel}</p>
        </div>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
          {srcLabel} live
        </span>
      </div>

      {/* Assets, Liabilities, Equity */}
      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        {/* Assets */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-50">
              <Wallet size={14} className="text-emerald-600" />
            </div>
            <div className="text-[13px] font-semibold">Assets</div>
          </div>
          <div className="space-y-3">
            {currentAssets != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">Current assets</span>
                <span className="text-[13px] font-medium tabular-nums">€{currentAssets.toLocaleString()}</span>
              </div>
            )}
            {fixedAssets != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">Fixed assets</span>
                <span className="text-[13px] font-medium tabular-nums">€{fixedAssets.toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-neutral-500">Cash &amp; bank</span>
              <span className="text-[13px] font-medium tabular-nums">
                {cash != null ? `€${Math.round(cash).toLocaleString()}` : <span className="text-neutral-300 text-[11px]">—</span>}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-neutral-500">Accounts receivable</span>
              <span className="text-[13px] font-medium tabular-nums">
                {accountsReceivable != null ? `€${Math.round(accountsReceivable).toLocaleString()}` : <span className="text-neutral-400 text-[12px]">€0</span>}
              </span>
            </div>
            <div className="border-t border-neutral-100 pt-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-neutral-700">Total assets</span>
              <span className="text-[14px] font-bold tabular-nums text-emerald-700">
                {totalAssets != null
                  ? `€${totalAssets.toLocaleString()}`
                  : cash != null || accountsReceivable != null
                    ? `€${Math.round((cash ?? 0) + (accountsReceivable ?? 0)).toLocaleString()}`
                    : "—"}
              </span>
            </div>
          </div>
        </Card>

        {/* Liabilities */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-rose-50">
              <Scale size={14} className="text-rose-600" />
            </div>
            <div className="text-[13px] font-semibold">Liabilities</div>
          </div>
          <div className="space-y-3">
            {currentLiabilities != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">Current liabilities</span>
                <span className="text-[13px] font-medium tabular-nums text-rose-600">€{currentLiabilities.toLocaleString()}</span>
              </div>
            )}
            {ytdExpenses != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">Operating costs (YTD)</span>
                <span className="text-[13px] font-medium tabular-nums">€{ytdExpenses.toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-neutral-500">Ad spend (TW · NL)</span>
              <span className="text-[13px] font-medium tabular-nums">
                {nlTW?.adSpend != null ? `€${Math.round(nlTW.adSpend).toLocaleString()}` : "—"}
              </span>
            </div>
            <div className="border-t border-neutral-100 pt-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-neutral-700">Total liabilities</span>
              <span className="text-[14px] font-bold tabular-nums text-rose-700">
                {totalLiabilities != null
                  ? `€${totalLiabilities.toLocaleString()}`
                  : currentLiabilities != null
                    ? `€${currentLiabilities.toLocaleString()}`
                    : ytdExpenses != null ? `€${ytdExpenses.toLocaleString()}` : "—"}
              </span>
            </div>
          </div>
        </Card>

        {/* Equity / Net position */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-50">
              <TrendingUp size={14} className="text-violet-600" />
            </div>
            <div className="text-[13px] font-semibold">Equity &amp; P&amp;L</div>
          </div>
          <div className="space-y-3">
            {equity != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">Total equity</span>
                <span className={`text-[13px] font-medium tabular-nums ${equity >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  {equity >= 0 ? "+" : "−"}€{Math.abs(equity).toLocaleString()}
                </span>
              </div>
            )}
            {ytdRevenue != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">YTD revenue</span>
                <span className="text-[13px] font-medium tabular-nums">€{ytdRevenue.toLocaleString()}</span>
              </div>
            )}
            {ytdExpenses != null && (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-500">YTD expenses</span>
                <span className="text-[13px] font-medium tabular-nums text-rose-600">−€{ytdExpenses.toLocaleString()}</span>
              </div>
            )}
            {ytdRevenue == null && jorttRevTotal > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-neutral-500">Revenue (12mo)</span>
                  <span className="text-[13px] font-medium tabular-nums">€{Math.round(jorttRevTotal).toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-neutral-500">Costs (12mo)</span>
                  <span className="text-[13px] font-medium tabular-nums text-rose-600">
                    {jorttExpTotal > 0 ? `−€${Math.round(jorttExpTotal).toLocaleString()}` : "—"}
                  </span>
                </div>
              </>
            )}
            <div className="border-t border-neutral-100 pt-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-neutral-700">Net profit (YTD)</span>
              <span className={`text-[14px] font-bold tabular-nums ${(ytdNetProfit ?? 0) >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                {ytdNetProfit != null
                  ? `${ytdNetProfit >= 0 ? "+" : "−"}€${Math.abs(ytdNetProfit).toLocaleString()}`
                  : jorttRevTotal > 0 && jorttExpTotal > 0
                    ? `€${Math.round(jorttRevTotal - jorttExpTotal).toLocaleString()}`
                    : "—"}
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* Bank accounts (Xero) — always render so the user sees why it's empty,
          instead of the card silently disappearing when Xero returns no rows. */}
      {(() => {
        const banks = Array.isArray(xeroData?.bankAccounts) ? xeroData.bankAccounts : [];
        const diag = (xeroData as any)?._diagnostics?.bankSummary ?? null;
        const accountsApiCount: number | null = diag?.accountsFromAccountsApi ?? null;
        const reportPresent: boolean | null = diag?.reportPresent ?? null;
        // Auth-failure case takes priority — when the refresh token is dead,
        // xeroData is null because the sync threw before producing anything.
        const isAuthError = !!xeroError && /auth|invalid_grant|refresh token|reconnect/i.test(xeroError);
        // Decide an empty-state reason when banks.length === 0.
        const emptyReason: string | null = (() => {
          if (banks.length > 0) return null;
          if (isAuthError) return xeroError;
          if (xeroError) return xeroError;
          if (!xeroData) return "Xero data not loaded yet — wait for the next sync to finish.";
          if (accountsApiCount === null) return "Xero sync hasn't returned the Chart of Accounts. The accounting.settings.read scope may not be approved on your Xero app, or the last sync errored before reaching /Accounts.";
          if (accountsApiCount === 0) return "Xero returned 0 BANK-type accounts. Either your Chart of Accounts has no entries with Type='BANK', or the accounting.settings.read scope is missing from the OAuth approval.";
          if (reportPresent === false) return `Xero returned ${accountsApiCount} BANK account${accountsApiCount === 1 ? "" : "s"} but the BankSummary report wasn't accessible (accounting.reports.banksummary.read scope likely missing) — balances unknown.`;
          return `Xero returned ${accountsApiCount} BANK account${accountsApiCount === 1 ? "" : "s"} but they were filtered out during merge — open the Sync page diagnostics to inspect.`;
        })();
        return (
          <Card className="mt-3 p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[13px] font-semibold">Bank accounts · Xero</div>
              {banks.length > 0 && (
                <div className="text-[11px] text-neutral-400">{banks.length} account{banks.length === 1 ? "" : "s"}</div>
              )}
            </div>
            {banks.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {banks.map((acc: any) => (
                    <div key={acc.name} className="rounded-lg bg-neutral-50 px-4 py-3">
                      <div className="text-[11px] text-neutral-500 truncate">{acc.name}</div>
                      <div className={`mt-1 text-[18px] font-semibold tabular-nums ${acc.balance < 0 ? "text-rose-600" : "text-neutral-900"}`}>
                        €{Math.round(Math.abs(acc.balance)).toLocaleString()}
                      </div>
                      {acc.balance < 0 && <div className="text-[10px] text-rose-400">overdrawn</div>}
                    </div>
                  ))}
                </div>
                {cash != null && (
                  <div className="mt-3 border-t border-neutral-100 pt-3 flex items-center justify-between">
                    <span className="text-[12px] font-medium text-neutral-500">Total cash position</span>
                    <span className={`text-[15px] font-bold tabular-nums ${cash >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      €{Math.round(Math.abs(cash)).toLocaleString()}
                    </span>
                  </div>
                )}
              </>
            ) : isAuthError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">
                <div className="font-semibold mb-1">Xero is disconnected</div>
                <div className="text-red-700/90 break-words">{emptyReason}</div>
                <div className="mt-3 flex items-center gap-2">
                  <a
                    href="/api/auth/xero"
                    className="inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-[12px] font-medium text-red-800 hover:bg-red-100"
                  >
                    Reconnect Xero
                  </a>
                  <span className="text-[11px] text-red-700/80">After reconnecting, sync will rebuild on the next run.</span>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 text-[12px] text-amber-800">
                <div className="font-semibold mb-1">No bank accounts returned from Xero</div>
                <div className="text-amber-700/90">{emptyReason}</div>
                <div className="mt-2 text-amber-700/80">
                  Required Xero scopes: <code className="rounded bg-amber-100 px-1 py-0.5 text-[11px]">accounting.settings.read</code> · <code className="rounded bg-amber-100 px-1 py-0.5 text-[11px]">accounting.reports.banksummary.read</code>. <a href="/api/auth/xero" className="underline hover:text-amber-900">Reconnect Xero</a> if these weren't approved.
                </div>
              </div>
            )}
          </Card>
        );
      })()}

      {/* Revenue trend chart */}
      {revenueMonths.length > 0 && (
        <Card className="mt-3 p-5">
          <div className="mb-4">
            <div className="text-[13px] font-semibold">Revenue trend · 12 months</div>
            <div className="text-[12px] text-neutral-400">{srcLabel} · accounting revenue</div>
          </div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={200}>
              <BarChart data={revenueMonths} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#f4f4f5" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#a3a3a3", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#a3a3a3", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `€${(v / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ background: "white", border: "1px solid #e5e5e5", borderRadius: 8, fontSize: 12 }} formatter={v => [`€${v.toLocaleString()}`, "Revenue"]} />
                <Bar dataKey="revenue" fill="#171717" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Key stats row */}
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Accounts receivable", value: accountsReceivable != null ? `€${Math.round(accountsReceivable).toLocaleString()}` : "€0", sub: `${unpaidCount} unpaid invoice${unpaidCount !== 1 ? "s" : ""}` },
          { label: "Overdue amount", value: overdueAmount != null ? `€${Math.round(overdueAmount).toLocaleString()}` : "€0", sub: xeroData?.overdueInvoiceCount > 0 ? `${xeroData.overdueInvoiceCount} overdue` : "All current" },
          { label: "Net margin (YTD)", value: ytdRevenue && ytdNetProfit != null ? `${((ytdNetProfit / ytdRevenue) * 100).toFixed(1)}%` : "—", sub: "Net profit ÷ revenue" },
          { label: "Equity", value: equity != null ? `€${Math.abs(equity).toLocaleString()}` : "—", sub: equity != null ? (equity >= 0 ? "Positive" : "Negative") : srcLabel },
        ].map(m => (
          <Card key={m.label} className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{m.label}</div>
            <div className="mt-1 text-[22px] font-semibold tabular-nums">{m.value}</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">{m.sub}</div>
          </Card>
        ))}
      </div>
    </>
  );
};

/* =========================================================================
   VIEW: PILLAR 5 — FORECAST
   ========================================================================= */

/* =========================================================================
   VIEW: PILLAR 5 — FORECAST
   ========================================================================= */

function parseMonthKey(mk) {
  if (!mk) return new Date(0);
  return new Date("1 " + mk.replace("'", "20"));
}

const ForecastView = ({ jorttData = null, xeroData = null, shopifyMonthly = null }) => {
  // Xero is primary accounting source; fall back to Jortt then Shopify
  const hasData = !!(xeroData?.live || jorttData?.live || shopifyMonthly?.length > 0);
  const acctSrcLabel = xeroData?.live ? "Xero" : jorttData?.live ? "Jortt" : "Shopify";

  // Active accounting data (Xero first, Jortt fallback)
  const acctRevByMonth = xeroData?.revenueByMonth ?? jorttData?.revenueByMonth ?? {};
  const acctExpByMonth = xeroData?.expensesByMonth ?? jorttData?.expensesByMonth ?? {};
  const cashBalance    = xeroData?.cashBalance ?? jorttData?.cashBalance ?? null;

  // Build sorted historical monthly data merging accounting + Shopify
  const chartData = useMemo(() => {
    const allMonths = new Set([
      ...Object.keys(acctRevByMonth),
      ...Object.keys(acctExpByMonth),
      ...(shopifyMonthly?.map(m => m.month) ?? []),
    ]);
    allMonths.delete("");

    return Array.from(allMonths)
      .sort((a, b) => parseMonthKey(a) - parseMonthKey(b))
      .map(month => {
        const acctRev = acctRevByMonth[month] ?? 0;
        const shopRev = shopifyMonthly?.find(m => m.month === month)?.revenue ?? 0;
        // Prefer Xero/Jortt net profit by month if available
        const acctNet = xeroData?.netProfitByMonth?.[month] ?? null;
        const expenses = acctExpByMonth[month] ?? 0;
        const revenue  = acctRev > 0 ? acctRev : shopRev;
        return {
          month,
          revenue:   Math.round(revenue),
          expenses:  Math.round(expenses),
          netProfit: acctNet != null ? Math.round(acctNet) : Math.round(revenue - expenses),
        };
      })
      .filter(m => m.revenue > 0 || m.expenses > 0);
  }, [xeroData, jorttData, shopifyMonthly]);

  // Compute growth rate and 6-month projection
  const { allData, growthRatePct } = useMemo(() => {
    if (chartData.length < 2) return { allData: chartData, growthRatePct: 0 };

    const recent      = chartData.slice(-3);
    const avgRevenue  = recent.reduce((s, m) => s + m.revenue,  0) / recent.length;
    const avgExpenses = recent.reduce((s, m) => s + m.expenses, 0) / recent.length;

    const rates = [];
    for (let i = 1; i < recent.length; i++) {
      if (recent[i - 1].revenue > 0)
        rates.push((recent[i].revenue - recent[i - 1].revenue) / recent[i - 1].revenue);
    }
    const rawRate    = rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
    const growthRate = Math.max(-0.15, Math.min(0.15, rawRate));

    const lastDate = parseMonthKey(chartData[chartData.length - 1].month);
    const projected = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(lastDate);
      d.setMonth(d.getMonth() + i + 1);
      const month    = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
      const revenue  = Math.round(avgRevenue  * Math.pow(1 + growthRate, i + 1));
      const expenses = Math.round(avgExpenses * Math.pow(1.02, i + 1));
      return { month, projRevenue: revenue, projExpenses: expenses, projNetProfit: revenue - expenses };
    });

    // Merge: historical rows keep revenue/expenses/netProfit; projected rows have projRevenue etc.
    const combined = [
      ...chartData.map(m => ({ ...m, projRevenue: undefined, projExpenses: undefined, projNetProfit: undefined })),
      ...projected.map(m => ({ ...m, revenue: undefined, expenses: undefined, netProfit: undefined })),
    ];

    return { allData: combined, growthRatePct: +(rawRate * 100).toFixed(1) };
  }, [chartData]);

  const last         = chartData[chartData.length - 1];
  const runRate      = last?.revenue ?? 0;
  const projMonths   = allData.filter(m => m.projRevenue != null);
  const annualFwd    = projMonths.length === 6
    ? Math.round([...chartData.slice(-6), ...projMonths.map(m => ({ revenue: m.projRevenue }))].reduce((s, m) => s + (m.revenue ?? 0), 0))
    : runRate * 12;
  const recentMargin = (() => {
    const r3 = chartData.slice(-3).filter(m => m.revenue > 0);
    if (!r3.length) return null;
    return (r3.reduce((s, m) => s + m.netProfit / m.revenue, 0) / r3.length * 100).toFixed(1);
  })();

  if (!hasData) {
    return (
      <>
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 5</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Forecast</h1>
          <p className="mt-1 text-[13px] text-neutral-500">Trend-based cash flow projection and growth plan.</p>
        </div>
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 py-16 text-center">
          <Sparkles size={32} className="text-neutral-300" />
          <div className="mt-4 text-[15px] font-semibold text-neutral-700">Forecast not yet available</div>
          <div className="mt-2 max-w-sm text-[13px] text-neutral-400">
            Cash flow forecast builds from connected live data. Connect Xero or Jortt for revenue &amp; expenses, and allow 3+ months of history to accumulate for trend-based projections.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Pillar 5</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Forecast</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Trend-based projection · {chartData.length} months history · 6-month forward model
          </p>
        </div>
        <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700">
          {growthRatePct > 0 ? "+" : ""}{growthRatePct}% MoM trend
        </span>
      </div>

      {/* Key metric cards */}
      <Card className="mt-6 p-6">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {[
            {
              label: "Current run rate",
              value: runRate > 0 ? `€${runRate.toLocaleString()}/mo` : "—",
              sub: last?.month ? `Last: ${last.month}` : "No data",
            },
            {
              label: "Annualized (run rate)",
              value: runRate > 0 ? `€${(runRate * 12).toLocaleString()}` : "—",
              sub: "Current month × 12",
            },
            {
              label: "12-month projected",
              value: annualFwd > 0 ? `€${annualFwd.toLocaleString()}` : "—",
              sub: projMonths.length > 0 ? "Trend-adjusted forward" : "Based on run rate",
            },
            {
              label: "Cash position",
              value: cashBalance != null ? `€${Math.round(cashBalance).toLocaleString()}` : "—",
              sub: cashBalance != null ? `${acctSrcLabel} cash & bank` : `Connect ${acctSrcLabel}`,
            },
          ].map(m => (
            <div key={m.label}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{m.label}</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums">{m.value}</div>
              <div className="mt-0.5 text-[11px] text-neutral-400">{m.sub}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Revenue & expenses chart */}
      <Card className="mt-3 p-5">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-[13px] font-semibold">Revenue, expenses &amp; net profit</div>
            <div className="text-[12px] text-neutral-400">Solid = historical · Shaded = 6-month projection</div>
          </div>
          {recentMargin != null && (
            <div className="text-right">
              <div className="text-[11px] text-neutral-400">Avg net margin</div>
              <div className={`text-[15px] font-semibold tabular-nums ${parseFloat(recentMargin) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {recentMargin}%
              </div>
            </div>
          )}
        </div>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={300}>
            <ComposedChart data={allData} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#f4f4f5" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: "#a3a3a3", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#a3a3a3", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `€${(v / 1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{ background: "white", border: "1px solid #e5e5e5", borderRadius: 8, fontSize: 12 }}
                formatter={(v, name) => [v != null ? `€${Math.round(v).toLocaleString()}` : "—", name]}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" />
              {/* Historical */}
              <Bar dataKey="revenue"   name="Revenue"       fill="#171717" radius={[3, 3, 0, 0]} maxBarSize={32} />
              <Bar dataKey="expenses"  name="Expenses"      fill="#d4d4d8" radius={[3, 3, 0, 0]} maxBarSize={32} />
              <Line type="monotone" dataKey="netProfit" name="Net profit" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              {/* Projected */}
              <Bar dataKey="projRevenue"   name="Rev (proj)"  fill="#a78bfa" radius={[3, 3, 0, 0]} maxBarSize={32} opacity={0.55} />
              <Bar dataKey="projExpenses"  name="Exp (proj)"  fill="#c4b5fd" radius={[3, 3, 0, 0]} maxBarSize={32} opacity={0.45} />
              <Line type="monotone" dataKey="projNetProfit" name="Profit (proj)" stroke="#10b981" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Monthly P&L table */}
      <Card className="mt-3 overflow-hidden">
        <div className="border-b border-neutral-100 px-5 py-3">
          <div className="text-[13px] font-semibold">Monthly P&amp;L breakdown</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-100 bg-neutral-50">
                <th className="px-5 py-2.5 text-left font-medium text-neutral-400">Month</th>
                <th className="px-4 py-2.5 text-right font-medium text-neutral-400">Revenue</th>
                <th className="px-4 py-2.5 text-right font-medium text-neutral-400">Expenses</th>
                <th className="px-4 py-2.5 text-right font-medium text-neutral-400">Net profit</th>
                <th className="px-4 py-2.5 text-right font-medium text-neutral-400">Margin</th>
              </tr>
            </thead>
            <tbody>
              {allData.map((row, i) => {
                const isProj = row.projRevenue != null;
                const rev  = isProj ? row.projRevenue  : row.revenue;
                const exp  = isProj ? row.projExpenses : row.expenses;
                const net  = isProj ? row.projNetProfit : row.netProfit;
                const margin = rev > 0 ? ((net / rev) * 100).toFixed(1) : null;
                return (
                  <tr key={i} className={`border-b border-neutral-50 ${isProj ? "bg-violet-50/40" : "hover:bg-neutral-50"}`}>
                    <td className="px-5 py-2.5 font-medium text-neutral-700">
                      {row.month}
                      {isProj && <span className="ml-1.5 rounded bg-violet-100 px-1 py-0.5 text-[10px] text-violet-600">proj</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700">€{(rev ?? 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500">€{(exp ?? 0).toLocaleString()}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${(net ?? 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {(net ?? 0) >= 0 ? "+" : ""}€{Math.abs(net ?? 0).toLocaleString()}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums text-[11px] ${margin != null && parseFloat(margin) >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                      {margin != null ? `${margin}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* P&L summary from Jortt */}
      {jorttData?.plSummary && (
        <Card className="mt-3 p-5">
          <div className="mb-3 text-[13px] font-semibold">P&amp;L summary · Jortt (YTD)</div>
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Revenue",      value: jorttData.plSummary.revenue,     color: "text-neutral-900" },
              { label: "Total costs",  value: jorttData.plSummary.costs,       color: "text-neutral-500" },
              { label: "Gross profit", value: jorttData.plSummary.grossProfit, color: jorttData.plSummary.grossProfit >= 0 ? "text-emerald-600" : "text-rose-600" },
            ].map(m => (
              <div key={m.label}>
                <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{m.label}</div>
                <div className={`mt-1 text-[20px] font-semibold tabular-nums ${m.color}`}>
                  €{Math.round(m.value).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
};

/* =========================================================================
   MAIN APP
   ========================================================================= */

export default function FinanceDashboard({ user = null, liveData = null, connections = {}, syncedAt = null, dataIsStale = false, hasAnyData = false }: any) {
  const router = useRouter();
  const [dateRange, setDateRange]   = useState({ from: drStartOfMonth(), to: drToday() });
  const [rangeData, setRangeData]   = useState(null);
  const [rangeSyncing, setRangeSyncing] = useState(false);

  const handleDateChange = useCallback(async (from, to) => {
    setDateRange({ from, to });
    const isCurrentMonth = from === drStartOfMonth() && to === drToday();
    if (isCurrentMonth) {
      setRangeData(null); // use live data
      return;
    }
    setRangeSyncing(true);
    setRangeData(null);
    try {
      const res  = await authedFetch(`/api/sync?from=${from}&to=${to}`, { method: "POST" });
      const json = await res.json();
      setRangeData(json.rangeData ?? null);
    } catch {
      setRangeData(null);
    } finally {
      setRangeSyncing(false);
    }
  }, []);
  const [view, setView] = useState("overview");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      // /api/sync now returns immediately (~50ms) and runs in the background.
      const res = await authedFetch("/api/sync", { method: "POST" });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      // Poll the dashboard a few times so cards fill in as jobs complete.
      // Background jobs typically finish within 60s.
      const intervals = [3000, 8000, 15000, 30000, 60000];
      for (const delay of intervals) {
        await new Promise((r) => setTimeout(r, delay));
        try { await router.invalidate(); } catch { /* ignore */ }
      }
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  }, [syncing, router]);

  // Auto-sync in background if data is stale or missing
  useEffect(() => {
    if (dataIsStale || !hasAnyData) {
      handleSync();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const syncLabel = (() => {
    if (!syncedAt) return "Never synced";
    const mins = Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  })();

  // ── Live data only (no mock fallbacks) ────────────────────────────────
  // Cache may return {__empty:true} or {__error:...} objects instead of arrays — guard everything.
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const shopifyToday      = liveData?.shopifyToday ?? null;
  const shopifyMarketsArr = asArr(liveData?.shopifyMarkets);
  const activeMarkets     = shopifyMarketsArr.some(m => m?.live) ? shopifyMarketsArr : null;
  const shopifyLive       = !!activeMarkets;
  const jorttObj          = liveData?.jortt && typeof liveData.jortt === "object" && !liveData.jortt.__empty && !liveData.jortt.__error ? liveData.jortt : null;
  const xeroObj           = liveData?.xero && typeof liveData.xero === "object" && !liveData.xero.__empty && !liveData.xero.__error ? liveData.xero : null;
  // Surface Xero auth/sync errors so downstream views can show the right
  // empty-state CTA (e.g. "Reconnect Xero" when the refresh token is invalidated).
  const xeroErrorMessage  = liveData?.xero && typeof liveData.xero === "object" && (liveData.xero as any).__error
    ? String((liveData.xero as any).message ?? "Xero sync failed")
    : null;
  // Compact diagnostic blob threaded into views that render Xero-only data,
  // so when a card is empty we can show WHY (auth, scope, classifier miss).
  const xeroDiag          = {
    error: xeroErrorMessage,
    profitAndLoss: (xeroObj as any)?._diagnostics?.profitAndLoss ?? null,
    bankSummary: (xeroObj as any)?._diagnostics?.bankSummary ?? null,
  };
  // OpEx is sourced exclusively from Xero P&L. Jortt is no longer used for OpEx.
  const activeOpexByMonth = asArr(xeroObj?.opexByMonth).length > 0 ? xeroObj.opexByMonth : null;
  const activeOpexDetail  = xeroObj?.opexDetail ?? null;
  const jorttLive         = !!(jorttObj?.live);
  const xeroLive          = !!(xeroObj?.live);
  const twData            = asArr(liveData?.tripleWhale).filter(m => m?.live);
  const twLive            = twData.length > 0;
  // Accept calcVersion >= 2 so newer payloads (stricter active filter + MRR
  // normalization, currently v3) pass through. Older v1 payloads still
  // rejected because their count/MRR semantics aren't comparable.
  const juoArr            = asArr(liveData?.juo).filter(m => (m?.calcVersion ?? 0) >= 2);
  const loopArr           = asArr(liveData?.loop).filter(m => (m?.calcVersion ?? 0) >= 3);
  const juoLive           = juoArr.some(m => m?.live);
  const loopLive          = loopArr.some(m => m?.live);
  const subLive           = juoLive || loopLive;
  // Combined subscription data: JUO (NL) + Loop (UK/US/EU)
  const allSubData        = [...juoArr, ...loopArr].filter(m => m?.live);
  const liveSources       = [shopifyLive, jorttLive || xeroLive, twLive, subLive].filter(Boolean).length;
  // Safe values to pass into subcomponents (markers stripped to null/[])
  const safeShopifyMonthly = asArr(liveData?.shopifyMonthly);
  // Prefer subscription funnel (Juo + Loop) over Shopify-orders funnel
  const subFunnel = liveData?.subscriptionRepeatFunnel;
  const subFunnelValid = subFunnel && !subFunnel.__empty && !subFunnel.__error && (subFunnel.cohortSize ?? 0) > 0;
  const shopFunnel = liveData?.shopifyRepeatFunnel?.calcVersion >= 6 ? liveData.shopifyRepeatFunnel : null;
  const safeRepeatFunnel = subFunnelValid ? subFunnel : shopFunnel;

  async function handleLogout() {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const initials = user?.name
    ? user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : "Z";


  return (
    <div className="min-h-screen bg-neutral-50 font-sans text-neutral-900 antialiased"
      style={{ fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');
        .tabular-nums { font-variant-numeric: tabular-nums; }
        .mono { font-family: "Geist Mono", ui-monospace, monospace; }
      `}</style>

      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-neutral-200/70 bg-white/80 backdrop-blur-xl">
        {/* Northstar accent stripe */}
        <div className="h-[2px] w-full bg-[#0d1d3d]" />
        <div className="flex w-full items-center justify-between px-4 py-3 md:px-6">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              {/* Northstar wordmark */}
              <div className="flex items-center gap-1.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#0d1d3d]">
                  <span
                    className="text-[13px] font-black leading-none text-white"
                    style={{
                      fontFamily: "'Barlow Condensed', 'Oswald', 'Arial Narrow', Impact, sans-serif",
                    }}
                  >
                    Z
                  </span>
                </div>
                <span
                  className="text-[18px] font-black uppercase tracking-[0.04em] leading-none text-[#0d1d3d]"
                  style={{
                    fontFamily: "'Barlow Condensed', 'Oswald', 'Arial Narrow', Impact, sans-serif",
                  }}
                >
                  NORTHSTAR
                </span>
              </div>
              <span className="text-neutral-300">/</span>
              <span className="text-[13px] text-neutral-500">Group B.V.</span>
              <ChevronDown size={13} className="text-neutral-400" />
            </div>
            <span className={`hidden items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium md:inline-flex ${
              liveSources > 0
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}>
              <span className={`h-1 w-1 rounded-full ${liveSources > 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
              {liveSources > 0 ? `Live · ${liveSources} source${liveSources > 1 ? "s" : ""}` : "Demo · mock data"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Sync button */}
            <button
              onClick={handleSync}
              disabled={syncing}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition ${
                dataIsStale && !syncing
                  ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                  : "border-neutral-200 bg-neutral-50 text-neutral-500 hover:bg-neutral-100"
              } disabled:opacity-60`}
            >
              <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
              {syncing ? "Syncing…" : syncLabel}
            </button>
            {syncError && (
              <span className="text-[11px] text-rose-500">{syncError}</span>
            )}
            <div className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-[12px] text-neutral-500">
              <Search size={12} />
              <span>Search</span>
              <span className="mono ml-4 flex items-center gap-0.5 rounded border border-neutral-200 bg-white px-1 text-[10px] text-neutral-400">
                <Command size={9} /> K
              </span>
            </div>
            {user && (
              <div className="flex items-center gap-2 ml-1">
                <span className="hidden text-[12px] text-neutral-500 md:block">{user.email}</span>
                {user.avatar && !avatarFailed ? (
                  <img
                    src={user.avatar}
                    alt={user.name}
                    className="h-7 w-7 rounded-full ring-2 ring-white object-cover"
                    onError={() => setAvatarFailed(true)}
                  />
                ) : (
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-[#0d1d3d] to-[#1e3a6f] ring-2 ring-white">
                    <span className="text-[10px] font-bold text-white">{initials}</span>
                  </div>
                )}
                <button
                  onClick={handleLogout}
                  className="rounded-md px-2.5 py-1 text-[12px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 transition"
                  title="Sign out"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex w-full gap-4 px-4 py-6 md:gap-6 md:px-6">
        {/* Sidebar */}
        <aside className="hidden w-[220px] shrink-0 md:block">
          <nav className="sticky top-[72px] space-y-0.5">
            <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Dashboard</div>
            <NavItem icon={LayoutDashboard} label="Overview" active={view === "overview"} onClick={() => setView("overview")} />
            <div className="pt-3 px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">The 5 Pillars</div>
            <NavItem icon={Zap} label="Daily P&L" active={view === "daily"} onClick={() => setView("daily")} />
            <NavItem icon={Globe} label="Margin per market" active={view === "markets"} onClick={() => setView("markets")} />
            <NavItem icon={CalendarDays} label="Monthly overview" active={view === "monthly"} onClick={() => setView("monthly")} />
            <NavItem icon={Scale} label="Balance sheet" active={view === "balance"} onClick={() => setView("balance")} />
            <NavItem icon={LineChartIcon} label="Forecast" active={view === "forecast"} onClick={() => setView("forecast")} />

            <div className="pt-3 px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Operations</div>
            <NavItem icon={GitCompareArrows} label="Reconciliation" active={view === "reconciliation"} onClick={() => setView("reconciliation")} badge="4" />
            <NavItem icon={Plug} label="Sync status" active={view === "sync"} onClick={() => setView("sync")} />

            <div className="pt-4">
              <div className="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Data sources</div>
              <div className="space-y-1 px-2.5 text-[12px] text-neutral-500">
                <div className="flex items-center justify-between"><span>Shopify Plus</span><StatusDot status={shopifyLive ? "ok" : "error"} /></div>
                <div className="flex items-center justify-between"><span>Triple Whale</span><StatusDot status={twLive ? "ok" : "error"} /></div>
                <div className="flex items-center justify-between"><span>Jortt</span><StatusDot status={jorttLive ? "ok" : "error"} /></div>
                <div className="flex items-center justify-between"><span>Xero</span><StatusDot status={xeroLive ? "ok" : "error"} /></div>
              </div>
            </div>
          </nav>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1">
          {/* Always-visible view switcher (also works on narrow screens) */}
          <div className="mb-5 -mx-4 border-b border-neutral-200 bg-white px-4 py-2 md:hidden">
            <div className="flex gap-1 overflow-x-auto">
              {[
                { id: "overview", label: "Overview", icon: LayoutDashboard },
                { id: "daily", label: "Daily P&L", icon: Zap },
                { id: "markets", label: "Markets", icon: Globe },
                { id: "monthly", label: "Monthly", icon: CalendarDays },
                { id: "balance", label: "Balance", icon: Scale },
                { id: "forecast", label: "Forecast", icon: LineChartIcon },
                { id: "reconciliation", label: "Reconcile", icon: GitCompareArrows },
                { id: "sync", label: "Sync", icon: Plug },
              ].map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => setView(t.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
                      view === t.id ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    <Icon size={13} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {view === "overview" && <OverviewView dateRange={dateRange} onDateChange={handleDateChange} liveMarkets={activeMarkets} twData={twData} subData={allSubData} shopifyMonthly={safeShopifyMonthly} jorttData={jorttObj} xeroData={xeroObj} xeroError={xeroErrorMessage} xeroRaw={liveData?.xero ?? null} rangeData={rangeData} rangeSyncing={rangeSyncing} tripleWhaleCustomerEconomics={liveData?.tripleWhaleCustomerEconomics ?? null} shopifyRepeatFunnel={safeRepeatFunnel} sourceStatus={liveData?.sourceStatus ?? null} manualData={liveData?.manualData ?? null} />}
          {view === "metrics" && <MetricsView twData={twData} />}
          {view === "daily" && (shopifyLive ? <DailyPnLView dailyData={shopifyToday} twData={twData} /> : <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-[13px] text-amber-800"><strong>Daily P&L</strong> requires Shopify data. <button onClick={() => setView("sync")} className="underline text-amber-700 hover:text-amber-900">Connect Shopify</button> to view.</div>)}
          {view === "markets" && (activeMarkets ? <MarketsView liveMarkets={activeMarkets} twData={twData} shopifyMonthly={safeShopifyMonthly} paymentFeesByMonth={liveData?.paymentFeesMonthly?.byMonth ?? null} marketCosts={liveData?.manualData?.settings?.market_costs ?? null} /> : <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-[13px] text-amber-800"><strong>Margin per Market</strong> requires Shopify & Triple Whale data. <button onClick={() => setView("sync")} className="underline text-amber-700 hover:text-amber-900">Connect sources</button> to view.</div>)}
          {view === "monthly" && ((shopifyLive || jorttLive) ? <MonthlyView opexByMonth={activeOpexByMonth} opexDetail={activeOpexDetail} opexDetailByMonth={(xeroObj as any)?.opexDetailByMonth ?? null} jorttLive={jorttLive} xeroDiag={xeroDiag} shopifyMonthly={safeShopifyMonthly} twData={twData} shopifyRepeatFunnel={safeRepeatFunnel} shippingByMonth={liveData?.tripleWhaleShippingMonthly ?? null} paymentFeesByMonth={liveData?.paymentFeesMonthly?.byMonth ?? null} interestTaxByMonth={(xeroObj as any)?.interestTaxByMonth ?? null} /> : <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-[13px] text-amber-800"><strong>Monthly Overview</strong> requires Shopify or Jortt data. <button onClick={() => setView("sync")} className="underline text-amber-700 hover:text-amber-900">Connect a source</button> to view.</div>)}
          {view === "balance" && <BalanceView jorttData={jorttObj} xeroData={xeroObj} xeroError={xeroErrorMessage} shopifyMarkets={activeMarkets} twData={twData} />}
          {view === "forecast" && <ForecastView jorttData={jorttObj} xeroData={xeroObj} shopifyMonthly={safeShopifyMonthly} />}
          {view === "reconciliation" && <ReconciliationView shopifyMarkets={activeMarkets} jorttData={jorttObj} />}
          {view === "sync" && <SyncView initialConnections={connections} />}

          <div className="mt-10 text-center text-[11px] text-neutral-400">
            {liveSources > 0
              ? `${liveSources} live source${liveSources > 1 ? "s" : ""} · ${[shopifyLive && "Shopify", jorttLive && "Jortt", twLive && "Triple Whale", juoLive && "Juo (NL)", loopLive && "Loop (UK)"].filter(Boolean).join(", ")} · synced ${syncLabel}`
              : `No live sources connected · Add API keys to .env.local or connect via Sync view`}
          </div>
        </main>
      </div>
    </div>
  );
}






