/**
 * LiveIndicator Component
 *
 * Visual indicator showing real-time WebSocket connection status.
 * Shows a pulsing green dot when connected, gray when disconnected.
 *
 * Part of OMN-1278: Contract-Driven Dashboard - Registry Discovery (Phase 4)
 */

import { cn } from '@/lib/utils';

export interface LiveIndicatorProps {
  /**
   * Whether the WebSocket is connected
   */
  isConnected: boolean;

  /**
   * Connection status for more detailed display
   */
  connectionStatus?: 'connecting' | 'connected' | 'disconnected' | 'error' | 'offline';

  /**
   * Optional label override
   */
  label?: string;

  /**
   * Size variant
   * @default 'default'
   */
  size?: 'sm' | 'default' | 'lg';

  /**
   * Whether to show the label
   * @default true
   */
  showLabel?: boolean;

  /**
   * Additional CSS classes
   */
  className?: string;
}

/**
 * LiveIndicator displays the real-time connection status with a pulsing dot.
 *
 * @example Basic usage
 * ```tsx
 * const { isConnected } = useRegistryWebSocket();
 * <LiveIndicator isConnected={isConnected} />
 * ```
 *
 * @example With connection status
 * ```tsx
 * const { isConnected, connectionStatus } = useRegistryWebSocket();
 * <LiveIndicator isConnected={isConnected} connectionStatus={connectionStatus} />
 * ```
 *
 * @example Custom styling
 * ```tsx
 * <LiveIndicator isConnected={true} size="lg" className="mx-2" />
 * ```
 */
export function LiveIndicator({
  isConnected,
  connectionStatus = isConnected ? 'connected' : 'disconnected',
  label,
  size = 'default',
  showLabel = true,
  className,
}: LiveIndicatorProps) {
  // Determine display text
  const getStatusLabel = (): string => {
    if (label) return label;

    switch (connectionStatus) {
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Live';
      case 'offline':
      case 'disconnected':
        return 'Offline';
      case 'error':
        return 'Error';
      default:
        return isConnected ? 'Live' : 'Offline';
    }
  };

  // Determine dot color and animation
  const getDotClasses = (): string => {
    const baseClasses = 'rounded-full';

    // Size classes
    const sizeClasses = {
      sm: 'w-1.5 h-1.5',
      default: 'w-2 h-2',
      lg: 'w-3 h-3',
    };

    // Status-based colors and animation
    let statusClasses: string;
    switch (connectionStatus) {
      case 'connecting':
        statusClasses = 'bg-yellow-500 animate-pulse';
        break;
      case 'connected':
        statusClasses = 'bg-green-500 animate-pulse';
        break;
      case 'error':
        statusClasses = 'bg-red-500';
        break;
      case 'offline':
      case 'disconnected':
      default:
        statusClasses = 'bg-gray-400';
    }

    return cn(baseClasses, sizeClasses[size], statusClasses);
  };

  // Text size based on component size
  const getTextClasses = (): string => {
    const sizeClasses = {
      sm: 'text-xs',
      default: 'text-sm',
      lg: 'text-base',
    };

    const statusClasses =
      connectionStatus === 'error'
        ? 'text-red-500'
        : connectionStatus === 'connecting'
          ? 'text-yellow-500'
          : 'text-muted-foreground';

    return cn(sizeClasses[size], statusClasses);
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className={getDotClasses()} />
      {showLabel && <span className={getTextClasses()}>{getStatusLabel()}</span>}
    </div>
  );
}

/**
 * Compact live indicator for tight spaces (just the dot with tooltip-like label)
 */
export function LiveIndicatorCompact({
  isConnected,
  connectionStatus = isConnected ? 'connected' : 'disconnected',
  className,
}: Pick<LiveIndicatorProps, 'isConnected' | 'connectionStatus' | 'className'>) {
  const getTitle = (): string => {
    switch (connectionStatus) {
      case 'connecting':
        return 'Connecting to real-time updates...';
      case 'connected':
        return 'Connected - Receiving live updates';
      case 'offline':
      case 'disconnected':
        return 'Disconnected - Updates paused';
      case 'error':
        return 'Connection error';
      default:
        return isConnected ? 'Connected' : 'Disconnected';
    }
  };

  const getDotClasses = (): string => {
    switch (connectionStatus) {
      case 'connecting':
        return 'w-2 h-2 rounded-full bg-yellow-500 animate-pulse';
      case 'connected':
        return 'w-2 h-2 rounded-full bg-green-500 animate-pulse';
      case 'error':
        return 'w-2 h-2 rounded-full bg-red-500';
      case 'offline':
      case 'disconnected':
      default:
        return 'w-2 h-2 rounded-full bg-gray-400';
    }
  };

  return (
    <div
      className={cn('inline-flex', className)}
      title={getTitle()}
      aria-label={getTitle()}
      role="status"
    >
      <div className={getDotClasses()} />
    </div>
  );
}

export default LiveIndicator;
