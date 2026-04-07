import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface CostSavingsData {
  total_frontier_tokens_saved: number;
  categories_at_threshold: string[];
  estimated_monthly_savings_usd: number;
  convergence_threshold: number;
}

interface CostSavingsCardProps {
  data: CostSavingsData;
}

export function CostSavingsCard({ data }: CostSavingsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Savings (Local Model Convergence)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="text-2xl font-bold">
            ${data.estimated_monthly_savings_usd.toFixed(2)}/mo
          </div>
          <div className="text-sm text-muted-foreground">estimated savings from frontier skip</div>
        </div>
        <div className="text-sm">
          <span className="font-medium">{data.total_frontier_tokens_saved.toLocaleString()}</span>{' '}
          frontier tokens displaced
        </div>
        <div className="text-sm">
          <span className="font-medium">{data.categories_at_threshold.length}</span> categories
          above F1 {'>='} {(data.convergence_threshold * 100).toFixed(0)}% threshold
        </div>
        {data.categories_at_threshold.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.categories_at_threshold.map((cat) => (
              <span key={cat} className="px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs">
                {cat}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
