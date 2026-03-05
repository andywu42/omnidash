import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <img
            src="/logo-inline.svg"
            alt="OmniNode"
            className="h-8 w-auto mx-auto dark:brightness-0 dark:invert"
          />
          <CardTitle className="text-xl">Sign in to OmniDash</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground text-center">
            Access the OmniNode analytics dashboard with your OmniNode account.
          </p>
          <Button
            className="w-full"
            size="lg"
            onClick={() => {
              window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
            }}
          >
            Sign in with OmniNode
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
