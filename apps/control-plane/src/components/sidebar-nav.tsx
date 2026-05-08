'use client';

import { HealthBadge, type HealthState } from '@/components/health-badge';
import { useIntegrationsHealth } from '@/hooks/use-health';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  GitBranch,
  Globe,
  HelpCircle,
  Home,
  Package,
  Plug,
  Settings,
  Shield,
  Users,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItemDef {
  href: string;
  label: string;
  icon: React.ElementType;
  // resolveHealth: returns HealthState at runtime; undefined = no badge
  resolveHealth?: (ctx: HealthContext) => HealthState;
  // resolveTooltip: optional tooltip text
  resolveTooltip?: (ctx: HealthContext) => string | undefined;
}

interface HealthContext {
  integrationsState: HealthState;
  integrationsSummary?: string;
}

const navItems: NavItemDef[] = [
  { href: '/', label: 'Home', icon: Home },
  {
    href: '/launches',
    label: 'Lançamentos',
    icon: Zap,
    // Launch health endpoint not available yet — will be wired in a future wave
    resolveHealth: () => 'unknown',
    resolveTooltip: () => 'Dados de saúde de lançamentos indisponíveis',
  },
  {
    href: '/leads',
    label: 'Leads',
    icon: Users,
    resolveHealth: () => 'unknown',
    resolveTooltip: () => 'Dados de saúde de leads indisponíveis',
  },
  {
    href: '/products',
    label: 'Produtos',
    icon: Package,
  },
  {
    href: '/audiences',
    label: 'Audiences',
    icon: BarChart3,
    resolveHealth: () => 'unknown',
    resolveTooltip: () => 'Dados de saúde de audiences indisponíveis',
  },
  {
    href: '/orchestrator',
    label: 'Workflows',
    icon: GitBranch,
  },
  {
    href: '/integrations',
    label: 'Integrações',
    icon: Plug,
    resolveHealth: (ctx) => ctx.integrationsState,
    resolveTooltip: (ctx) => ctx.integrationsSummary,
  },
  {
    href: '/privacy/sar',
    label: 'Privacy',
    icon: Shield,
    resolveHealth: () => 'unknown',
    resolveTooltip: () => 'Dados de saúde de privacy indisponíveis',
  },
  { href: '/settings/workspace', label: 'Configurações', icon: Settings },
  { href: '/help/glossary', label: 'Ajuda', icon: HelpCircle },
];

export function SidebarNav() {
  const pathname = usePathname();

  // T-6-006: polling de saúde das integrações via SWR (refreshInterval: 60s)
  // docs/70-ux/07-component-health-badges.md §3
  const { state: integrationsState, summary: integrationsSummary } =
    useIntegrationsHealth();

  const healthCtx: HealthContext = {
    integrationsState,
    integrationsSummary,
  };

  return (
    <aside className="flex h-screen w-56 flex-col border-r bg-card">
      {/* Logo / Brand */}
      <div className="flex h-16 items-center gap-2 border-b px-4">
        <Globe className="h-5 w-5 text-primary" aria-hidden="true" />
        <span className="font-semibold text-sm">GlobalTracker</span>
      </div>

      {/* Nav items */}
      <nav
        className="flex-1 overflow-y-auto px-2 py-4"
        aria-label="Navegação principal"
      >
        <ul className="space-y-1">
          {navItems.map(
            ({ href, label, icon: Icon, resolveHealth, resolveTooltip }) => {
              const isActive =
                href === '/' ? pathname === '/' : pathname.startsWith(href);

              const healthState = resolveHealth?.(healthCtx);
              const tooltipText = resolveTooltip?.(healthCtx);

              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{label}</span>
                    {/* T-6-006: HealthBadge xs substituiu placeholder span */}
                    {healthState != null && (
                      <HealthBadge
                        state={healthState}
                        size="xs"
                        tooltip={tooltipText}
                        className="ml-auto"
                      />
                    )}
                  </Link>
                </li>
              );
            },
          )}
        </ul>
      </nav>
    </aside>
  );
}
