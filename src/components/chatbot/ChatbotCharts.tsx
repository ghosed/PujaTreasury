import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CategoryBreakdownItem,
  DynamicChartSpec,
  MonthlyTrendItem,
  SourceBreakdownItem,
} from '../../types/chatbot';
import { formatUsd } from '../../utils/chatbotAnalytics';

const CHART_PALETTE = [
  '#0f766e',
  '#334155',
  '#0284c7',
  '#d97706',
  '#475569',
  '#059669',
  '#6366f1',
  '#dc2626',
];

function formatMetricValue(val: unknown, mode: 'currency' | 'count'): string {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val ?? '');
  return mode === 'currency' ? formatUsd(num) : num.toLocaleString('en-US');
}

export const DynamicChartRenderer: React.FC<{ spec: DynamicChartSpec }> = ({ spec }) => {
  const { chartType, title, subtitle, xKey, valueKey, secondaryValueKey, valueFormat, data } =
    spec;

  if (!data || data.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5">
      <div className="mb-2.5">
        <h4 className="text-xs font-semibold text-slate-900">{title}</h4>
        {subtitle && <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>}
      </div>

      <div className="h-[230px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'pie' ? (
            <PieChart>
              <Pie
                data={data}
                dataKey={valueKey}
                nameKey={xKey}
                cx="50%"
                cy="50%"
                innerRadius={48}
                outerRadius={82}
                paddingAngle={2}
              >
                {data.map((_, idx) => (
                  <Cell key={idx} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(val) => formatMetricValue(val, valueFormat)}
                contentStyle={{
                  fontSize: '12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          ) : chartType === 'line' ? (
            <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: '#475569' }} />
              <YAxis
                tick={{ fontSize: 11, fill: '#475569' }}
                tickFormatter={(v) =>
                  valueFormat === 'currency' ? `$${Number(v).toLocaleString()}` : String(v)
                }
              />
              <Tooltip
                formatter={(val) => formatMetricValue(val, valueFormat)}
                contentStyle={{
                  fontSize: '12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              <Line
                type="monotone"
                dataKey={valueKey}
                stroke="#0f766e"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              {secondaryValueKey && (
                <Line
                  type="monotone"
                  dataKey={secondaryValueKey}
                  stroke="#334155"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              )}
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey={xKey}
                tick={{ fontSize: 11, fill: '#475569' }}
                interval={0}
                angle={data.length > 5 ? -20 : 0}
                textAnchor={data.length > 5 ? 'end' : 'middle'}
                height={data.length > 5 ? 48 : 28}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#475569' }}
                tickFormatter={(v) =>
                  valueFormat === 'currency' ? `$${Number(v).toLocaleString()}` : String(v)
                }
              />
              <Tooltip
                formatter={(val) => formatMetricValue(val, valueFormat)}
                contentStyle={{
                  fontSize: '12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              />
              {secondaryValueKey && <Legend wrapperStyle={{ fontSize: '11px' }} />}
              <Bar dataKey={valueKey} fill="#0f766e" radius={[4, 4, 0, 0]} />
              {secondaryValueKey && (
                <Bar dataKey={secondaryValueKey} fill="#d97706" radius={[4, 4, 0, 0]} />
              )}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export const CategoryBreakdownChart: React.FC<{
  items: CategoryBreakdownItem[];
  chartMode: 'bar' | 'pie';
  selectedCategory: string | null;
  onSelectCategory: (category: string) => void;
}> = ({ items, chartMode, selectedCategory, onSelectCategory }) => {
  const topItems = items.slice(0, 10);

  if (topItems.length === 0) {
    return (
      <div className="flex h-[250px] items-center justify-center text-xs text-slate-500">
        No expense categories match the active filters.
      </div>
    );
  }

  return (
    <div className="h-[265px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        {chartMode === 'pie' ? (
          <PieChart>
            <Pie
              data={topItems}
              dataKey="totalUsd"
              nameKey="category"
              cx="50%"
              cy="50%"
              innerRadius={56}
              outerRadius={92}
              paddingAngle={2}
              onClick={(_entry, index) => {
                const item = topItems[index];
                if (item?.category) onSelectCategory(item.category);
              }}
              className="cursor-pointer"
            >
              {topItems.map((item, idx) => (
                <Cell
                  key={item.category}
                  fill={CHART_PALETTE[idx % CHART_PALETTE.length]}
                  stroke={selectedCategory === item.category ? '#0f172a' : '#ffffff'}
                  strokeWidth={selectedCategory === item.category ? 2 : 1}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(val) => formatUsd(Number(val))}
              contentStyle={{
                fontSize: '12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '11px' }} />
          </PieChart>
        ) : (
          <BarChart
            data={topItems}
            layout="vertical"
            margin={{ top: 4, right: 18, left: 10, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: '#475569' }}
              tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
            />
            <YAxis
              type="category"
              dataKey="category"
              width={118}
              tick={{ fontSize: 11, fill: '#0f172a' }}
            />
            <Tooltip
              formatter={(val, name) => [
                formatUsd(Number(val)),
                name === 'paidUsd' ? 'Paid' : name === 'pendingUsd' ? 'Pending' : 'Total',
              ]}
              contentStyle={{
                fontSize: '12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '11px' }} />
            <Bar
              dataKey="paidUsd"
              name="Paid"
              stackId="a"
              fill="#0f766e"
              className="cursor-pointer"
              onClick={(_entry, index) => {
                const item = topItems[index];
                if (item?.category) onSelectCategory(item.category);
              }}
            />
            <Bar
              dataKey="pendingUsd"
              name="Pending"
              stackId="a"
              fill="#d97706"
              radius={[0, 4, 4, 0]}
              className="cursor-pointer"
              onClick={(_entry, index) => {
                const item = topItems[index];
                if (item?.category) onSelectCategory(item.category);
              }}
            />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
};

export const LedgerComparisonChart: React.FC<{
  ledgerSplit: Array<{
    ledger: string;
    expenseLedgerUsd: number;
    bankExpenseUsd: number;
    paidUsd: number;
    pendingUsd: number;
  }>;
}> = ({ ledgerSplit }) => {
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={ledgerSplit} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="ledger" tick={{ fontSize: 12, fill: '#0f172a' }} />
          <YAxis
            tick={{ fontSize: 11, fill: '#475569' }}
            tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
          />
          <Tooltip
            formatter={(val) => formatUsd(Number(val))}
            contentStyle={{
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Bar dataKey="paidUsd" name="Expense Paid" fill="#0f766e" radius={[4, 4, 0, 0]} />
          <Bar dataKey="pendingUsd" name="Expense Pending" fill="#d97706" radius={[4, 4, 0, 0]} />
          <Bar dataKey="bankExpenseUsd" name="Bank Debits" fill="#334155" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export const MonthlyTrendChart: React.FC<{ items: MonthlyTrendItem[] }> = ({ items }) => {
  if (items.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-xs text-slate-500">
        No dated transactions available for trend charting.
      </div>
    );
  }

  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={items} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#475569' }} />
          <YAxis
            tick={{ fontSize: 11, fill: '#475569' }}
            tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
          />
          <Tooltip
            formatter={(val) => formatUsd(Number(val))}
            contentStyle={{
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Line
            type="monotone"
            dataKey="expenseLedgerUsd"
            name="Expense Ledger"
            stroke="#0f766e"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="bankExpenseUsd"
            name="Bank Expenses"
            stroke="#334155"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export const SourceUnlinkedChart: React.FC<{
  items: SourceBreakdownItem[];
  onSelectSource: (source: string) => void;
}> = ({ items, onSelectSource }) => {
  const top = items.slice(0, 8);
  if (top.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-xs text-slate-500">
        All Bank expenses are linked to Expense Ledger.
      </div>
    );
  }

  return (
    <div className="h-[210px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: '#475569' }}
            tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
          />
          <YAxis
            type="category"
            dataKey="source"
            width={110}
            tick={{ fontSize: 11, fill: '#0f172a' }}
          />
          <Tooltip
            formatter={(val) => [formatUsd(Number(val)), 'Unlinked Bank Spend']}
            contentStyle={{
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          />
          <Bar
            dataKey="unlinkedUsd"
            fill="#d97706"
            radius={[0, 4, 4, 0]}
            className="cursor-pointer"
            onClick={(_entry, index) => {
              const item = top[index];
              if (item?.source) onSelectSource(item.source);
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
