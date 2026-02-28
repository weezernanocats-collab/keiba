'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  addMonths,
  subMonths,
  isSameMonth,
  isSameDay,
  isToday,
  parseISO,
} from 'date-fns';
import GradeBadge from '@/components/GradeBadge';
import LoadingSpinner from '@/components/LoadingSpinner';

// ---------- Types ----------

interface RaceRow {
  id: string;
  name: string;
  date: string;
  racecourseName: string;
  raceNumber: number;
  grade: string | null;
  trackType: string;
  distance: number;
  status: string;
  entryCount: number;
}

// ---------- Constants ----------

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

const MONTH_LABELS = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
] as const;

// ---------- Helpers ----------

/** Build a lookup: "YYYY-MM-DD" -> RaceRow[] */
function groupRacesByDate(races: RaceRow[]): Record<string, RaceRow[]> {
  const map: Record<string, RaceRow[]> = {};
  for (const race of races) {
    if (!map[race.date]) map[race.date] = [];
    map[race.date].push(race);
  }
  return map;
}

function isGradeRace(grade: string | null): boolean {
  return grade === 'G1' || grade === 'G2' || grade === 'G3';
}

function gradeOrder(grade: string | null): number {
  if (grade === 'G1') return 0;
  if (grade === 'G2') return 1;
  if (grade === 'G3') return 2;
  return 3;
}

// ---------- Component ----------

export default function CalendarPage() {
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  const [races, setRaces] = useState<RaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Fetch races for the visible calendar range
  useEffect(() => {
    async function fetchRaces() {
      setLoading(true);
      try {
        const monthStart = startOfMonth(currentMonth);
        const monthEnd = endOfMonth(currentMonth);
        // Extend to cover the full calendar grid (may include days from adjacent months)
        const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
        const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });

        const startDate = format(calStart, 'yyyy-MM-dd');
        const endDate = format(calEnd, 'yyyy-MM-dd');

        const res = await fetch(`/api/races?startDate=${startDate}&endDate=${endDate}`);
        const data = await res.json();
        setRaces(data.races || []);
      } catch (err) {
        console.error('レース取得エラー:', err);
        setRaces([]);
      } finally {
        setLoading(false);
      }
    }
    fetchRaces();
  }, [currentMonth]);

  // Group races by date string
  const racesByDate = useMemo(() => groupRacesByDate(races), [races]);

  // Calendar grid days
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
    return eachDayOfInterval({ start: calStart, end: calEnd });
  }, [currentMonth]);

  // Races for the selected date
  const selectedDateRaces = useMemo(() => {
    if (!selectedDate) return [];
    return (racesByDate[selectedDate] || []).sort(
      (a, b) => a.racecourseName.localeCompare(b.racecourseName) || a.raceNumber - b.raceNumber,
    );
  }, [selectedDate, racesByDate]);

  // Important graded races this month (G1/G2/G3)
  const importantRaces = useMemo(() => {
    return races
      .filter((r) => isGradeRace(r.grade))
      .sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        if (dateCmp !== 0) return dateCmp;
        return gradeOrder(a.grade) - gradeOrder(b.grade);
      });
  }, [races]);

  // Navigation handlers
  const goToPrevMonth = useCallback(() => {
    setCurrentMonth((m) => subMonths(m, 1));
    setSelectedDate(null);
  }, []);

  const goToNextMonth = useCallback(() => {
    setCurrentMonth((m) => addMonths(m, 1));
    setSelectedDate(null);
  }, []);

  const goToToday = useCallback(() => {
    setCurrentMonth(new Date());
    setSelectedDate(format(new Date(), 'yyyy-MM-dd'));
  }, []);

  const handleDateClick = useCallback((dateStr: string) => {
    setSelectedDate((prev) => (prev === dateStr ? null : dateStr));
  }, []);

  // ---------- Render helpers ----------

  function renderDayCell(day: Date) {
    const dateStr = format(day, 'yyyy-MM-dd');
    const dayRaces = racesByDate[dateStr] || [];
    const raceCount = dayRaces.length;
    const inCurrentMonth = isSameMonth(day, currentMonth);
    const today = isToday(day);
    const isSelected = selectedDate === dateStr;
    const hasGrade = dayRaces.some((r) => isGradeRace(r.grade));
    const dayOfWeek = day.getDay(); // 0=Sun, 6=Sat

    // Build cell classes
    let cellClasses =
      'relative p-1 sm:p-2 min-h-[3rem] sm:min-h-[4.5rem] rounded-lg cursor-pointer transition-all duration-150 border';

    if (!inCurrentMonth) {
      cellClasses += ' opacity-30 border-transparent';
    } else if (isSelected) {
      cellClasses += ' bg-blue-600/20 border-blue-500 ring-1 ring-blue-500/50';
    } else if (raceCount > 0) {
      cellClasses += ' bg-green-900/20 border-green-700/30 hover:bg-green-900/30';
    } else {
      cellClasses += ' border-transparent hover:bg-card-bg';
    }

    // Day number classes
    let numberClasses = 'text-sm sm:text-base font-medium';
    if (today) {
      numberClasses += ' font-bold';
    }
    if (!inCurrentMonth) {
      numberClasses += ' text-muted';
    } else if (dayOfWeek === 0) {
      numberClasses += ' text-red-400';
    } else if (dayOfWeek === 6) {
      numberClasses += ' text-blue-400';
    }

    return (
      <div
        key={dateStr}
        className={cellClasses}
        onClick={() => inCurrentMonth && handleDateClick(dateStr)}
        role="button"
        tabIndex={inCurrentMonth ? 0 : -1}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (inCurrentMonth) handleDateClick(dateStr);
          }
        }}
      >
        {/* Today indicator */}
        {today && (
          <span className="absolute top-0.5 right-0.5 sm:top-1 sm:right-1 w-2 h-2 rounded-full bg-accent" />
        )}

        <span className={numberClasses}>{format(day, 'd')}</span>

        {raceCount > 0 && inCurrentMonth && (
          <div className="mt-0.5 sm:mt-1">
            <span className="inline-block text-[10px] sm:text-xs bg-green-600/80 text-white px-1 sm:px-1.5 py-0.5 rounded font-medium">
              {raceCount}R
            </span>
            {hasGrade && (
              <span className="ml-0.5 inline-block text-[10px] sm:text-xs px-1 py-0.5 rounded grade-g1">
                G
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---------- Main render ----------

  const year = currentMonth.getFullYear();
  const monthIndex = currentMonth.getMonth();

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">
          レースカレンダー
        </h1>
        <button
          onClick={goToToday}
          className="text-sm px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors font-medium"
        >
          今日
        </button>
      </div>

      {/* Calendar + Sidebar layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Calendar main area */}
        <div className="flex-1 min-w-0">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-4 bg-card-bg border border-card-border rounded-xl px-4 py-3">
            <button
              onClick={goToPrevMonth}
              className="p-2 rounded-lg hover:bg-primary/20 transition-colors"
              aria-label="前月"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-xl font-bold tracking-wide">
              {year}年 {MONTH_LABELS[monthIndex]}
            </h2>
            <button
              onClick={goToNextMonth}
              className="p-2 rounded-lg hover:bg-primary/20 transition-colors"
              aria-label="翌月"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Calendar grid */}
          <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
            {/* Day-of-week header */}
            <div className="grid grid-cols-7 border-b border-card-border">
              {DAY_LABELS.map((label, i) => (
                <div
                  key={label}
                  className={`text-center py-2 text-xs sm:text-sm font-bold ${
                    i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-muted'
                  }`}
                >
                  {label}
                </div>
              ))}
            </div>

            {/* Day cells */}
            {loading ? (
              <div className="py-12">
                <LoadingSpinner message="レースデータを読み込み中..." />
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-px bg-card-border/30 p-1 sm:p-2">
                {calendarDays.map((day) => renderDayCell(day))}
              </div>
            )}
          </div>

          {/* Selected-date race list */}
          {selectedDate && (
            <div className="mt-6 animate-fadeIn">
              <h3 className="text-lg font-bold mb-3 flex items-center gap-2">
                <span className="bg-primary text-white px-3 py-1 rounded-lg text-sm">
                  {selectedDate}
                </span>
                <span className="text-muted text-sm">
                  {selectedDateRaces.length > 0
                    ? `${selectedDateRaces.length}レース`
                    : 'レースなし'}
                </span>
              </h3>

              {selectedDateRaces.length > 0 ? (
                <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-gray-800/50">
                        <tr>
                          <th className="px-4 py-3 text-left font-medium">競馬場</th>
                          <th className="px-4 py-3 text-left font-medium">R</th>
                          <th className="px-4 py-3 text-left font-medium">レース名</th>
                          <th className="px-4 py-3 text-left font-medium">条件</th>
                          <th className="px-4 py-3 text-center font-medium">頭数</th>
                          <th className="px-4 py-3 text-center font-medium">状態</th>
                          <th className="px-4 py-3 text-center font-medium">詳細</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-card-border">
                        {selectedDateRaces.map((race) => (
                          <tr
                            key={race.id}
                            className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                          >
                            <td className="px-4 py-3 font-medium">{race.racecourseName}</td>
                            <td className="px-4 py-3">{race.raceNumber}R</td>
                            <td className="px-4 py-3">
                              <Link
                                href={`/races/${race.id}`}
                                className="text-accent hover:underline font-medium"
                              >
                                {race.name}
                              </Link>{' '}
                              <GradeBadge grade={race.grade} size="sm" />
                            </td>
                            <td className="px-4 py-3 text-muted">
                              {race.trackType}
                              {race.distance}m
                            </td>
                            <td className="px-4 py-3 text-center">{race.entryCount}頭</td>
                            <td className="px-4 py-3 text-center">
                              <span
                                className={`px-2 py-0.5 rounded text-xs font-medium ${
                                  race.status === '出走確定'
                                    ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                                    : race.status === '結果確定'
                                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                                      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                                }`}
                              >
                                {race.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <Link
                                href={`/races/${race.id}`}
                                className="text-accent hover:underline text-xs"
                              >
                                出馬表
                              </Link>
                              {race.status !== '結果確定' && (
                                <>
                                  {' / '}
                                  <Link
                                    href={`/predictions/${race.id}`}
                                    className="text-accent hover:underline text-xs"
                                  >
                                    予想
                                  </Link>
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="bg-card-bg border border-card-border rounded-xl p-8 text-center text-muted">
                  この日はレースがありません
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar: Important graded races */}
        <div className="w-full lg:w-80 flex-shrink-0">
          <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden lg:sticky lg:top-20">
            <div className="px-4 py-3 border-b border-card-border bg-primary/10">
              <h3 className="font-bold text-sm">重賞レース</h3>
              <p className="text-xs text-muted mt-0.5">
                {year}年{MONTH_LABELS[monthIndex]}の重賞
              </p>
            </div>

            {loading ? (
              <div className="p-4">
                <LoadingSpinner />
              </div>
            ) : importantRaces.length > 0 ? (
              <ul className="divide-y divide-card-border">
                {importantRaces.map((race) => (
                  <li key={race.id} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                    <div className="flex items-start gap-2">
                      <GradeBadge grade={race.grade} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/races/${race.id}`}
                          className="text-accent hover:underline font-medium text-sm block truncate"
                        >
                          {race.name}
                        </Link>
                        <p className="text-xs text-muted mt-0.5">
                          {race.date} / {race.racecourseName} / {race.trackType}
                          {race.distance}m
                        </p>
                      </div>
                    </div>
                    <div className="mt-1.5 flex gap-2">
                      <Link
                        href={`/races/${race.id}`}
                        className="text-[11px] text-accent hover:underline"
                      >
                        出馬表
                      </Link>
                      {race.status !== '結果確定' && (
                        <Link
                          href={`/predictions/${race.id}`}
                          className="text-[11px] text-accent hover:underline"
                        >
                          AI予想
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-6 text-center text-muted text-sm">
                この月に重賞レースはありません
              </div>
            )}
          </div>

          {/* Month summary stats */}
          {!loading && (
            <div className="mt-4 bg-card-bg border border-card-border rounded-xl p-4">
              <h4 className="font-bold text-sm mb-3">月間サマリー</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-2 rounded-lg bg-green-900/20 border border-green-700/30">
                  <div className="text-lg font-bold text-green-400">
                    {Object.keys(racesByDate).filter((d) => {
                      const parsed = parseISO(d);
                      return isSameMonth(parsed, currentMonth);
                    }).length}
                  </div>
                  <div className="text-xs text-muted">開催日</div>
                </div>
                <div className="text-center p-2 rounded-lg bg-blue-900/20 border border-blue-700/30">
                  <div className="text-lg font-bold text-blue-400">
                    {races.filter((r) => {
                      const parsed = parseISO(r.date);
                      return isSameMonth(parsed, currentMonth);
                    }).length}
                  </div>
                  <div className="text-xs text-muted">総レース数</div>
                </div>
                <div className="text-center p-2 rounded-lg bg-yellow-900/20 border border-yellow-700/30">
                  <div className="text-lg font-bold text-yellow-400">
                    {importantRaces.length}
                  </div>
                  <div className="text-xs text-muted">重賞</div>
                </div>
                <div className="text-center p-2 rounded-lg bg-purple-900/20 border border-purple-700/30">
                  <div className="text-lg font-bold text-purple-400">
                    {[...new Set(
                      races
                        .filter((r) => isSameMonth(parseISO(r.date), currentMonth))
                        .map((r) => r.racecourseName),
                    )].length}
                  </div>
                  <div className="text-xs text-muted">競馬場</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
