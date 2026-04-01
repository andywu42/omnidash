import { useDemoMode } from '@/contexts/DemoModeContext';
import { Button } from '@/components/ui/button';
import { Play, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Analytics } from '@/lib/analytics-events';

export function DemoModeToggle() {
  const { isDemoMode, toggleDemoMode } = useDemoMode();

  return (
    <Button
      variant={isDemoMode ? 'default' : 'outline'}
      size="sm"
      onClick={() => {
        toggleDemoMode();
        Analytics.demoModeToggled(!isDemoMode);
      }}
      className="relative"
    >
      {isDemoMode ? (
        <>
          <Square className="w-3 h-3 mr-2" />
          Demo Mode
        </>
      ) : (
        <>
          <Play className="w-3 h-3 mr-2" />
          Live Mode
        </>
      )}
      {isDemoMode && (
        <Badge variant="secondary" className="ml-2 text-xs">
          Demo Data
        </Badge>
      )}
    </Button>
  );
}
