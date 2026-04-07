import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ConvergenceData {
  model_key: string;
  overall_f1: number;
  by_category: Record<string, number>;
  sessions_evaluated: number;
  trend: 'improving' | 'stable' | 'declining';
}

interface ConvergenceChartProps {
  data: ConvergenceData[];
}

export function ConvergenceChart({ data }: ConvergenceChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Convergence (F1 vs Frontier)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {data.map((model) => (
            <div key={model.model_key} className="border rounded p-3">
              <div className="flex justify-between items-center mb-2">
                <span className="font-mono text-sm">{model.model_key}</span>
                <span className="text-sm">
                  F1: {(model.overall_f1 * 100).toFixed(1)}%
                  {model.trend === 'improving' && ' \u2191'}
                  {model.trend === 'declining' && ' \u2193'}
                  {model.trend === 'stable' && ' \u2192'}
                </span>
              </div>
              <div className="w-full bg-muted rounded h-2">
                <div
                  className="bg-primary rounded h-2 transition-all"
                  style={{ width: `${model.overall_f1 * 100}%` }}
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                {Object.entries(model.by_category).map(([cat, f1]) => (
                  <div key={cat}>
                    {cat}: {(f1 * 100).toFixed(0)}%
                  </div>
                ))}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {model.sessions_evaluated} sessions evaluated
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
