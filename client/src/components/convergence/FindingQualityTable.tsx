import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface FindingQualityRow {
  model_key: string;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
}

interface FindingQualityTableProps {
  data: FindingQualityRow[];
}

export function FindingQualityTable({ data }: FindingQualityTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Finding Quality (Precision/Recall vs Frontier)</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="pb-2">Model</th>
              <th className="pb-2">TP</th>
              <th className="pb-2">FP</th>
              <th className="pb-2">FN</th>
              <th className="pb-2">Precision</th>
              <th className="pb-2">Recall</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.model_key} className="border-b">
                <td className="py-2 font-mono">{row.model_key}</td>
                <td className="py-2">{row.true_positives}</td>
                <td className="py-2">{row.false_positives}</td>
                <td className="py-2">{row.false_negatives}</td>
                <td className="py-2">{(row.precision * 100).toFixed(1)}%</td>
                <td className="py-2">{(row.recall * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
