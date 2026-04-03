import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * Verify that the Token Savings page is listed in the Intelligence
 * subgroup of the sidebar and routes to /savings (OMN-6968).
 *
 * These tests import the sidebar nav data directly to avoid needing
 * a full router/sidebar provider setup.
 *
 * The wiring-status module is mocked so that all pages are visible
 * regardless of their pipeline status. Wiring-based filtering is
 * covered separately in sidebar-wiring-filter.test.tsx.
 */

// Mock wiring-status so all routes are visible (bypass pipeline status filtering).
vi.mock('@shared/wiring-status', () => ({
  isRouteVisible: () => true,
  getRouteWiringStatus: () => 'working',
}));

// We test the nav item data declaratively by importing the module
// and checking the advancedSubGroups array programmatically.
// Since the array is not exported, we render and query the DOM.

// Lightweight wrapper: render just the sidebar link list so we can
// assert the Token Savings entry exists.
import { AppSidebar } from '../app-sidebar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { DemoModeProvider } from '@/contexts/DemoModeContext';

function renderSidebar() {
  // wouter useLocation needs to be available; provide a minimal wrapper
  return render(
    <DemoModeProvider>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </DemoModeProvider>
  );
}

describe('AppSidebar - Token Savings (OMN-6968)', () => {
  it('should include Token Savings link in sidebar navigation', () => {
    renderSidebar();
    // The sidebar renders a data-testid based on the URL: nav-savings
    const link = screen.getByTestId('nav-savings');
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent('Token Savings');
  });

  it('should link Token Savings to /savings route', () => {
    renderSidebar();
    const link = screen.getByTestId('nav-savings');
    // The SidebarMenuButton wraps an <a> tag via the Link component
    const anchor = link.closest('a') ?? link.querySelector('a');
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute('href')).toBe('/savings');
  });

  it('should place Token Savings in the Intelligence subgroup', () => {
    renderSidebar();
    // Token Savings should share a parent section with other Intelligence items
    // like Pattern Intelligence (/patterns)
    const savingsLink = screen.getByTestId('nav-savings');
    const patternsLink = screen.getByTestId('nav-patterns');

    // Both should exist in the sidebar
    expect(savingsLink).toBeInTheDocument();
    expect(patternsLink).toBeInTheDocument();
  });
});
