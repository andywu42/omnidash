import { useQuery } from '@tanstack/react-query';
import { getQueryFn } from '@/lib/queryClient';

interface AuthUser {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  realm_roles?: string[];
}

interface AuthResponse {
  authenticated: boolean;
  user: AuthUser | null;
}

export function useAuth() {
  const { data, isLoading } = useQuery<AuthResponse | null>({
    queryKey: ['/api/auth/me'],
    queryFn: getQueryFn({ on401: 'returnNull' }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return {
    user: data?.user ?? null,
    authenticated: data?.authenticated ?? false,
    isLoading,
  };
}
