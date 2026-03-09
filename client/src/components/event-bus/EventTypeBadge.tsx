/**
 * Event Type Badge Component
 *
 * Displays event types with color coding by domain and status indicators.
 */

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Brain,
  Bot,
  Code,
  Database,
  Lock,
  Workflow,
  CheckCircle2,
  XCircle,
  Clock,
  PlayCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EventTypeBadgeProps {
  eventType: string;
  status?: 'completed' | 'failed' | 'started' | 'requested' | 'pending';
  onClick?: () => void;
  className?: string;
}

// Extract domain from event type (e.g., "omninode.intelligence.query.requested.v1" -> "intelligence")
function getDomain(eventType: string): string {
  const parts = eventType.split('.');
  if (parts.length >= 3 && parts[1] === 'omninode') {
    return parts[2];
  }
  if (parts.length >= 2 && parts[0] === 'omninode') {
    return parts[1];
  }
  return 'unknown';
}

// Get color scheme by domain
function getDomainColor(domain: string): string {
  const colors: Record<string, string> = {
    intelligence: 'bg-blue-500/10 text-blue-600 border-blue-500/20 hover:bg-blue-500/20',
    agent: 'bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20',
    code: 'bg-purple-500/10 text-purple-600 border-purple-500/20 hover:bg-purple-500/20',
    metadata: 'bg-orange-500/10 text-orange-600 border-orange-500/20 hover:bg-orange-500/20',
    database: 'bg-teal-500/10 text-teal-600 border-teal-500/20 hover:bg-teal-500/20',
    vault: 'bg-red-500/10 text-red-600 border-red-500/20 hover:bg-red-500/20',
    bridge: 'bg-pink-500/10 text-pink-600 border-pink-500/20 hover:bg-pink-500/20',
  };
  return colors[domain] || 'bg-gray-500/10 text-gray-600 border-gray-500/20 hover:bg-gray-500/20';
}

// Get icon by domain
function getDomainIcon(domain: string) {
  const icons: Record<string, typeof Brain> = {
    intelligence: Brain,
    agent: Bot,
    code: Code,
    metadata: Database,
    database: Database,
    vault: Lock,
    bridge: Workflow,
  };
  return icons[domain] || Code;
}

// Get status icon
function getStatusIcon(status?: string) {
  switch (status) {
    case 'completed':
      return CheckCircle2;
    case 'failed':
      return XCircle;
    case 'started':
      return PlayCircle;
    case 'requested':
    case 'pending':
      return Clock;
    default:
      return null;
  }
}

// Get status color
function getStatusColor(status?: string): string {
  switch (status) {
    case 'completed':
      return 'text-green-600';
    case 'failed':
      return 'text-red-600';
    case 'started':
      return 'text-blue-600';
    case 'requested':
    case 'pending':
      return 'text-yellow-600';
    default:
      return '';
  }
}

// Extract event description from event type
function getEventDescription(eventType: string): string {
  const parts = eventType.split('.');
  const action = parts[parts.length - 2] || 'event';
  const domain = getDomain(eventType);
  return `${domain} ${action}`;
}

export function EventTypeBadge({ eventType, status, onClick, className }: EventTypeBadgeProps) {
  const domain = getDomain(eventType);
  const domainColor = getDomainColor(domain);
  const DomainIcon = getDomainIcon(domain);
  const StatusIcon = getStatusIcon(status);
  const statusColor = getStatusColor(status);
  const description = getEventDescription(eventType);

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        'font-mono text-xs cursor-pointer transition-colors',
        domainColor,
        onClick && 'hover:scale-105',
        className
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5">
        <DomainIcon className="w-3 h-3" />
        <span className="truncate max-w-[200px]">{eventType}</span>
        {StatusIcon && <StatusIcon className={cn('w-3 h-3', statusColor)} />}
      </div>
    </Badge>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{description}</p>
          {onClick && (
            <p className="text-xs text-muted-foreground mt-1">Click to filter by this event type</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
